import { existsSync, statSync } from 'node:fs';
import { chmod, cp, mkdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveNodeModulePackageRoot,
  sharpRuntimePayloadEntries
} from '../../../scripts/sharp-runtime-payload.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const electronBuilderArchX64 = 1;
const electronBuilderArchArm64 = 3;
const nodePtyCommonRuntimeFiles = new Set([
  'eventEmitter2.js',
  'index.js',
  'terminal.js',
  'utils.js'
]);
const nodePtyWindowsRuntimeFiles = new Set([
  'conpty_console_list_agent.js',
  'shared/conout.js',
  'windowsConoutConnection.js',
  'windowsPtyAgent.js',
  'windowsTerminal.js',
  'worker/conoutSocketWorker.js'
]);

export default async function afterPack(context) {
  await copyDesktopSharpRuntime(context);
  await copyDesktopNodePtyRuntime(context);
}

async function copyDesktopSharpRuntime(context) {
  const productFilename = context.packager.appInfo.productFilename;
  const resourcesDir = desktopResourcesDir(context, productFilename);

  for (const entry of sharpRuntimePayloadEntries(workspaceRoot, desktopSharpReleaseTarget(context))) {
    const destination = join(resourcesDir, entry.to);
    await mkdir(dirname(destination), { recursive: true });
    await cp(entry.from, destination, {
      recursive: entry.recursive,
      dereference: entry.dereference,
      filter: entry.excludeNestedNodeModules
        ? (source) => source === entry.from || !source.startsWith(join(entry.from, 'node_modules'))
        : undefined
    });
  }
}

async function copyDesktopNodePtyRuntime(context) {
  const productFilename = context.packager.appInfo.productFilename;
  const resourcesDir = desktopResourcesDir(context, productFilename);
  for (const entry of nodePtyRuntimePayloadEntries(workspaceRoot, context)) {
    const destination = join(resourcesDir, entry.to);
    await mkdir(dirname(destination), { recursive: true });
    await cp(entry.from, destination, { recursive: entry.recursive, dereference: true, filter: entry.filter });
    if (entry.executable === true) {
      await makeNodePtySpawnHelperExecutable(join(destination, entry.executableRelativePath));
    }
  }
}

async function makeNodePtySpawnHelperExecutable(helperPath) {
  if (!existsSync(helperPath)) return;
  const mode = (await stat(helperPath)).mode;
  if ((mode & 0o111) !== 0o111) {
    await chmod(helperPath, mode | 0o755);
  }
}

function desktopResourcesDir(context, productFilename) {
  if (context.electronPlatformName === 'darwin') {
    return join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
  }
  if (context.electronPlatformName === 'linux' || context.electronPlatformName === 'win32') {
    return join(context.appOutDir, 'resources');
  }
  throw new Error(`No Desktop resources directory mapping for ${context.electronPlatformName}.`);
}

function desktopSharpReleaseTarget(context) {
  const platform = context.electronPlatformName === 'win32' ? 'windows' : context.electronPlatformName;
  return { id: `${platform}-${desktopArchName(context.arch)}` };
}

function desktopNodePtyTarget(context) {
  return `${context.electronPlatformName}-${desktopArchName(context.arch)}`;
}

export function nodePtyRuntimePayloadEntries(root, context) {
  const packageRoot = resolveNodeModulePackageRoot(root, 'node-pty');
  const platform = context.electronPlatformName;
  const targetPrebuildPath = join(packageRoot, 'prebuilds', desktopNodePtyTarget(context));
  const entries = [
    nodePtyRuntimePayloadEntry(packageRoot, 'package.json', false),
    {
      ...nodePtyRuntimePayloadEntry(packageRoot, 'lib', true),
      filter: (source) => nodePtyLibRuntimeFilter(source, join(packageRoot, 'lib'), platform)
    }
  ];

  if (existsSync(targetPrebuildPath)) {
    entries.push({
      ...nodePtyRuntimePayloadEntry(packageRoot, join('prebuilds', desktopNodePtyTarget(context)), true),
      filter: nodePtyPrebuildRuntimeFilter,
      ...(context.electronPlatformName === 'win32' ? {} : { executable: true, executableRelativePath: 'spawn-helper' })
    });
    return entries;
  }

  entries.push(nodePtyRuntimePayloadEntry(packageRoot, 'build/Release/pty.node', false));
  if (existsSync(join(packageRoot, 'build/Release/spawn-helper'))) {
    entries.push({
      from: join(packageRoot, 'build/Release/spawn-helper'),
      to: 'node_modules/node-pty/build/Release/spawn-helper',
      recursive: false,
      executable: true,
      executableRelativePath: ''
    });
  }
  return entries;
}

function nodePtyRuntimePayloadEntry(packageRoot, packageRelativePath, recursive) {
  return {
    from: join(packageRoot, packageRelativePath),
    to: join('node_modules/node-pty', packageRelativePath),
    recursive
  };
}

function nodePtyLibRuntimeFilter(source, libRoot, platform) {
  if (statSync(source).isDirectory()) {
    return true;
  }
  const packageRelativePath = relative(libRoot, source).split(sep).join('/');
  if (!packageRelativePath.endsWith('.js') || packageRelativePath.endsWith('.test.js')) {
    return false;
  }

  if (nodePtyCommonRuntimeFiles.has(packageRelativePath)) {
    return true;
  }
  if (platform === 'win32') {
    return nodePtyWindowsRuntimeFiles.has(packageRelativePath);
  }
  return packageRelativePath === 'unixTerminal.js';
}

function nodePtyPrebuildRuntimeFilter(source) {
  if (statSync(source).isDirectory()) {
    return true;
  }
  return !source.endsWith('.pdb');
}

function desktopArchName(arch) {
  if (arch === electronBuilderArchX64) return 'x64';
  if (arch === electronBuilderArchArm64) return 'arm64';
  throw new Error(`No sharp runtime arch mapping for Electron Builder arch ${arch}.`);
}
