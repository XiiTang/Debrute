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
const textEditorFeature = 'src/workbench/canvas/FloatingTextEditorWindowFeature.tsx';
const textEditorEngine = 'src/workbench/canvas/CanvasTextEditor.tsx';
const explorerFeature = 'src/workbench/project-explorer/ExplorerPanelFeature.tsx';
const inspectorFeature = 'src/workbench/inspector/InspectorPanelFeature.tsx';
const explorerController = 'src/workbench/project-explorer/useProjectExplorerController.ts';
const terminalHub = 'src/api/terminalHubClient.ts';
const workbenchSource = readFileSync(resolve(repositoryRoot, 'apps/web/src/workbench/WorkbenchApp.tsx'), 'utf8');
const explorerFeatureSource = readFileSync(resolve(repositoryRoot, 'apps/web', explorerFeature), 'utf8');

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

function assetBytes(files) {
  return files.reduce((total, file) => total + readFileSync(resolve(distRoot, file)).byteLength, 0);
}

function cssAssets(keys) {
  return new Set([...keys].flatMap((key) => manifest[key].css ?? []));
}

function requireDynamicBoundary(source) {
  if (!(manifest[workbenchEntry].dynamicImports ?? []).includes(source)) {
    throw new Error(`Workbench optional feature is no longer lazy: ${source}`);
  }
}

function requireDynamicBoundaryFromGraph(initialKeys, source) {
  if (![...staticGraph(initialKeys)].some((key) => (
    manifest[key].dynamicImports ?? []
  ).includes(source))) {
    throw new Error(`Workbench optional service is no longer lazy: ${source}`);
  }
}

function requireDynamicStyles(source) {
  const styles = manifest[source].css ?? [];
  if (styles.length === 0) {
    throw new Error(`Workbench optional feature has no owning stylesheet chunk: ${source}`);
  }
  const bootstrapStyles = cssAssets(staticGraph([pageEntry]));
  if (styles.some((style) => bootstrapStyles.has(style))) {
    throw new Error(`Workbench optional stylesheet returned to bootstrap: ${source}`);
  }
}

const bootstrapBytes = javascriptGzipBytes(staticGraph([pageEntry]));
const workbenchBytes = javascriptGzipBytes(staticGraph([pageEntry, workbenchEntry]));
const shellFontAssets = (manifest[pageEntry].assets ?? []).filter((file) => (
  file.includes('SmileySans-Oblique')
  || /NotoSansSC-(Regular|Semibold|Bold)/.test(file)
));
const shellFontBytes = assetBytes(shellFontAssets);
const BOOTSTRAP_BUDGET = 80 * 1024;
const WORKBENCH_BUDGET = 250 * 1024;
const SHELL_FONT_BUDGET = 18 * 1024 * 1024;

requireDynamicBoundary('src/workbench/terminal/TerminalPanel.tsx');
requireDynamicBoundary('src/workbench/canvas/CanvasVideoPlayerAdapter.tsx');
requireDynamicBoundary('src/workbench/settings/SettingsFeature.tsx');
requireDynamicBoundary(explorerFeature);
requireDynamicBoundary(inspectorFeature);
requireDynamicBoundary(textEditorFeature);
requireDynamicBoundary(textEditorEngine);
requireDynamicStyles(explorerFeature);
requireDynamicStyles(inspectorFeature);
requireDynamicStyles('src/workbench/settings/SettingsFeature.tsx');
requireDynamicStyles('src/workbench/terminal/TerminalPanel.tsx');
requireDynamicBoundaryFromGraph([pageEntry], terminalHub);
if (staticGraph([workbenchEntry]).has(explorerController)) {
  throw new Error('Explorer controller returned to the Workbench critical graph.');
}
if (staticGraph([pageEntry]).has(terminalHub)) {
  throw new Error('Terminal Hub returned to the Workbench critical graph.');
}
if (workbenchSource.includes('useProjectExplorerController(')) {
  throw new Error('Workbench eagerly invokes the Explorer controller.');
}
if (!explorerFeatureSource.includes('useProjectExplorerController(input)')) {
  throw new Error('Explorer feature no longer owns its intent-activated controller.');
}
if (!(manifest[textEditorEngine].dynamicImports ?? []).some((source) => source.includes('@codemirror+lang-'))) {
  throw new Error('CodeMirror language parsers are no longer loaded on demand.');
}
if (bootstrapBytes > BOOTSTRAP_BUDGET) {
  throw new Error(`Workbench bootstrap JavaScript is ${bootstrapBytes} gzip bytes; budget is ${BOOTSTRAP_BUDGET}.`);
}
if (workbenchBytes > WORKBENCH_BUDGET) {
  throw new Error(`Workbench critical JavaScript is ${workbenchBytes} gzip bytes; budget is ${WORKBENCH_BUDGET}.`);
}
if (shellFontAssets.length !== 4 || shellFontBytes > SHELL_FONT_BUDGET) {
  throw new Error(
    `Workbench shell fonts are ${shellFontAssets.length} assets / ${shellFontBytes} bytes; budget is 4 assets / ${SHELL_FONT_BUDGET} bytes.`
  );
}

console.log(
  `Workbench build budget: bootstrap=${bootstrapBytes}B gzip, critical=${workbenchBytes}B gzip, shell-fonts=${shellFontBytes}B raw.`
);
