import test from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, isNewer, readReleaseNotes, version } from '../src/updates.mjs';

test('stable versions compare numerically and ignore invalid or prerelease versions', () => {
  assert.ok(isNewer('0.10.0', '0.9.9'));
  assert.ok(isNewer('1.0.0', '0.99.99'));
  assert.ok(isNewer('0.4.1', '0.4.0'));
  for (const candidate of ['0.4.0', '0.3.99', '0.5.0-beta.1', 'oops', '0.5', null, '999999999999999999999.0.0']) {
    assert.equal(isNewer(candidate, '0.4.0'), false);
  }
});

test('GitHub check validates responses and propagates offline, HTTP and abort failures', async () => {
  const mock = (body, status = 200) => async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/WdBlink/agent-note-cli/releases/latest');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(options).sort(), ['headers', 'signal']);
    return new Response(JSON.stringify(body), { status });
  };
  assert.equal(await checkForUpdate({ fetcher: mock({ tag_name: 'v99.0.0' }) }), '99.0.0');
  assert.equal(await checkForUpdate({ fetcher: mock({ tag_name: `v${version}` }) }), null);
  assert.equal(await checkForUpdate({ fetcher: mock({ tag_name: 'v0.1.0' }) }), null);
  for (const body of [null, {}, { tag_name: 'v99.0.0', draft: true }, { tag_name: 'v99.0.0', prerelease: true }, { tag_name: 'v99.0.0-beta.1' }]) {
    await assert.rejects(checkForUpdate({ fetcher: mock(body) }));
  }
  await assert.rejects(checkForUpdate({ fetcher: mock({}, 403) }), /HTTP 403/);
  await assert.rejects(checkForUpdate({ fetcher: async () => { throw new Error('offline'); } }), /offline/);
  const controller = new AbortController();
  const pending = checkForUpdate({ signal: controller.signal, fetcher: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('current version notes are readable offline from the package', async () => {
  assert.match(await readReleaseNotes(), new RegExp(`Agent Note CLI ${version.replaceAll('.', '\\.')}`));
});
