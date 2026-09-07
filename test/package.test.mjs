import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

test('release installs offline with bundled dependencies and runs its backend outside the checkout', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-note-package-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dir], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }))[0];
  assert.ok(packed.bundled.includes('@langchain/langgraph'));
  assert.ok(!packed.bundled.includes('esbuild'));
  for (const dependency of ['react', 'lucide-react']) assert.ok(!packed.bundled.includes(dependency));
  for (const file of ['src/terminal.mjs', 'src/interactive.mjs', 'src/assets/notebook.png', 'src/assets/notebook-strap-lift.png', 'src/assets/notebook-strap-free.png', 'src/assets/notebook-ajar.png', 'src/assets/notebook-open.png']) assert.ok(packed.files.some(item => item.path === file));
  execFileSync('npm', ['install', '--prefix', path.join(dir, 'app'), '--offline', '--cache', path.join(dir, 'empty-cache'), '--ignore-scripts', '--no-audit', '--no-fund', path.join(dir, packed.filename)], { stdio: 'pipe' });
  const bin = path.join(dir, 'app/node_modules/.bin/agent-note');
  const root = path.join(dir, 'codex');
  await fs.mkdir(root);
  assert.match(execFileSync(bin, ['--help'], { encoding: 'utf8', cwd: dir }), /Agent Note CLI/);
  const ui = spawnSync(bin, ['ui', '--data-dir', path.join(dir, 'data')], { encoding: 'utf8', cwd: dir, stdio: 'pipe' });
  assert.equal(ui.status, 1);
  assert.match(ui.stderr, /交互界面需要支持 ANSI 的终端/);
  const output = execFileSync(bin, ['brief', '--read-only', '--source', 'codex', '--root', root, '--data-dir', path.join(dir, 'data'), '--format', 'json'], { encoding: 'utf8', cwd: dir, stdio: 'pipe' });
  assert.equal(JSON.parse(output).index, null);
  assert.deepEqual(JSON.parse(output).sessions, []);
});
