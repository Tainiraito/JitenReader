const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadTs(relativePath, mocks = {}) {
  const filename = path.resolve(__dirname, '..', relativePath);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const module = new Module(filename);
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = module.require.bind(module);
  module.require = (name) => mocks[name] ?? originalRequire(name);
  module._compile(code, filename);
  return module.exports;
}

const { ParseCache } = loadTs('src/shared/jiten/parse-cache.ts');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const word = (state = 0) => ({
  wordId: 1,
  readingIndex: 0,
  spelling: '先生',
  reading: '先生',
  frequencyRank: 1,
  partsOfSpeech: ['n'],
  meaningsChunks: [['teacher']],
  meaningsPartOfSpeech: [['n']],
  knownState: [state],
  pitchAccents: [],
  studyDeckIds: [],
});
const response = (texts, state = 0) => ({
  tokens: texts.map((text) =>
    text.trim()
      ? [
          {
            wordId: 1,
            readingIndex: 0,
            start: 0,
            end: text.length,
            length: text.length,
            conjugations: [],
          },
        ]
      : [],
  ),
  vocabulary: [word(state)],
});

test('chapter 1 -> chapter 2 -> chapter 1 reuses results, including changed grouping', async () => {
  const cache = new ParseCache();
  const calls = [];
  const loader = async (texts) => {
    calls.push(texts);
    return response(texts);
  };
  const first = await cache.parse('user1', ['先生', '第一章', ' '], loader);
  await cache.parse('user1', ['第二章'], loader);
  assert.deepEqual(await cache.parse('user1', ['先生', '第一章', ' '], loader), first);
  await cache.parse('user1', ['第一章', '新段落', '先生'], loader);
  assert.deepEqual(calls, [['先生', '第一章', ' '], ['第二章'], ['新段落']]);
});

test('same text in another user/server/profile scope makes a fresh request', async () => {
  const cache = new ParseCache();
  const first = await cache.parse('account-a', ['先生'], async (t) => response(t, 0));
  const second = await cache.parse('account-b', ['先生'], async (t) => response(t, 5));
  assert.deepEqual(first.vocabulary[0].knownState, [0]);
  assert.deepEqual(second.vocabulary[0].knownState, [5]);
  const again = await cache.parse('account-a', ['先生'], () => assert.fail('cache miss'));
  assert.deepEqual(again.vocabulary[0].knownState, [0]);
});

test('concurrent overlapping requests share pending paragraphs and repeated input preserves order', async () => {
  const cache = new ParseCache();
  let finish;
  let calls = 0;
  const first = cache.parse('a', ['one', 'two', 'one'], async (texts) => {
    calls++;
    return new Promise((resolve) => {
      finish = () => resolve(response(texts));
    });
  });
  await flush();
  const second = cache.parse('a', ['two', 'one'], () => assert.fail('duplicate request'));
  await flush();
  finish();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(a.tokens[0], a.tokens[2]);
  assert.deepEqual(b.tokens, [a.tokens[1], a.tokens[0]]);
});

test('failed or malformed results never poison the cache', async () => {
  const cache = new ParseCache();
  await assert.rejects(
    cache.parse('a', ['text'], async () => {
      throw new Error('timeout');
    }),
    /timeout/,
  );
  await assert.rejects(
    cache.parse('a', ['text'], async () => ({ tokens: [], vocabulary: [] })),
    /paragraph count/,
  );
  const good = await cache.parse('a', ['text'], async (texts) => response(texts));
  assert.equal(good.tokens.length, 1);
});

test('expiry and LRU limits cause fresh requests', async () => {
  let now = 0;
  const cache = new ParseCache(undefined, () => now, 100000, 2);
  let calls = 0;
  const loader = async (texts) => {
    calls++;
    return response(texts);
  };
  await cache.parse('a', ['one', 'two'], loader);
  await cache.parse('a', ['one'], loader);
  await cache.parse('a', ['three'], loader);
  await cache.parse('a', ['one'], loader);
  assert.equal(calls, 2);
  await cache.parse('a', ['two'], loader);
  assert.equal(calls, 3);
  now = 30 * 60000 + 1;
  await cache.parse('a', ['two'], loader);
  assert.equal(calls, 4);
});

test('session snapshot survives service-worker restart, isolates vocabulary, and deduplicates words', async () => {
  let saved;
  const storage = {
    load: async () => structuredClone(saved),
    save: async (data) => {
      saved = structuredClone(data);
    },
  };
  const cache = new ParseCache(storage);
  await cache.parse('a', ['one', 'two'], async (t) => response(t, 0));
  await cache.parse('b', ['one'], async (t) => response(t, 5));
  await flush();
  assert.equal(saved.vocabulary.length, 2);
  const restarted = new ParseCache(storage);
  const a = await restarted.parse('a', ['two'], () => assert.fail('unexpected API request'));
  const b = await restarted.parse('b', ['one'], () => assert.fail('unexpected API request'));
  assert.deepEqual(a.vocabulary[0].knownState, [0]);
  assert.deepEqual(b.vocabulary[0].knownState, [5]);
});

test('consumer mutation cannot change cached offsets, words or states', async () => {
  const cache = new ParseCache();
  const first = await cache.parse('a', ['先生'], async (t) => response(t));
  first.tokens[0][0].start = 99;
  first.tokens[0][0].card = { anything: true };
  first.vocabulary[0].knownState = [5];
  const next = await cache.parse('a', ['先生'], () => assert.fail('cache miss'));
  assert.equal(next.tokens[0][0].start, 0);
  assert.equal(next.tokens[0][0].card, undefined);
  assert.deepEqual(next.vocabulary[0].knownState, [0]);
});

test('invalidation during a request prevents late stale results from being cached', async () => {
  const cache = new ParseCache();
  let finish;
  const pending = cache.parse(
    'a',
    ['先生'],
    async (texts) =>
      new Promise((resolve) => {
        finish = () => resolve(response(texts));
      }),
  );
  await flush();
  cache.clear();
  finish();
  await pending;
  const fresh = await cache.parse('a', ['先生'], async (t) => response(t, 5));
  assert.deepEqual(fresh.vocabulary[0].knownState, [5]);
});

test('clear before initialization cannot restore old session results', async () => {
  let saved;
  const storage = {
    load: async () => saved,
    save: async (s) => {
      saved = s;
    },
  };
  const first = new ParseCache(storage);
  await first.parse('a', ['先生'], async (t) => response(t));
  await flush();
  const next = new ParseCache(storage);
  next.clear();
  let called = false;
  await next.parse('a', ['先生'], async (t) => {
    called = true;
    return response(t, 5);
  });
  assert.equal(called, true);
});

test('storage failures and oversized entries do not prevent parsing', async () => {
  const broken = new ParseCache({
    load: async () => {
      throw Error('unavailable');
    },
    save: async () => {
      throw Error('quota');
    },
  });
  await broken.parse('a', ['先生'], async (t) => response(t));
  await flush();
  await broken.parse('a', ['先生'], () => assert.fail('memory fallback failed'));
  const tiny = new ParseCache(undefined, Date.now, 1);
  let calls = 0;
  const loader = async (t) => {
    calls++;
    return response(t);
  };
  await tiny.parse('a', ['先生'], loader);
  await tiny.parse('a', ['先生'], loader);
  assert.equal(calls, 2);
});

test('Ttsu whitespace preparation remains identical on repeated reads', () => {
  const { TtsuParagraphReader } = loadTs('src/apps/paragraph-reader/ttsu.paragraph-reader.ts', {
    './paragraph-reader': {
      ParagraphReader: class {
        pushText() {
          return 0;
        }
      },
    },
  });
  const reader = new TtsuParagraphReader();
  const text = { data: '　先生　です' };
  reader.pushText([], 0, text, false, null);
  const first = text.data;
  reader.pushText([], 0, text, false, null);
  assert.equal(text.data, first);
});

test('real parse wrapper and Parser reuse raw results while restoring card/sentence data', async () => {
  const cache = new ParseCache();
  let profile = 'profile-a';
  let token = 'test-secret-a';
  let endpoint = 'https://example.test/api';
  let calls = 0;
  const { parse } = loadTs('src/shared/jiten/parse.ts', {
    '../configuration/get-configuration': {
      getConfiguration: async (key) => (key === 'jitenApiEndpoint' ? endpoint : token),
    },
    '../configuration/profiles-state': { getActiveProfileId: async () => profile },
    './parse-cache': { parseCache: cache },
    './request-by-url': {
      requestByUrl: async (url, action, body, options) => {
        calls++;
        assert.equal(url, endpoint);
        assert.equal(action, 'reader/parse');
        assert.equal(options.apiToken, token);
        return response(body.text);
      },
    },
  });
  const { Parser } = loadTs('src/background-worker/parser/parser.ts', {
    '@shared/jiten/parse': { parse },
    './pitch-accent-utils': { getPitchClass: () => '' },
  });
  const chapter = async (strings) => {
    const groups = [];
    await new Parser({
      strings,
      handles: strings.map(() => ({ resolve: (tokens) => groups.push(tokens) })),
    }).parse();
    return groups;
  };
  const first = await chapter(['先生', '第一章']);
  await chapter(['第二章']);
  const again = await chapter(['先生', '第一章']);
  assert.equal(calls, 2);
  assert.deepEqual(again, first);
  assert.equal(again[0][0].card.spelling, '先生');
  assert.ok(again[0][0].sentence);
  profile = 'profile-b';
  await chapter(['先生']);
  token = 'test-secret-b';
  await chapter(['先生']);
  endpoint = 'https://other.example.test/api';
  await chapter(['先生']);
  assert.equal(calls, 5);
});

test('API mutations invalidate at start and completion; parse and lookups preserve cache', async () => {
  let clears = 0;
  const originalFetch = global.fetch;
  const { requestByUrl } = loadTs('src/shared/jiten/request-by-url.ts', {
    '../configuration/get-configuration': { getConfiguration: async () => 'fake-key' },
    '../dom/display-toast': { displayToast: () => {} },
    './connection-errors': { toConnectionError: (e) => e },
    './rate-limited-error': { RateLimitedError: class extends Error {} },
    './parse-cache': { parseCache: { clear: () => clears++ } },
  });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  try {
    for (const action of [
      'reader/parse',
      'reader/ping',
      'reader/lookup-vocabulary',
      'srs/reader-study-decks',
    ]) {
      await requestByUrl(undefined, action);
    }
    assert.equal(clears, 0);
    for (const action of [
      'srs/review',
      'srs/batch-review',
      'srs/set-vocabulary-state',
      'srs/study-decks/1/words',
    ]) {
      await requestByUrl(undefined, action);
    }
    assert.equal(clears, 8);
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error_message: 'failed mutation' }),
    });
    await assert.rejects(requestByUrl(undefined, 'srs/review'), /failed mutation/);
    assert.equal(clears, 10);
  } finally {
    global.fetch = originalFetch;
  }
});
