import { readFileSync } from 'node:fs';
import { chmod, cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { sharpRuntimePayloadEntries } from './sharp-runtime-payload.mjs';
import { nodePtyRuntimePayloadEntries } from './node-pty-runtime-payload.mjs';
import { validateDebruteCliRuntimePayload } from './package-validation.mjs';

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgBin = join(workspaceRoot, 'node_modules/@yao-pkg/pkg/lib-es5/bin.js');

export const managedCliRuntimeTargets = [
  target('darwin-arm64', 'node24-macos-arm64', 'debrute'),
  target('darwin-x64', 'node24-macos-x64', 'debrute'),
  target('linux-arm64', 'node24-linux-arm64', 'debrute'),
  target('linux-x64', 'node24-linux-x64', 'debrute'),
  target('windows-arm64', 'node24-win-arm64', 'debrute.exe'),
  target('windows-x64', 'node24-win-x64', 'debrute.exe')
];

export const managedCliPkgFlags = ['--public', '--public-packages', '*', '--no-bytecode'];

export function managedCliRuntimePayloadEntries(root, releaseTarget = releaseTargetForHost()) {
  return [
    { from: join(root, 'packages/capability-runtime/src/imageModels/officialDocs/snapshots'), to: 'official-docs/imageModels/snapshots', recursive: true, dereference: false },
    { from: join(root, 'packages/capability-runtime/src/videoModels/officialDocs/snapshots'), to: 'official-docs/videoModels/snapshots', recursive: true, dereference: false },
    { from: join(root, 'packages/capability-runtime/src/audioModels/officialDocs/snapshots'), to: 'official-docs/audioModels/snapshots', recursive: true, dereference: false },
    ...sharpRuntimePayloadEntries(root, releaseTarget),
    ...nodePtyRuntimePayloadEntries(root, releaseTarget)
  ];
}

export async function packageDebruteCliRuntimePayload({
  outDir = join(workspaceRoot, 'build', 'runtime-product', 'cli'),
  releaseTarget = releaseTargetForHost()
} = {}) {
  const version = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')).version;
  const buildRoot = join(workspaceRoot, 'build', 'debrute-cli-runtime-payload');
  const bundlePath = join(buildRoot, 'debrute-cli.cjs');
  await rm(buildRoot, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [join(workspaceRoot, 'apps/debrute-cli/src/index.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['node-pty', 'sharp'],
    logOverride: {
      'empty-import-meta': 'silent'
    },
    logLevel: 'info'
  });
  const executablePath = join(buildRoot, releaseTarget.executableName);
  await execFileAsync(process.execPath, [
    pkgBin,
    bundlePath,
    '--targets',
    releaseTarget.pkgTarget,
    '--output',
    executablePath,
    ...managedCliPkgFlags
  ], { cwd: workspaceRoot });
  await cp(executablePath, join(outDir, releaseTarget.executableName));
  const runtimePayloadEntries = managedCliRuntimePayloadEntries(workspaceRoot, releaseTarget);
  for (const entry of runtimePayloadEntries) {
    await copyPayloadEntry(outDir, entry);
  }
  await writeFile(join(outDir, 'package.json'), `${JSON.stringify({ version }, null, 2)}\n`, 'utf8');
  await validateDebruteCliRuntimePayload(outDir, releaseTarget, runtimePayloadEntries);
  return { outDir, target: releaseTarget.id };
}

function target(id, pkgTarget, executableName) {
  return { id, pkgTarget, executableName };
}

function releaseTargetForHost() {
  const targetItem = managedCliRuntimeTargets.find((releaseTarget) => releaseTarget.id === hostTargetId());
  if (!targetItem) {
    throw new Error(`No Debrute CLI release target for ${process.platform}-${process.arch}.`);
  }
  return targetItem;
}

function hostTargetId() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  return `${platform}-${process.arch}`;
}

async function copyPayloadEntry(outDir, entry) {
  const destination = join(outDir, entry.to);
  await mkdir(dirname(destination), { recursive: true });
  await cp(entry.from, destination, {
    recursive: entry.recursive,
    dereference: entry.dereference,
    filter: payloadEntryFilter(entry)
  });
  if (entry.executable === true) {
    await makeExecutable(join(destination, entry.executableRelativePath));
  }
}

async function makeExecutable(path) {
  const mode = (await stat(path)).mode;
  if ((mode & 0o111) !== 0o111) {
    await chmod(path, mode | 0o755);
  }
}

function payloadEntryFilter(entry) {
  return (source) => {
    if (entry.excludeNestedNodeModules && source !== entry.from && source.startsWith(join(entry.from, 'node_modules'))) {
      return false;
    }
    return entry.filter ? entry.filter(source) : true;
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDirFlagIndex = process.argv.indexOf('--out-dir');
  const outDir = outDirFlagIndex === -1 ? undefined : process.argv[outDirFlagIndex + 1];
  packageDebruteCliRuntimePayload({ ...(outDir ? { outDir } : {}) })
    .then((result) => {
      console.log(`Packaged managed Debrute CLI runtime payload in ${result.outDir}`);
      console.log(`Target: ${result.target}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
