import { getConfiguration } from '../configuration/get-configuration';
import { getActiveProfileId } from '../configuration/profiles-state';
import { JitenRequestOptions } from './api.types';
import { parseCache } from './parse-cache';
import { requestByUrl } from './request-by-url';
import { JitenParseResult } from './types';

export const parse = async (
  paragraphs: string[],
  options?: JitenRequestOptions,
): Promise<JitenParseResult> => {
  const [profile, endpoint, apiToken] = await Promise.all([
    getActiveProfileId(),
    getConfiguration('jitenApiEndpoint'),
    options?.apiToken ?? getConfiguration('jitenApiKey'),
  ]);
  // Keep credentials out of persisted cache keys and isolate users/profiles/API servers.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([profile, endpoint, apiToken])),
  );
  const scope = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

  return parseCache.parse(scope, paragraphs, (text) =>
    requestByUrl(endpoint, 'reader/parse', { text }, { ...options, apiToken }),
  );
};
