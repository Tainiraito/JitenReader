import {
  ContentStorage,
  ParagraphContent,
  StaticVocabulary,
  vocabularyKey,
} from './parse-cache.types';

type ParagraphRecord = {
  key: string;
  tokens: ParagraphContent['tokens'];
  words: string[];
  lastAccess: number;
  bytes: number;
};
type WordRecord = { key: string; value: StaticVocabulary; references: number; bytes: number };
const DATABASE = 'jiten-parser-content-v2';
const MAX_DISK_BYTES = 64 * 1024 * 1024;

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error('Cache request failed'));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = (): void => resolve();
    transaction.onabort = (): void =>
      reject(transaction.error ?? new Error('Cache transaction aborted'));
    transaction.onerror = (): void =>
      reject(transaction.error ?? new Error('Cache transaction failed'));
  });

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

// Normalized, incremental writes. Dictionary entries are shared by all paragraphs
// in a parser/server namespace, and removed only when their last reference is evicted.
export class IndexedDbContentStorage implements ContentStorage {
  private database?: Promise<IDBDatabase>;

  constructor(private maxBytes = MAX_DISK_BYTES) {}

  public async load(keys: string[]): Promise<Map<string, ParagraphContent>> {
    const db = await this.open();
    const transaction = db.transaction(['paragraphs', 'words'], 'readwrite');
    const done = transactionDone(transaction);
    const paragraphs = transaction.objectStore('paragraphs');
    const words = transaction.objectStore('words');
    const result = new Map<string, ParagraphContent>();

    try {
      for (const key of keys) {
        const record = (await requestResult(paragraphs.get(key))) as ParagraphRecord | undefined;

        if (!record) {
          continue;
        }

        const vocabulary: StaticVocabulary[] = [];

        for (const wordKey of record.words) {
          const word = (await requestResult(words.get(wordKey))) as WordRecord | undefined;

          if (word) {
            vocabulary.push(word.value);
          }
        }

        if (vocabulary.length === record.words.length) {
          result.set(key, { tokens: record.tokens, vocabulary });
          paragraphs.put({ ...record, lastAccess: Date.now() });
        }
      }

      await done;

      return result;
    } catch (error) {
      void done.catch(() => undefined);

      throw error;
    }
  }

  public async save(entries: Map<string, ParagraphContent>): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(['paragraphs', 'words', 'metadata'], 'readwrite');
    const done = transactionDone(transaction);
    const paragraphs = transaction.objectStore('paragraphs');
    const words = transaction.objectStore('words');
    const metadata = transaction.objectStore('metadata');

    try {
      let bytes = ((await requestResult(metadata.get('bytes'))) as number | undefined) ?? 0;
      const remove = async (key: IDBValidKey): Promise<void> => {
        const old = (await requestResult(paragraphs.get(key))) as ParagraphRecord | undefined;

        if (!old) {
          return;
        }

        paragraphs.delete(key);
        bytes -= old.bytes;

        for (const wordKey of old.words) {
          const word = (await requestResult(words.get(wordKey))) as WordRecord | undefined;

          if (!word) {
            continue;
          }

          if (word.references <= 1) {
            words.delete(wordKey);
            bytes -= word.bytes;
          } else {
            words.put({ ...word, references: word.references - 1 });
          }
        }
      };

      for (const [key, content] of entries) {
        await remove(key);
        const scope = (JSON.parse(key) as [string, string])[0];
        const wordKeys: string[] = [];

        for (const value of content.vocabulary) {
          const wordKey = JSON.stringify([scope, vocabularyKey(value)]);

          wordKeys.push(wordKey);
          const old = (await requestResult(words.get(wordKey))) as WordRecord | undefined;
          const record: WordRecord = {
            key: wordKey,
            value,
            references: (old?.references ?? 0) + 1,
            bytes: byteLength([wordKey, value]),
          };

          words.put(record);
          bytes += record.bytes - (old?.bytes ?? 0);
        }

        const record: ParagraphRecord = {
          key,
          tokens: content.tokens,
          words: wordKeys,
          lastAccess: Date.now(),
          bytes: byteLength([key, content.tokens, wordKeys]),
        };

        paragraphs.put(record);
        bytes += record.bytes;
      }

      while (bytes > this.maxBytes) {
        const oldest = await requestResult(
          paragraphs.index('lastAccess').getAllKeys(undefined, 20),
        );

        if (!oldest.length) {
          break;
        }

        for (const key of oldest) {
          if (bytes <= this.maxBytes) {
            break;
          }

          await remove(key);
        }
      }

      metadata.put(Math.max(0, bytes), 'bytes');
      await done;
    } catch (error) {
      void done.catch(() => undefined);

      try {
        transaction.abort();
      } catch {
        // An already aborted transaction cannot be aborted twice.
      }

      throw error;
    }
  }

  public async clear(): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(['paragraphs', 'words', 'metadata'], 'readwrite');
    const done = transactionDone(transaction);

    transaction.objectStore('paragraphs').clear();
    transaction.objectStore('words').clear();
    transaction.objectStore('metadata').clear();
    await done;
  }
  private open(): Promise<IDBDatabase> {
    return (this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        this.database = undefined;
        reject(new Error('Cache database opening timed out'));
      }, 2000);

      request.onupgradeneeded = (): void => {
        const db = request.result;

        db.createObjectStore('paragraphs', { keyPath: 'key' }).createIndex(
          'lastAccess',
          'lastAccess',
        );
        db.createObjectStore('words', { keyPath: 'key' });
        db.createObjectStore('metadata');
      };
      request.onsuccess = (): void => {
        clearTimeout(timer);

        if (expired) {
          request.result.close();

          return;
        }
        request.result.onversionchange = (): void => {
          request.result.close();
          this.database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = (): void => {
        clearTimeout(timer);
        this.database = undefined;
        reject(request.error ?? new Error('Cache database opening failed'));
      };
    }));
  }
}
