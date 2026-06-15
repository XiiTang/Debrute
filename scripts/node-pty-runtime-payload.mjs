import { existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resolveNodeModulePackageRoot } from './sharp-runtime-payload.mjs';

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

export function nodePtyRuntimePayloadEntries(root, releaseTarget) {
  const packageRoot = resolveNodeModulePackageRoot(root, 'node-pty');
  const platform = nodePtyPlatformName(releaseTarget);
  const targetPrebuild = `${platform}-${nodePtyArchName(releaseTarget)}`;
  const targetPrebuildPath = join(packageRoot, 'prebuilds', targetPrebuild);
  const entries = [
    nodePtyRuntimePayloadEntry(packageRoot, 'package.json', false),
    {
      ...nodePtyRuntimePayloadEntry(packageRoot, 'lib', true),
      filter: (source) => nodePtyLibRuntimeFilter(source, join(packageRoot, 'lib'), platform)
    }
  ];

  if (existsSync(targetPrebuildPath)) {
    entries.push({
      ...nodePtyRuntimePayloadEntry(packageRoot, join('prebuilds', targetPrebuild), true),
      filter: nodePtyPrebuildRuntimeFilter,
      ...(platform === 'win32' ? {} : { executable: true, executableRelativePath: 'spawn-helper' })
    });
    return entries;
  }

  entries.push(
    nodePtyRuntimePayloadEntry(packageRoot, 'build/Release/pty.node', false),
    {
      ...nodePtyRuntimePayloadEntry(packageRoot, 'build/Release/spawn-helper', false),
      executable: true,
      executableRelativePath: ''
    }
  );
  return entries;
}

function nodePtyRuntimePayloadEntry(packageRoot, packageRelativePath, recursive) {
  return {
    from: join(packageRoot, packageRelativePath),
    to: join('node_modules/node-pty', packageRelativePath),
    recursive,
    dereference: true
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

function nodePtyPlatformName(releaseTarget) {
  const platform = releaseTarget.id.split('-')[0];
  return platform === 'windows' ? 'win32' : platform;
}

function nodePtyArchName(releaseTarget) {
  return releaseTarget.id.split('-').slice(1).join('-');
}
