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

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function harness(t, implementation) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = global.fetch;
  let calls = 0;
  global.fetch = (url, options) => implementation(options.signal, ++calls);
  t.after(() => {
    global.fetch = original;
    t.mock.timers.reset();
  });
  const { requestByUrl } = loadTs('src/shared/jiten/request-by-url.ts', {
    '../configuration/get-configuration': { getConfiguration: async () => 'private-key' },
    '../dom/display-toast': { displayToast() {} },
    './parse-cache': { parseCache: { invalidateStates() {} } },
  });
  const run = () =>
    requestByUrl('https://example.test/api', 'reader/parse', { text: ['private text'] });
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  return { run, tick, calls: () => calls };
}
function body(signal, delays) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () =>
          new Promise((resolve, reject) => {
            if (signal.aborted) return reject(signal.reason);
            const abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            const finish = () => {
              signal.removeEventListener('abort', abort);
              resolve(
                index++ < delays.length
                  ? { done: false, value: new TextEncoder().encode(' ') }
                  : { done: true },
              );
            };
            if (index < delays.length) setTimeout(finish, delays[index]);
            else finish();
          }),
      }),
    },
  };
}
// A whitespace body is supplemented with valid JSON in the successful cases.
function download(signal, delays) {
  const response = body(signal, delays);
  const reader = response.body.getReader();
  let sent = false;
  response.body.getReader = () => ({
    read: async () => {
      const chunk = await reader.read();
      if (chunk.done && !sent) {
        sent = true;
        return { done: false, value: new TextEncoder().encode('{}') };
      }
      return chunk;
    },
  });
  return response;
}
test('response headers abort after 10 seconds with at most three attempts', async (t) => {
  const h = harness(
    t,
    (signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
  );
  const result = assert.rejects(h.run(), /10s.*waiting for response headers/);
  await flush();
  for (let i = 0; i < 3; i++) {
    await h.tick(10000);
    if (i < 2) await h.tick(2000);
  }
  await result;
  assert.equal(h.calls(), 3);
});
test('progressing downloads exceed 10 seconds and reset the 15-second stall timer', async (t) => {
  const h = harness(t, (signal) => download(signal, [14000, 14000, 14000]));
  let done = false;
  const result = h.run().then((v) => {
    done = true;
    return v;
  });
  await flush();
  await h.tick(14000);
  assert.equal(done, false);
  await h.tick(14000);
  assert.equal(done, false);
  await h.tick(14000);
  assert.deepEqual(await result, {});
  assert.equal(h.calls(), 1);
  await h.tick(300000);
  assert.equal(h.calls(), 1);
});
test('a stalled download retries once and the replacement succeeds', async (t) => {
  const h = harness(t, (signal, n) => download(signal, n === 1 ? [20000] : []));
  const result = h.run();
  await flush();
  await h.tick(15000);
  await h.tick(2000);
  assert.deepEqual(await result, {});
  assert.equal(h.calls(), 2);
});
test('repeated download stalls stop after two attempts with a stage-specific error', async (t) => {
  const h = harness(t, (signal) => download(signal, [20000]));
  const result = assert.rejects(h.run(), (e) => {
    assert.match(e.message, /stalled for 15s.*reading response body/);
    assert.ok(!e.message.includes('private'));
    return true;
  });
  await flush();
  await h.tick(15000);
  await h.tick(2000);
  await h.tick(15000);
  await result;
  assert.equal(h.calls(), 2);
});
test('continuously progressing downloads hit the 300-second cap without retrying', async (t) => {
  const h = harness(t, (signal) => download(signal, Array(40).fill(10000)));
  const result = assert.rejects(h.run(), /300s.*reading response body/);
  await flush();
  for (let i = 0; i < 30; i++) await h.tick(10000);
  await result;
  assert.equal(h.calls(), 1);
});
