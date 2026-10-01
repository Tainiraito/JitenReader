import type { JitenParseResult, JitenRawVocabulary, JitenToken } from './types';

type Paragraph = { tokens: JitenToken[]; vocabulary: JitenRawVocabulary[] };
type Entry = { value: Paragraph; expiresAt: number };
type Snapshot = {
  version: 1;
  entries: [string, { tokens: JitenToken[]; words: string[]; expiresAt: number }][];
  vocabulary: [string, JitenRawVocabulary][];
};
type Storage = { load: () => Promise<unknown>; save: (snapshot: Snapshot) => Promise<void> };
type Loader = (paragraphs: string[]) => Promise<JitenParseResult>;

const TTL_MS = 30 * 60_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 2000;

// Cache raw API results, never DOM nodes. Tokens keep their exact text offsets.
// Snapshot vocabulary is deduplicated so repeated words don't fill session storage.
export class ParseCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<Paragraph>>();
  private generation = 0;
  private ready?: Promise<void>;
  private writes = Promise.resolve();

  constructor(
    private storage?: Storage,
    private now = Date.now,
    private maxBytes = MAX_BYTES,
    private maxEntries = MAX_ENTRIES,
  ) {}

  public clear(): void {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
    this.persist();
  }

  public async parse(scope: string, texts: string[], loader: Loader): Promise<JitenParseResult> {
    await this.initialize();
    const generation = this.generation;
    const missing = new Map<string, string>();
    const waiting = texts.map((text) => {
      const key = JSON.stringify([scope, text]);
      const cached = this.entries.get(key);

      if (cached && cached.expiresAt > this.now()) {
        this.entries.delete(key);
        this.entries.set(key, cached);

        return Promise.resolve(cached.value);
      }

      this.entries.delete(key);
      const pending = this.pending.get(key);

      if (pending) {
        return pending;
      }

      missing.set(key, text);

      // Actual pending promises are installed below before calling the loader.
      return key;
    });

    if (missing.size) {
      const keys = [...missing.keys()];
      const request = Promise.resolve().then(() => loader([...missing.values()]));
      const results = request.then(({ tokens, vocabulary }) => {
        if (tokens.length !== keys.length) {
          throw new Error('Unexpected paragraph count in Jiten response');
        }

        const words = new Map(vocabulary.map((word) => [this.wordKey(word), word]));
        const paragraphs = tokens.map((group) => {
          const used = [...new Set(group.map((token) => this.wordKey(token)))];
          const vocabulary = used.map((key) => {
            const word = words.get(key);

            if (!word) {
              throw new Error('Missing vocabulary in Jiten response');
            }

            return word;
          });

          return { tokens: group, vocabulary };
        });

        if (generation === this.generation) {
          keys.forEach((key, i) => {
            this.entries.set(key, { value: paragraphs[i], expiresAt: this.now() + TTL_MS });
          });
          this.prune();
          this.persist();
        }

        return paragraphs;
      });

      keys.forEach((key, i) => {
        const promise = results.then((paragraphs) => paragraphs[i]);

        this.pending.set(key, promise);
        // Both success and failure release the pending slot. Failures are never cached.
        void promise.then(
          () => this.release(key, promise),
          () => this.release(key, promise),
        );
      });
    }

    const paragraphs = await Promise.all(
      waiting.map((value) => (typeof value === 'string' ? this.pending.get(value)! : value)),
    );
    const vocabulary = new Map<string, JitenRawVocabulary>();

    for (const paragraph of paragraphs) {
      paragraph.vocabulary.forEach((word) => vocabulary.set(this.wordKey(word), word));
    }

    // Parser decorates tokens with cards, rubies and sentences; don't mutate cached results.
    return structuredClone({
      tokens: paragraphs.map((p) => p.tokens),
      vocabulary: [...vocabulary.values()],
    });
  }

  private wordKey(word: { wordId: number; readingIndex: number }): string {
    return `${word.wordId}:${word.readingIndex}`;
  }

  private release(key: string, promise: Promise<Paragraph>): void {
    if (this.pending.get(key) === promise) {
      this.pending.delete(key);
    }
  }

  private initialize(): Promise<void> {
    return (this.ready ??= (async (): Promise<void> => {
      const generation = this.generation;

      try {
        await this.writes;
        const snapshot = (await this.storage?.load()) as Snapshot | undefined;

        if (generation !== this.generation || snapshot?.version !== 1) {
          return;
        }

        const vocabulary = new Map(snapshot.vocabulary);
        const entries = new Map<string, Entry>();

        for (const [key, entry] of snapshot.entries) {
          if (entry.expiresAt <= this.now()) {
            continue;
          }

          const words = entry.words.map((key) => vocabulary.get(key));

          if (words.every((word) => word !== undefined)) {
            entries.set(key, {
              expiresAt: entry.expiresAt,
              value: { tokens: entry.tokens, vocabulary: words },
            });
          }
        }

        this.entries = entries;
        this.prune();
      } catch {
        // Session storage is optional: read/quota failures must not stop online parsing.
      }
    })());
  }

  private snapshot(): Snapshot {
    const vocabulary = new Map<string, JitenRawVocabulary>();
    const entries: Snapshot['entries'] = [];

    for (const [key, { value, expiresAt }] of this.entries) {
      const scope = (JSON.parse(key) as [string, string])[0];
      const words = value.vocabulary.map((word) => {
        const wordKey = JSON.stringify([scope, this.wordKey(word)]);

        vocabulary.set(wordKey, word);

        return wordKey;
      });

      entries.push([key, { tokens: value.tokens, words, expiresAt }]);
    }

    return { version: 1, entries, vocabulary: [...vocabulary] };
  }

  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) {
        this.entries.delete(key);
      }
    }

    while (this.entries.size > this.maxEntries) {
      const [oldest] = this.entries.keys();

      this.entries.delete(oldest);
    }

    while (
      this.entries.size &&
      new TextEncoder().encode(JSON.stringify(this.snapshot())).length > this.maxBytes
    ) {
      // Remove an LRU chunk to avoid serializing once for every evicted paragraph.
      const count = Math.max(1, Math.ceil(this.entries.size / 10));

      for (let i = 0; i < count; i++) {
        const [oldest] = this.entries.keys();

        this.entries.delete(oldest);
      }
    }
  }

  private persist(): void {
    const snapshot = this.snapshot();

    this.writes = this.writes
      .then(() => this.storage?.save(snapshot))
      .then(() => undefined)
      .catch(() => undefined);
  }
}

const STORAGE_KEY = 'jiten-parse-cache-v1';

export const parseCache = new ParseCache({
  load: async (): Promise<unknown> => (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY],
  save: (snapshot): Promise<void> => chrome.storage.session.set({ [STORAGE_KEY]: snapshot }),
});
