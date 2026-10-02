export const DEFAULT_API_REQUEST_TIMEOUT_SECONDS = 60;

export const isValidApiRequestTimeout = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 300;

export const getApiRequestTimeoutMs = (seconds: unknown): number =>
  (isValidApiRequestTimeout(seconds) ? seconds : DEFAULT_API_REQUEST_TIMEOUT_SECONDS) * 1000;
