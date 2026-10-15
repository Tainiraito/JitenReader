const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    }).outputText,
    filename,
  );
};

function loadTs(relativePath, mocks = {}) {
  const filename = path.resolve(__dirname, '..', relativePath);
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

test('stopping TTS without an offscreen receiver is safe, including closure races', async () => {
  let contexts = [],
    sent = 0,
    failure;
  const { stopTtsAudio } = loadTs('src/background-worker/lib/stop-tts-audio.ts', {
    '@shared/extension/runtime': {
      runtime: {
        ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
        getContexts: async () => contexts,
        sendMessage: async () => {
          sent++;
          if (failure) throw failure;
        },
      },
    },
  });
  await stopTtsAudio();
  assert.equal(sent, 0);
  contexts = [{}];
  await stopTtsAudio();
  assert.equal(sent, 1);
  failure = Error('Could not establish connection. Receiving end does not exist.');
  await stopTtsAudio();
  assert.equal(sent, 2);
  failure = Error('Unexpected failure');
  await assert.rejects(stopTtsAudio(), /Unexpected failure/);
});

test('response body timeout identifies the API and 300-second limit without request secrets', async () => {
  const originalFetch = global.fetch;
  const { requestByUrl } = loadTs('src/shared/jiten/request-by-url.ts', {
    '../configuration/get-configuration': { getConfiguration: async () => 'private-key' },
    '../dom/display-toast': { displayToast() {} },
    './parse-cache': { parseCache: { invalidateStates() {} } },
  });
  global.fetch = async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return {
      ok: true,
      status: 200,
      text: async () => {
        throw new DOMException('signal timed out', 'TimeoutError');
      },
    };
  };
  try {
    await assert.rejects(
      requestByUrl('https://example.test/api', 'reader/parse', { text: ['private text'] }),
      (error) => {
        assert.match(error.message, /300s.*reader\/parse.*reading response body/);
        assert.ok(!error.message.includes('private'));
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('viewport batch completion waits for asynchronous highlighter rendering', async () => {
  const sequences = [];
  let rendered = false,
    complete = false,
    events = 0,
    finish;
  const render = new Promise((resolve) => (finish = resolve));
  const { BatchController } = loadTs('src/apps/batches/batch-controller.ts', {
    '@shared/dom/display-toast': { displayToast() {} },
    '@shared/jiten/connection-errors': { CONNECTION_ERROR_MESSAGES: [] },
    '@shared/messages/background/parse.command': {
      ParseCommand: class {
        constructor(data, priority) {
          assert.equal(priority, 'visible');
          assert.equal(data.length, 1);
        }
        async call() {
          sequences.forEach((s) => s.resolve([]));
        }
      },
    },
    '../integration/page-events': {
      pageEvents: {
        pageParsed() {
          events++;
        },
      },
    },
    '../integration/registry': {
      Registry: {
        sequenceManager: {
          getAbortableSequence(data) {
            let resolve, reject;
            const promise = new Promise((r, j) => {
              resolve = r;
              reject = j;
            });
            const s = {
              data,
              promise,
              resolve,
              sequenceId: sequences.length + 1,
              abort() {
                reject(Error('aborted'));
              },
            };
            sequences.push(s);
            return s;
          },
        },
      },
    },
    './apply-tokens': { applyTokens() {} },
    './get-paragraphs': { getParagraphs() {} },
  });
  const operation = new BatchController()
    .parseParagraphs([[{ node: { data: '先生', isConnected: true } }]], {
      priority: 'visible',
      signal: new AbortController().signal,
      applyFn: async () => {
        await render;
        rendered = true;
      },
    })
    .then(() => (complete = true));
  await flush();
  assert.equal(complete, false);
  assert.equal(events, 0);
  finish();
  await operation;
  assert.equal(rendered, true);
  assert.equal(events, 1);
});

test('five-minute state refresh and reviews keep stable chapter content', async () => {
  let now = 0;
  const cache = new ParseCache(undefined, () => now);
  let parses = 0,
    lookups = 0;
  const loader = async (texts) => {
    parses++;
    return response(texts);
  };
  const options = {
    stateScope: 'account',
    refreshStates: async () => {
      lookups++;
      return [{ knownState: [5], studyDeckIds: [7] }];
    },
  };
  await cache.parse('server', ['先生'], loader, options);
  assert.equal(lookups, 0);
  now = 5 * 60_000;
  let result = await cache.parse('server', ['先生'], loader, options);
  assert.deepEqual(result.vocabulary[0].knownState, [5]);
  assert.equal(parses, 1);
  assert.equal(lookups, 1);
  cache.invalidateStates([{ wordId: 2, readingIndex: 0 }]);
  await cache.parse('server', ['先生'], loader, options);
  assert.equal(lookups, 1);
  cache.invalidateStates([{ wordId: 1, readingIndex: 0 }]);
  await cache.parse('server', ['先生'], loader, options);
  assert.equal(lookups, 2);
  cache.updateState(
    'account',
    { wordId: 1, readingIndex: 0 },
    { knownState: [2], studyDeckIds: [8] },
  );
  result = await cache.parse('server', ['先生'], loader, options);
  assert.deepEqual(result.vocabulary[0].knownState, [2]);
  assert.equal(parses, 1);
  await cache.parse('server', ['先生'], loader, { ...options, stateScope: 'other-account' });
  assert.equal(parses, 1);
  assert.equal(lookups, 3);
});

test('late lookup cannot overwrite a newer vocabulary broadcast', async () => {
  const cache = new ParseCache();
  await cache.parse('server', ['先生'], async (t) => response(t));
  let finish;
  const options = {
    stateScope: 'account',
    refreshStates: () =>
      new Promise((resolve) => {
        finish = () => resolve([{ knownState: [0], studyDeckIds: [] }]);
      }),
  };
  const pending = cache.parse('server', ['先生'], () => assert.fail('reparse'), options);
  await flush();
  cache.updateState(
    'account',
    { wordId: 1, readingIndex: 0 },
    { knownState: [5], studyDeckIds: [8] },
  );
  finish();
  const result = await pending;
  assert.deepEqual(result.vocabulary[0].knownState, [5]);
  assert.deepEqual(result.vocabulary[0].studyDeckIds, [8]);
});

test('dispatch prioritizes visible paragraphs and uses bounded prefetch batches', () => {
  const stub = class {
    sendToFrame() {}
  };
  const mocks = {
    './parser': { Parser: stub },
    '@shared/jiten/rate-limited-error': { RateLimitedError: class extends Error {} },
  };
  for (const [file, name] of [
    ['sequence-aborted', 'SequenceAbortedCommand'],
    ['sequence-error', 'SequenceErrorCommand'],
    ['sequence-success', 'SequenceSuccessCommand'],
    ['toast', 'ToastCommand'],
  ])
    mocks['@shared/messages/foreground/' + file + '.command'] = { [name]: stub };
  const { ParseController } = loadTs('src/background-worker/parser/parse.controller.ts', mocks);
  const controller = new ParseController();
  controller._inFlight = true;
  const sender = { tab: { id: 1 }, frameId: 0 };
  controller.parseSequences(
    sender,
    [
      [1, '後'.repeat(150)],
      [2, '後'.repeat(150)],
    ],
    'background',
  );
  controller.parseSequences(
    sender,
    Array.from({ length: 20 }, (_, i) => [i + 3, '前'.repeat(80)]),
    'visible',
  );
  const first = controller.takeBatch();
  assert.ok(first.handles.every((h) => h.priority === 'visible'));
  assert.ok(first.handles.length <= 12);
  assert.ok(first.handles.reduce((n, h) => n + h.length, 0) <= 3000);
  while ([...controller._pending.values()].some((h) => h.priority === 'visible'))
    controller.takeBatch();
  const background = controller.takeBatch();
  assert.equal(background.handles.length, 1);
  assert.ok(background.handles.reduce((n, h) => n + h.length, 0) <= 600);
});

test('cache namespaces hash secrets and separate account state from server content', async () => {
  let profile = 'first',
    token = 'secret-one',
    endpoint = 'https://example.test/api';
  const { getParseCacheContext } = loadTs('src/shared/jiten/parse-cache-context.ts', {
    '../configuration/get-configuration': {
      getConfiguration: async (key) => (key === 'jitenApiEndpoint' ? endpoint : token),
    },
    '../configuration/profiles-state': { getActiveProfileId: async () => profile },
  });
  const first = await getParseCacheContext();
  profile = 'second';
  token = 'secret-two';
  const second = await getParseCacheContext();
  assert.equal(first.contentScope, second.contentScope);
  assert.notEqual(first.stateScope, second.stateScope);
  assert.match(first.stateScope, /^[a-f0-9]{64}$/);
  assert.ok(!first.stateScope.includes('secret'));
  endpoint = 'https://other.test/api';
  assert.notEqual((await getParseCacheContext()).contentScope, first.contentScope);
});

test('local sequence cancellation settles immediately and ignores late background replies', async () => {
  const listeners = {};
  let sent = 0;
  const { SequenceManager } = loadTs('src/apps/sequence/sequence-manager.ts', {
    '@shared/messages/background/abort-request.command': {
      AbortRequestCommand: class {
        send() {
          sent++;
        }
      },
    },
    '@shared/messages/receiving/receive-background-message': {
      receiveBackgroundMessage: (key, fn) => (listeners[key] = fn),
    },
  });
  const manager = new SequenceManager();
  const sequence = manager.getAbortableSequence('old-page');
  const rejected = assert.rejects(sequence.promise);
  sequence.abort();
  await rejected;
  listeners.sequenceSuccess(sequence.sequenceId, []);
  assert.equal(manager._requests.size, 0);
  assert.equal(sent, 1);
});

test('disk-restored entries larger than the memory limit do not reparse', async () => {
  const saved = new Map();
  const storage = {
    load: async (keys) => new Map(keys.filter((k) => saved.has(k)).map((k) => [k, saved.get(k)])),
    save: async (entries) => entries.forEach((v, k) => saved.set(k, v)),
    clear: async () => saved.clear(),
  };
  const first = new ParseCache(storage);
  await first.parse('a', ['先生'], async (t) => response(t));
  await flush();
  const tiny = new ParseCache(storage, Date.now, 1);
  const result = await tiny.parse('a', ['先生'], () => assert.fail('disk hit must not reparse'));
  assert.equal(result.tokens.length, 1);
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

test('LRU limits bound memory but stable content does not expire by time', async () => {
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
  assert.equal(calls, 3);
});

test('persistent content survives restart without storing account states', async () => {
  const saved = new Map();
  const storage = {
    load: async (keys) =>
      new Map(
        keys.filter((key) => saved.has(key)).map((key) => [key, structuredClone(saved.get(key))]),
      ),
    save: async (data) => data.forEach((value, key) => saved.set(key, structuredClone(value))),
    clear: async () => saved.clear(),
  };
  const cache = new ParseCache(storage);
  await cache.parse('a', ['one', 'two'], async (t) => response(t, 0));
  await cache.parse('b', ['one'], async (t) => response(t, 5));
  await flush();
  assert.equal(saved.size, 3);
  for (const paragraph of saved.values()) {
    assert.equal(paragraph.vocabulary[0].knownState, undefined);
    assert.equal(paragraph.vocabulary[0].studyDeckIds, undefined);
  }
  const restarted = new ParseCache(storage);
  const a = await restarted.parse('a', ['two'], () => assert.fail('unexpected API request'), {
    stateScope: 'account-a',
    refreshStates: async () => [{ knownState: [0], studyDeckIds: [] }],
  });
  const b = await restarted.parse('b', ['one'], () => assert.fail('unexpected API request'), {
    stateScope: 'account-b',
    refreshStates: async () => [{ knownState: [5], studyDeckIds: [] }],
  });
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

test('clear before initialization cannot restore old persistent results', async () => {
  const saved = new Map();
  const storage = {
    load: async (keys) =>
      new Map(keys.filter((key) => saved.has(key)).map((key) => [key, saved.get(key)])),
    save: async (data) => data.forEach((value, key) => saved.set(key, value)),
    clear: async () => saved.clear(),
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
    './parse-cache-context': {
      getParseCacheContext: async () => ({
        contentScope: endpoint,
        stateScope: profile + token,
        endpoint,
        apiToken: token,
      }),
    },
    './parse-cache': { parseCache: cache },
    './request-by-url': {
      requestByUrl: async (url, action, body, options) => {
        calls++;
        assert.equal(url, endpoint);
        assert.equal(options.apiToken, token);
        options.onNetworkRequest?.();
        if (action === 'reader/lookup-vocabulary')
          return { result: body.words.map(() => [0]), decks: body.words.map(() => []) };
        assert.equal(action, 'reader/parse');
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

test('API mutations invalidate only state at start and completion; read actions preserve cache', async () => {
  let clears = 0;
  const originalFetch = global.fetch;
  const { requestByUrl } = loadTs('src/shared/jiten/request-by-url.ts', {
    '../configuration/get-configuration': { getConfiguration: async () => 'fake-key' },
    '../dom/display-toast': { displayToast: () => {} },
    './connection-errors': { toConnectionError: (e) => e },
    './rate-limited-error': { RateLimitedError: class extends Error {} },
    './parse-cache': { parseCache: { invalidateStates: () => clears++ } },
  });
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
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
      text: async () => JSON.stringify({ error_message: 'failed mutation' }),
    });
    await assert.rejects(requestByUrl(undefined, 'srs/review'), /failed mutation/);
    assert.equal(clears, 10);
  } finally {
    global.fetch = originalFetch;
  }
});

test('upstream surface furigana stays correct when raw paragraphs are served from cache', async () => {
  const cache = new ParseCache();
  let network = 0;
  const examples = [
    ['来た', '来[く]る', '来る', ['き']],
    ['来ない', '来[く]る', '来る', ['こ']],
    ['来る', '来[く]る', '来る', ['く']],
    ['得ない', '得[う]る', '得る', ['え']],
    ['１本', '１[いっ]本[ぽん]', '１本', ['いっ', 'ぽん']],
    ['違う', '来[く]る', '来る', []],
  ];
  const { Parser } = loadTs('src/background-worker/parser/parser.ts', {
    '@shared/jiten/parse': {
      parse: (texts, options) =>
        cache.parse('same-format-v2', texts, async (requested) => {
          network++;
          options.onNetworkRequest?.();
          return {
            tokens: requested.map((text) => [
              {
                wordId: examples.findIndex((e) => e[0] === text) + 1,
                readingIndex: 0,
                start: 0,
                end: text.length,
                length: text.length,
                conjugations: [],
              },
            ]),
            vocabulary: requested.map((text) => {
              const i = examples.findIndex((e) => e[0] === text);
              return {
                ...word(),
                wordId: i + 1,
                reading: examples[i][1],
                spelling: examples[i][2],
              };
            }),
          };
        }),
    },
    './pitch-accent-utils': { getPitchClass: () => '' },
  });
  const run = async () => {
    const groups = [];
    const requested = await new Parser({
      strings: examples.map((e) => e[0]),
      handles: examples.map(() => ({ resolve: (v) => groups.push(v) })),
    }).parse();
    return { groups, requested };
  };
  const first = await run(),
    again = await run();
  assert.equal(network, 1);
  assert.equal(first.requested, true);
  assert.equal(again.requested, false);
  assert.deepEqual(first.groups, again.groups);
  again.groups.forEach((group, i) => {
    assert.deepEqual(
      group[0].rubies.map((r) => r.text),
      examples[i][3],
    );
    assert.ok(group[0].rubies.every((r) => r.end <= examples[i][0].length));
  });
});
