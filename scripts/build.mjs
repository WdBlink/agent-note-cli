import { build } from 'esbuild';
import { mkdir, cp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(await readFile('backend/provenance.json', 'utf8'));
for (const [file, expected] of Object.entries(manifest.files)) {
  const actual = createHash('sha256').update(await readFile(`backend/upstream/${file}`)).digest('hex');
  if (actual !== expected) throw new Error(`Do not fork the shared backend: ${file}. Sync changes from Agent Notebook.`);
}
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['backend/index.mjs'], outfile: 'dist/backend.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
await cp('backend/upstream/skills', 'dist/skills', { recursive: true });
