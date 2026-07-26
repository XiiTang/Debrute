import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(repositoryRoot, 'apps/web/dist');
const manifest = JSON.parse(readFileSync(resolve(distRoot, '.vite/manifest.json'), 'utf8'));
const entries = Object.entries(manifest);
const pageEntry = entries.find(([, value]) => value.isEntry)?.[0];
const workbenchEntry = 'src/workbench/WorkbenchApp.tsx';

if (!pageEntry || !manifest[workbenchEntry]) {
  throw new Error('Workbench build manifest is missing its page or application entry.');
}

function staticGraph(initialKeys) {
  const pending = [...initialKeys];
  const visited = new Set();
  while (pending.length > 0) {
    const key = pending.pop();
    if (!key || visited.has(key)) continue;
    const item = manifest[key];
    if (!item) throw new Error(`Build manifest references an unknown chunk: ${key}`);
    visited.add(key);
    pending.push(...(item.imports ?? []));
  }
  return visited;
}

function javascriptGzipBytes(keys) {
  return [...keys].reduce((total, key) => {
    const file = manifest[key].file;
    return file.endsWith('.js')
      ? total + gzipSync(readFileSync(resolve(distRoot, file))).byteLength
      : total;
  }, 0);
}

function requireDynamicBoundary(source) {
  if (!(manifest[workbenchEntry].dynamicImports ?? []).includes(source)) {
    throw new Error(`Workbench optional feature is no longer lazy: ${source}`);
  }
}

const bootstrapBytes = javascriptGzipBytes(staticGraph([pageEntry]));
const workbenchBytes = javascriptGzipBytes(staticGraph([pageEntry, workbenchEntry]));
const BOOTSTRAP_BUDGET = 80 * 1024;
const WORKBENCH_BUDGET = 320 * 1024;

requireDynamicBoundary('src/workbench/terminal/TerminalPanel.tsx');
requireDynamicBoundary('src/workbench/canvas/CanvasVideoPlayerAdapter.tsx');
if (!(manifest[workbenchEntry].dynamicImports ?? []).some((source) => source.includes('@codemirror+lang-'))) {
  throw new Error('CodeMirror language parsers are no longer loaded on demand.');
}
if (bootstrapBytes > BOOTSTRAP_BUDGET) {
  throw new Error(`Workbench bootstrap JavaScript is ${bootstrapBytes} gzip bytes; budget is ${BOOTSTRAP_BUDGET}.`);
}
if (workbenchBytes > WORKBENCH_BUDGET) {
  throw new Error(`Workbench critical JavaScript is ${workbenchBytes} gzip bytes; budget is ${WORKBENCH_BUDGET}.`);
}

console.log(
  `Workbench build budget: bootstrap=${bootstrapBytes}B gzip, critical=${workbenchBytes}B gzip.`
);
