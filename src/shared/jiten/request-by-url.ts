import { getConfiguration } from '../configuration/get-configuration';
import { displayToast } from '../dom/display-toast';
import { JitenEndpoints, JitenErrorResponse, JitenRequestOptions } from './api.types';
import { toConnectionError } from './connection-errors';
import { parseCache } from './parse-cache';
import { WordReference } from './parse-cache.types';
import { RateLimitedError } from './rate-limited-error';

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;
const DEFAULT_RETRY_AFTER_MS = 5_000;

const API_KEY_REJECTED_MESSAGE =
  'Jiten API key was rejected by the server. Please update it in the extension settings.';

// Latches the token that was rejected with 401/403 so subsequent requests fail
// fast without hitting the API until the key is changed or revalidated.
let rejectedApiToken: string | undefined;

const affectedWords = (params: unknown): WordReference[] | undefined => {
  if (!params || typeof params !== 'object') {
    return undefined;
  }

  if ('reviews' in params && Array.isArray(params.reviews)) {
    return params.reviews.flatMap((review: unknown) => affectedWords(review) ?? []);
  }

  if (
    'wordId' in params &&
    'readingIndex' in params &&
    typeof params.wordId === 'number' &&
    typeof params.readingIndex === 'number'
  ) {
    return [{ wordId: params.wordId, readingIndex: params.readingIndex }];
  }

  return undefined;
};

export const clearRejectedApiToken = (): void => {
  rejectedApiToken = undefined;
};

export const isApiTokenRejected = async (): Promise<boolean> => {
  if (!rejectedApiToken) {
    return false;
  }

  return (await getConfiguration('jitenApiKey')) === rejectedApiToken;
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const requestError = (error: unknown, action: string, stage: string): Error =>
  error instanceof DOMException && error.name === 'TimeoutError'
    ? new Error(`Jiten request timed out after ${REQUEST_TIMEOUT_MS / 1000}s (${action}; ${stage})`)
    : toConnectionError(error);

const parseRetryAfter = (header: string | null): number => {
  const seconds = Number(header);

  return header?.trim() && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : DEFAULT_RETRY_AFTER_MS;
};

const isRetryable = (error: unknown, response?: Response): boolean => {
  if (!response) {
    return true;
  }

  const status = response.status;

  return status === 429 || status >= 500;
};

export const requestByUrl = async <Key extends keyof JitenEndpoints>(
  baseUrl = 'https://api.jiten.moe',
  action: Key,
  params: JitenEndpoints[Key][0] | undefined,
  options?: JitenRequestOptions,
): Promise<JitenEndpoints[Key][1]> => {
  const apiToken = options?.apiToken || (await getConfiguration('jitenApiKey'));

  if (!apiToken?.length) {
    displayToast('error', 'API Token is not set');

    throw new Error('API Token is not set');
  }

  // Requests with an explicitly provided token (e.g. key validation in the
  // settings) bypass the latch so the server is actually consulted again.
  if (!options?.apiToken && apiToken === rejectedApiToken) {
    throw new Error(API_KEY_REJECTED_MESSAGE);
  }

  const usedUrl = new URL(`${baseUrl}/${action}`);
  const changesVocabulary = ![
    'reader/parse',
    'reader/ping',
    'reader/lookup-vocabulary',
    'srs/reader-study-decks',
  ].includes(action);

  if (changesVocabulary) {
    parseCache.invalidateStates(affectedWords(params));
  }

  let lastError: unknown;

  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let response: Response | undefined;
      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

      try {
        response = await fetch(usedUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `ApiKey ${apiToken}`,
            Accept: 'application/json',
          },
          body: params ? JSON.stringify(params) : undefined,
          signal,
        });
      } catch (error) {
        lastError = error;

        if (attempt < MAX_RETRIES - 1) {
          const backoff = INITIAL_BACKOFF_MS * 2 ** attempt;

          await wait(backoff + Math.random() * backoff * 0.5);

          continue;
        }

        throw requestError(
          signal.aborted ? signal.reason : error,
          action,
          'waiting for response headers',
        );
      }

      if (response.status === 401 || response.status === 403) {
        rejectedApiToken = apiToken;

        throw new Error(API_KEY_REJECTED_MESSAGE);
      }

      if (
        response.status === 429 &&
        (options?.failFastOnRateLimit || attempt === MAX_RETRIES - 1)
      ) {
        throw new RateLimitedError(parseRetryAfter(response.headers.get('Retry-After')));
      }

      if (!response.ok && isRetryable(null, response) && attempt < MAX_RETRIES - 1) {
        const backoff = INITIAL_BACKOFF_MS * 2 ** attempt;

        await wait(backoff + Math.random() * backoff * 0.5);

        continue;
      }

      let responseObject: JitenErrorResponse | JitenEndpoints[Key][1];

      try {
        responseObject = (await response.json()) as JitenErrorResponse | JitenEndpoints[Key][1];
      } catch (error) {
        if (error instanceof DOMException) {
          throw requestError(
            signal.aborted ? signal.reason : error,
            action,
            'reading response body',
          );
        }

        throw error;
      }

      if ('error_message' in (responseObject as JitenErrorResponse)) {
        throw new Error((responseObject as JitenErrorResponse).error_message);
      }

      if (apiToken === rejectedApiToken) {
        rejectedApiToken = undefined;
      }

      return responseObject as JitenEndpoints[Key][1];
    }

    throw lastError;
  } finally {
    if (changesVocabulary) {
      // A failed response can still accompany a server-side change.
      // Refresh account state after both successful and failed mutations.
      parseCache.invalidateStates(affectedWords(params));
    }
  }
};
