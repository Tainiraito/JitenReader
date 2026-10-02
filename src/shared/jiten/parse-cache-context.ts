import { getConfiguration } from '../configuration/get-configuration';
import { getActiveProfileId } from '../configuration/profiles-state';

// Bump when server token offsets/annotation interpretation changes.
const PARSER_CACHE_VERSION = 'jiten-reader-1.4.0-content-v2';
const hash = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const getParseCacheContext = async (
  token?: string,
): Promise<{
  contentScope: string;
  stateScope: string;
  endpoint: string;
  apiToken: string;
}> => {
  const [profile, endpoint, apiToken] = await Promise.all([
    getActiveProfileId(),
    getConfiguration('jitenApiEndpoint'),
    token ?? getConfiguration('jitenApiKey'),
  ]);
  const [contentScope, stateScope] = await Promise.all([
    hash([endpoint, PARSER_CACHE_VERSION]),
    hash([profile, endpoint, apiToken]),
  ]);

  return { contentScope, stateScope, endpoint, apiToken };
};
