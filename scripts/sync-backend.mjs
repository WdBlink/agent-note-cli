import { build } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const upstream = process.argv[2] && path.resolve(process.argv[2]);
if (!upstream) throw new Error('Usage: node scripts/sync-backend.mjs /path/to/agent-notebook [--check]');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.argv.includes('--check')) {
  const manifest = JSON.parse(await readFile(path.join(root, 'backend/provenance.json'), 'utf8'));
  for (const [file, expected] of Object.entries(manifest.files)) {
    for (const base of [upstream, path.join(root, 'backend/upstream')]) {
      if (hash(await readFile(path.join(base, file))) !== expected) throw new Error(`Backend drift: ${base}/${file}`);
    }
  }
  console.log(`Backend parity: ${Object.keys(manifest.files).length} files match Agent Notebook byte-for-byte.`);
  process.exit(0);
}
const entry = await readFile(path.join(root, 'backend/index.mjs'), 'utf8');
const imports = [...entry.matchAll(/from '\.\/upstream\/([^']+)'/g)].map(m => m[1]);
const tests = ['structured-today-workflow', 'structured-today-integration', 'traceink-asset-repository', 'structured-today-provider-schema', 'agent-sessions', 'transcript-reader'].map(n => `tests/${n}.test.ts`);
const result = await build({ absWorkingDir: upstream, entryPoints: [...imports, ...tests], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, outdir: 'unused', metafile: true, logLevel: 'silent' });
const files = Object.keys(result.metafile.inputs);
// Keep source type imports resolvable as well as the runtime graph.
for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const source = await readFile(path.join(upstream, file), 'utf8');
  for (const m of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
    const base = path.resolve(upstream, path.dirname(file), m[1]);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
      try {
        await readFile(candidate);
        const relative = path.relative(upstream, candidate);
        if (relative.startsWith('..')) throw new Error('Source escaped repository');
        if (!files.includes(relative)) files.push(relative);
        break;
      } catch (error) { if (!['ENOENT', 'EISDIR'].includes(error.code)) throw error; }
    }
  }
}
files.push('skills/traceink/SKILL.md', 'skills/traceink/references/editorial-contract.md', 'LICENSE');
const hashes = {};
for (const file of [...new Set(files)].sort()) {
  const target = path.join(root, 'backend/upstream', file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(upstream, file), target);
  hashes[file] = hash(await readFile(target));
}
await writeFile(path.join(root, 'backend/provenance.json'), JSON.stringify({
  repository: 'https://github.com/WdBlink/agent-notebook',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim(),
  source: 'working-tree', files: hashes
}, null, 2) + '\n');
console.log(`Imported ${Object.keys(hashes).length} unchanged backend, contract and test files.`);
