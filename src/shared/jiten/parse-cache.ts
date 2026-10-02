import { IndexedDbContentStorage } from './parse-cache-storage';
import {
  ContentStorage,
  ParagraphContent,
  VocabularyState,
  WordReference,
  vocabularyKey,
} from './parse-cache.types';
import type { JitenParseResult, JitenRawVocabulary } from './types';

type Loader = (paragraphs: string[]) => Promise<JitenParseResult>;
type StateLoader = (words: WordReference[]) => Promise<VocabularyState[]>;
type Options = { stateScope: string; refreshStates: StateLoader };
type StateEntry = VocabularyState & { updatedAt: number };
const STATE_TTL_MS = 5 * 60_000;
const MAX_MEMORY_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 2000;

// Stable tokenization/definitions and mutable account state have separate lifetimes.
// Content never expires by time; a parser/server namespace change or LRU can miss.
export class ParseCache {
  private entries = new Map<string, { value: ParagraphContent; bytes: number }>();
  private bytes = 0;
  private pending = new Map<string, Promise<ParagraphContent>>();
  private states = new Map<string, StateEntry>();
  private stateRequests = new Map<string, Promise<void>>();
  private generation = 0;
  private stateGeneration = 0;
  private writes = Promise.resolve();

  constructor(
    private storage?: ContentStorage,
    private now = Date.now,
    private maxBytes = MAX_MEMORY_BYTES,
    private maxEntries = MAX_ENTRIES,
  ) {}

  /** Explicit force-reparse only. Reviews must never delete content. */
  public async clear(): Promise<void> {
    this.generation++;
    this.entries.clear();
    this.bytes = 0;
    this.pending.clear();
    this.invalidateStates();
    this.writes = this.writes
      .catch(() => undefined)
      .then(() => this.storage?.clear())
      .then(() => undefined);
    await this.writes;
  }

  public invalidateStates(words?: WordReference[]): void {
    this.stateGeneration++;
    this.stateRequests.clear();

    if (!words) {
      this.states.clear();

      return;
    }
    const affected = new Set(words.map(vocabularyKey));

    for (const key of this.states.keys()) {
      if (affected.has((JSON.parse(key) as [string, string])[1])) {
        this.states.delete(key);
      }
    }
  }

  public updateState(scope: string, word: WordReference, value: VocabularyState): void {
    this.stateGeneration++;
    this.setState(scope, word, value);
  }

  public async parse(
    scope: string,
    texts: string[],
    loader: Loader,
    options?: Options,
  ): Promise<JitenParseResult> {
    const generation = this.generation;
    const stateScope = options?.stateScope ?? scope;
    const keys = texts.map((text) => JSON.stringify([scope, text]));
    let restored = new Map<string, ParagraphContent>();

    if (this.storage) {
      try {
        await this.writes;
        const missing = [
          ...new Set(keys.filter((key) => !this.entries.has(key) && !this.pending.has(key))),
        ];
        const saved = missing.length
          ? await this.storage.load(missing)
          : new Map<string, ParagraphContent>();

        if (generation === this.generation) {
          restored = saved;
          saved.forEach((value, key) => this.remember(key, value));
        }
      } catch {
        /* Private-mode/quota failures must not prevent reading. */
      }
    }
    const missing = new Map<string, string>();
    const waiting = keys.map((key, i) => {
      const cached = this.entries.get(key);

      if (cached) {
        this.entries.delete(key);
        this.entries.set(key, cached);

        return Promise.resolve(cached.value);
      }
      const pending = this.pending.get(key);

      if (pending) {
        return pending;
      }
      const saved = restored.get(key);

      if (saved) {
        return Promise.resolve(saved);
      }
      missing.set(key, texts[i]);

      return key;
    });

    if (missing.size) {
      const missingKeys = [...missing.keys()];
      const stateGeneration = this.stateGeneration;
      const result = Promise.resolve().then(() => loader([...missing.values()]));
      const contents = result.then(({ tokens, vocabulary }) => {
        if (tokens.length !== missingKeys.length) {
          throw new Error('Unexpected paragraph count in Jiten response');
        }
        const words = new Map(vocabulary.map((word) => [vocabularyKey(word), word]));
        const paragraphs = tokens.map((group) => ({
          tokens: group,
          vocabulary: [...new Set(group.map(vocabularyKey))].map((key) => {
            const word = words.get(key);

            if (!word) {
              throw new Error('Missing vocabulary in Jiten response');
            }
            const { knownState, studyDeckIds, ...definition } = word;

            if (stateGeneration === this.stateGeneration) {
              this.setState(stateScope, word, { knownState, studyDeckIds: studyDeckIds ?? [] });
            }

            return definition;
          }),
        }));

        if (generation === this.generation) {
          const changed = new Map<string, ParagraphContent>();

          missingKeys.forEach((key, i) => {
            this.remember(key, paragraphs[i]);
            changed.set(key, paragraphs[i]);
          });
          this.persist(changed);
        }

        return paragraphs;
      });

      missingKeys.forEach((key, i) => {
        const promise = contents.then((paragraphs) => paragraphs[i]);

        this.pending.set(key, promise);
        void promise.then(
          () => this.release(key, promise),
          () => this.release(key, promise),
        );
      });
    }
    const paragraphs = await Promise.all(
      waiting.map((value) => (typeof value === 'string' ? this.pending.get(value)! : value)),
    );
    const definitions = new Map(
      paragraphs.flatMap((p) => p.vocabulary.map((word) => [vocabularyKey(word), word] as const)),
    );

    if (options) {
      await this.refreshStates(stateScope, [...definitions.values()], options.refreshStates);
    }
    const vocabulary: JitenRawVocabulary[] = [...definitions].map(([key, definition]) => {
      const state = this.states.get(JSON.stringify([stateScope, key]));

      return {
        ...definition,
        knownState: state?.knownState ?? [0],
        studyDeckIds: state?.studyDeckIds ?? [],
      };
    });

    return structuredClone({ tokens: paragraphs.map((p) => p.tokens), vocabulary });
  }

  private setState(scope: string, word: WordReference, value: VocabularyState): void {
    const key = JSON.stringify([scope, vocabularyKey(word)]);

    this.states.delete(key);
    this.states.set(key, { ...structuredClone(value), updatedAt: this.now() });

    if (this.states.size > 20_000) {
      const [oldest] = this.states.keys();

      this.states.delete(oldest);
    }
  }

  private async refreshStates(
    scope: string,
    words: WordReference[],
    loader: StateLoader,
  ): Promise<void> {
    const stale = words.filter((word) => {
      const state = this.states.get(JSON.stringify([scope, vocabularyKey(word)]));

      return !state || this.now() - state.updatedAt >= STATE_TTL_MS;
    });

    if (!stale.length) {
      return;
    }
    const key = JSON.stringify([scope, stale.map(vocabularyKey).sort()]);
    const existing = this.stateRequests.get(key);

    if (existing) {
      await existing;

      return this.refreshStates(scope, words, loader);
    }
    const generation = this.stateGeneration;
    const request = loader(stale).then((states) => {
      if (states.length !== stale.length) {
        throw new Error('Unexpected vocabulary state count');
      }

      if (generation === this.stateGeneration) {
        stale.forEach((word, i) => this.setState(scope, word, states[i]));
      }
    });

    this.stateRequests.set(key, request);

    try {
      await request;
    } finally {
      if (this.stateRequests.get(key) === request) {
        this.stateRequests.delete(key);
      }
    }

    // Never overwrite a newer review/broadcast with a late lookup response.
    if (generation !== this.stateGeneration) {
      await this.refreshStates(scope, words, loader);
    }
  }

  private release(key: string, promise: Promise<ParagraphContent>): void {
    if (this.pending.get(key) === promise) {
      this.pending.delete(key);
    }
  }

  private remember(key: string, value: ParagraphContent): void {
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
    const bytes = new TextEncoder().encode(JSON.stringify([key, value])).length;

    this.entries.set(key, { value, bytes });
    this.bytes += bytes;

    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [oldest] = this.entries.keys();

      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }

  private persist(changed: Map<string, ParagraphContent>): void {
    this.writes = this.writes
      .then(() => this.storage?.save(changed))
      .then(() => undefined)
      .catch(() => undefined);
  }
}

export const parseCache = new ParseCache(new IndexedDbContentStorage());
