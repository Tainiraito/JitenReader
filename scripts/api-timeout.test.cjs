const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadTs(file, mocks = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const module = new Module(filename);
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = module.require.bind(module);
  module.require = (name) => {
    if (mocks[name]) return mocks[name];
    const sibling = path.resolve(path.dirname(filename), name + '.ts');
    if (name.startsWith('.') && fs.existsSync(sibling))
      return loadTs(path.relative(path.resolve(__dirname, '..'), sibling));
    return originalRequire(name);
  };
  module._compile(code, filename);
  return module.exports;
}

const { getApiRequestTimeoutMs, isValidApiRequestTimeout } = loadTs(
  'src/shared/jiten/api-request-timeout.ts',
);

test('valid timeout boundaries and user-selected values use seconds', () => {
  for (const seconds of [1, 10, 60, 120, 300]) {
    assert.equal(isValidApiRequestTimeout(seconds), true);
    assert.equal(getApiRequestTimeoutMs(seconds), seconds * 1000);
  }
});

test('missing, invalid and corrupted values retain the personal sixty-second default', () => {
  for (const value of [undefined, null, '', '60', true, 0, -1, 301, 1.5, NaN, Infinity]) {
    assert.equal(isValidApiRequestTimeout(value), false);
    assert.equal(getApiRequestTimeoutMs(value), 60_000);
  }
});

test('real requests read the active timeout for each call, including explicit API tokens', async () => {
  let setting = 60;
  const durations = [];
  const originalFetch = global.fetch;
  const originalTimeout = AbortSignal.timeout;
  const { requestByUrl } = loadTs('src/shared/jiten/request-by-url.ts', {
    '../configuration/get-configuration': {
      getConfiguration: async (key) => (key === 'jitenApiTimeout' ? setting : 'test-key'),
    },
    '../dom/display-toast': { displayToast() {} },
    './parse-cache': { parseCache: { invalidateStates() {} } },
  });
  AbortSignal.timeout = (ms) => {
    durations.push(ms);
    return new AbortController().signal;
  };
  global.fetch = async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, status: 200, json: async () => ({ result: [] }) };
  };
  try {
    await requestByUrl('https://example.test/api', 'reader/parse', { text: ['先生'] });
    setting = 120;
    await requestByUrl('https://example.test/api', 'reader/ping', undefined, {
      apiToken: 'explicit',
    });
    setting = NaN;
    await requestByUrl('https://example.test/api', 'reader/ping');
    assert.deepEqual(durations, [60_000, 120_000, 60_000]);
  } finally {
    global.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});

test('the request signal remains active while the response body is downloaded', async () => {
  const controller = new AbortController();
  const originalFetch = global.fetch;
  const originalTimeout = AbortSignal.timeout;
  const { requestByUrl } = loadTs('src/shared/jiten/request-by-url.ts', {
    '../configuration/get-configuration': {
      getConfiguration: async (key) => (key === 'jitenApiTimeout' ? 120 : 'test-key'),
    },
    '../dom/display-toast': { displayToast() {} },
    './parse-cache': { parseCache: { invalidateStates() {} } },
  });
  AbortSignal.timeout = () => controller.signal;
  global.fetch = async (_url, options) => ({
    ok: true,
    status: 200,
    json: () =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason));
        controller.abort(new DOMException('timed out', 'TimeoutError'));
      }),
  });
  try {
    await assert.rejects(
      requestByUrl('https://example.test/api', 'reader/parse', { text: ['先生'] }),
      /timed out after 120s \(reader\/parse; reading response body\)/,
    );
  } finally {
    global.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});
