import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const TRIAL_COUNT = 10;
const NODE_COUNT = 200;
const BENCHMARK_CANVAS_ID = 'benchmark-200';
const BENCHMARK_CONTRACT = 'debrute.canvas-text-preview-benchmark.v1';
if (process.argv[2] === '--bump') {
  await bumpBenchmarkFiles(resolveRequiredPath(process.argv[3]), Number(process.argv[4]));
  process.exit(0);
}
const requestedOutputRoot = resolve(
  process.argv[2] ?? join(tmpdir(), `debrute-canvas-text-preview-benchmark-${randomUUID()}`)
);

await mkdir(requestedOutputRoot);
const outputRoot = await realpath(requestedOutputRoot);
await mkdir(join(outputRoot, 'text'), { recursive: true });
await mkdir(join(outputRoot, '.debrute'), { recursive: true });

const files = benchmarkFiles();
for (const file of files) {
  await writeFile(join(outputRoot, file.path), file.content, 'utf8');
}

await writeCanvas(BENCHMARK_CANVAS_ID, benchmarkNodes(files));
await writeJson(join(outputRoot, '.debrute', 'canvas-text-preview-benchmark.json'), {
  contract: BENCHMARK_CONTRACT,
  canvasId: BENCHMARK_CANVAS_ID,
  nodeCount: NODE_COUNT,
  paths: files.map((file) => file.path)
});

const totalBytes = files.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
process.stdout.write(`${JSON.stringify({
  outputRoot,
  trialCount: TRIAL_COUNT,
  nodeCount: NODE_COUNT,
  totalTextBytes: totalBytes,
  largestFiles: files
    .map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content) }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 12)
}, null, 2)}\n`);

async function writeCanvas(canvasId, nodeElements) {
  const userHome = process.platform === 'win32'
    ? (process.env.USERPROFILE ?? homedir())
    : (process.env.HOME ?? homedir());
  const rootKey = createHash('sha256').update(outputRoot, 'utf8').digest('hex');
  await writeJson(join(userHome, '.debrute', 'state', 'roots', rootKey, 'canvas.json'), {
    canonicalRoot: outputRoot,
    activeCanvasId: canvasId,
    canvases: [{
      id: canvasId,
      name: 'Benchmark 200',
      expandedDirectories: ['text'],
      nodeStates: Object.fromEntries(nodeElements.map((node) => [
        node.projectRelativePath,
        {
          manualLayout: {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height
          }
        }
      ])),
      occlusionOrder: []
    }]
  });
}

function benchmarkNodes(inputFiles) {
  return inputFiles.map((file, index) => {
    const column = index % 5;
    const row = Math.floor(index / 5);
    const wide = index % 17 === 0;
    const tall = index % 13 === 0;
    return {
      projectRelativePath: file.path,
      nodeKind: 'file',
      mediaKind: 'text',
      x: 200 + column * 5000,
      y: 200 + row * 3400,
      width: wide ? 4800 : 4200,
      height: tall ? 3200 : 2800,
      z: index
    };
  });
}

function benchmarkFiles() {
  const result = [];
  const extensions = ['ts', 'md', 'json', 'py', 'css'];
  for (let index = 0; index < 140; index += 1) {
    const extension = extensions[index % extensions.length];
    const targetBytes = 1024 + (index % 16) * 1024;
    result.push({
      path: `text/small-${String(index + 1).padStart(3, '0')}.${extension}`,
      content: asciiContentAtLeast(targetBytes, `// small source ${index + 1}\n`, `const value${index} = "preview-${index}";\n`)
    });
  }
  for (let index = 0; index < 40; index += 1) {
    const targetBytes = 8 * 1024 + (index % 8) * 8 * 1024;
    result.push({
      path: `text/cjk-${String(index + 1).padStart(3, '0')}.md`,
      content: utf8ContentAtLeast(targetBytes, `# 中文预览 ${index + 1}\n\n`, '画布文本预览需要保持字体、字重、换行与滚动位置一致。\n')
    });
  }
  const longLineSizes = [64, 96, 128, 160, 192, 256, 320, 512, 768, 896].map((kib) => kib * 1024);
  for (const [index, bytes] of longLineSizes.entries()) {
    result.push({
      path: `text/long-line-${String(index + 1).padStart(2, '0')}.txt`,
      content: exactAsciiBytes(bytes, `long-line-${index + 1}:`)
    });
  }
  for (let index = 0; index < 7; index += 1) {
    result.push({
      path: `text/medium-${String(index + 1).padStart(2, '0')}.log`,
      content: asciiContentAtLeast(128 * 1024, `medium-${index + 1}\n`, `2026-08-01T00:00:00Z event=${index} preview benchmark payload\n`)
    });
  }
  result.push({ path: 'text/boundary-1-mib-long-line.txt', content: exactAsciiBytes(1024 * 1024, 'one-mib:') });
  result.push({ path: 'text/boundary-2-mib-long-line.txt', content: exactAsciiBytes(2 * 1024 * 1024, 'two-mib:') });
  result.push({
    path: 'text/truncation-multiline.md',
    content: asciiContentAtLeast(512 * 1024, '# Truncation and viewport coverage\n', 'A rendered line that is outside the captured editor viewport.\n')
  });
  if (result.length !== NODE_COUNT) {
    throw new Error(`Expected ${NODE_COUNT} benchmark files, received ${result.length}.`);
  }
  return result.map((file) => ({ ...file, content: contentForTrial(file.content, 0) }));
}

async function bumpBenchmarkFiles(root, trial) {
  if (!Number.isInteger(trial) || trial < 1 || trial > TRIAL_COUNT) {
    throw new Error(`Benchmark trial must be an integer from 1 to ${TRIAL_COUNT}.`);
  }
  const manifest = JSON.parse(await readFile(
    join(root, '.debrute', 'canvas-text-preview-benchmark.json'),
    'utf8'
  ));
  if (
    manifest.contract !== BENCHMARK_CONTRACT
    || manifest.canvasId !== BENCHMARK_CANVAS_ID
    || manifest.nodeCount !== NODE_COUNT
    || !Array.isArray(manifest.paths)
    || manifest.paths.length !== NODE_COUNT
  ) {
    throw new Error('Benchmark root does not match the current Canvas text preview fixture contract.');
  }
  const expectedNames = manifest.paths.map((path) => {
    if (typeof path !== 'string' || !/^text\/[A-Za-z0-9._-]+$/.test(path)) {
      throw new Error(`Benchmark manifest contains an invalid text path: ${String(path)}`);
    }
    return path.slice('text/'.length);
  }).sort();
  const directory = join(root, 'text');
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const names = entries.map((entry) => entry.name);
  if (
    entries.some((entry) => !entry.isFile())
    || names.length !== NODE_COUNT
    || names.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error('Benchmark text directory does not exactly match its protected manifest.');
  }
  const currentContents = await Promise.all(names.map(async (name) => {
    const path = join(directory, name);
    const content = await readFile(path, 'utf8');
    if (!/^benchmark-trial:\d{3}\n/.test(content)) {
      throw new Error(`Benchmark file is missing its trial marker: ${name}`);
    }
    return { path, content };
  }));
  for (let offset = 0; offset < currentContents.length; offset += 16) {
    await Promise.all(currentContents.slice(offset, offset + 16).map(async ({ path, content }) => {
      await writeFile(path, contentForTrial(content, trial), 'utf8');
    }));
  }
  process.stdout.write(`${JSON.stringify({ root, trial, updatedFiles: names.length })}\n`);
}

function contentForTrial(content, trial) {
  const marker = `benchmark-trial:${String(trial).padStart(3, '0')}\n`;
  return `${marker}${content.slice(marker.length)}`;
}

function resolveRequiredPath(value) {
  if (!value) {
    throw new Error('Benchmark root is required.');
  }
  return resolve(value);
}

function asciiContentAtLeast(targetBytes, prefix, line) {
  const repeatCount = Math.ceil(Math.max(0, targetBytes - Buffer.byteLength(prefix)) / Buffer.byteLength(line));
  return `${prefix}${line.repeat(repeatCount)}`;
}

function utf8ContentAtLeast(targetBytes, prefix, line) {
  const repeatCount = Math.ceil(Math.max(0, targetBytes - Buffer.byteLength(prefix)) / Buffer.byteLength(line));
  return `${prefix}${line.repeat(repeatCount)}`;
}

function exactAsciiBytes(targetBytes, prefix) {
  const prefixBytes = Buffer.byteLength(prefix);
  if (prefixBytes > targetBytes) {
    throw new Error(`Prefix exceeds exact benchmark size ${targetBytes}.`);
  }
  return `${prefix}${'x'.repeat(targetBytes - prefixBytes)}`;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
