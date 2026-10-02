import { JitenRequestOptions } from './api.types';
import { parseCache } from './parse-cache';
import { getParseCacheContext } from './parse-cache-context';
import { VocabularyState } from './parse-cache.types';
import { requestByUrl } from './request-by-url';
import { JitenParseResult } from './types';

export const parse = async (
  paragraphs: string[],
  options?: JitenRequestOptions,
): Promise<JitenParseResult> => {
  const { contentScope, stateScope, endpoint, apiToken } = await getParseCacheContext(
    options?.apiToken,
  );

  return parseCache.parse(
    contentScope,
    paragraphs,
    (text) => {
      options?.onNetworkRequest?.();

      return requestByUrl(endpoint, 'reader/parse', { text }, { ...options, apiToken });
    },
    {
      stateScope,
      refreshStates: async (words): Promise<VocabularyState[]> => {
        const states: VocabularyState[] = [];

        for (let offset = 0; offset < words.length; offset += 128) {
          const batch = words.slice(offset, offset + 128);

          options?.onNetworkRequest?.();
          const result = await requestByUrl(
            endpoint,
            'reader/lookup-vocabulary',
            {
              words: batch.map(({ wordId, readingIndex }) => [wordId, readingIndex]),
            },
            { ...options, apiToken },
          );

          if (result.result?.length !== batch.length) {
            throw new Error('Unexpected vocabulary state count');
          }
          states.push(
            ...batch.map((_, i) => ({
              knownState: result.result[i]?.length ? result.result[i] : [0],
              studyDeckIds: result.decks?.[i] ?? [],
            })),
          );
        }

        return states;
      },
    },
  );
};
