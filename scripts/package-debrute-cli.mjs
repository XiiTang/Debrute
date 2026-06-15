import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { build } from 'esbuild';
import {
  checksumManifestName,
  cliReleaseAssetName
} from './release-asset-contract.mjs';
import { packageManagerCommand } from './package-manager-command.mjs';
import { sharpRuntimePayloadEntries } from './sharp-runtime-payload.mjs';
import { nodePtyRuntimePayloadEntries } from './node-pty-runtime-payload.mjs';
export { checksumManifestName } from './release-asset-contract.mjs';

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgBin = join(workspaceRoot, 'node_modules/@yao-pkg/pkg/lib-es5/bin.js');

export const debruteCliReleaseTargets = [
  target('darwin-arm64', 'node24-macos-arm64', 'debrute', 'tar.gz'),
  target('darwin-x64', 'node24-macos-x64', 'debrute', 'tar.gz'),
  target('linux-arm64', 'node24-linux-arm64', 'debrute', 'tar.gz'),
  target('linux-x64', 'node24-linux-x64', 'debrute', 'tar.gz'),
  target('windows-arm64', 'node24-win-arm64', 'debrute.exe', 'zip'),
  target('windows-x64', 'node24-win-x64', 'debrute.exe', 'zip')
];

export const debruteCliPkgFlags = ['--public', '--public-packages', '*', '--no-bytecode'];

export function debruteCliArchiveName(version, releaseTarget) {
  return cliReleaseAssetName(version, releaseTarget);
}

export function debruteCliPayloadEntries(root, releaseTarget = releaseTargetForHost()) {
  return [
    { from: join(root, 'skills'), to: 'skills', recursive: true, dereference: false },
    { from: join(root, 'apps/web/dist'), to: 'web', recursive: true, dereference: false },
    { from: join(root, 'packages/capability-runtime/src/imageModels/officialDocs/snapshots'), to: 'official-docs/imageModels/snapshots', recursive: true, dereference: false },
    { from: join(root, 'packages/capability-runtime/src/videoModels/officialDocs/snapshots'), to: 'official-docs/videoModels/snapshots', recursive: true, dereference: false },
    ...sharpRuntimePayloadEntries(root, releaseTarget),
    ...nodePtyRuntimePayloadEntries(root, releaseTarget)
  ];
}

export async function packageDebruteCliRelease({ all = false, outDir = join(workspaceRoot, 'release', 'debrute-cli') } = {}) {
  const version = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')).version;
  const selectedTargets = all ? debruteCliReleaseTargets : debruteCliReleaseTargets.filter((releaseTarget) => releaseTarget.id === hostTargetId());
  if (selectedTargets.length === 0) {
    throw new Error(`No Debrute CLI release target for ${process.platform}-${process.arch}.`);
  }

  const checkCommand = packageManagerCommand(workspaceRoot, ['check']);
  await execFileAsync(checkCommand.command, checkCommand.args, { cwd: workspaceRoot });
  const webBuildCommand = packageManagerCommand(workspaceRoot, ['--filter', '@debrute/web', 'build']);
  await execFileAsync(webBuildCommand.command, webBuildCommand.args, { cwd: workspaceRoot });

  const buildRoot = join(workspaceRoot, 'build', 'debrute-cli-release');
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

  const checksums = [];
  for (const releaseTarget of selectedTargets) {
    const executablePath = join(buildRoot, releaseTarget.executableName);
    await execFileAsync(process.execPath, [
      pkgBin,
      bundlePath,
      '--targets',
      releaseTarget.pkgTarget,
      '--output',
      executablePath,
      ...debruteCliPkgFlags
    ], { cwd: workspaceRoot });
    const payloadDir = join(buildRoot, releaseTarget.id, 'payload');
    await mkdir(payloadDir, { recursive: true });
    await cp(executablePath, join(payloadDir, releaseTarget.executableName));
    for (const entry of debruteCliPayloadEntries(workspaceRoot, releaseTarget)) {
      const destination = join(payloadDir, entry.to);
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
    await writeFile(join(payloadDir, 'package.json'), `${JSON.stringify({ version }, null, 2)}\n`, 'utf8');
    const archiveName = debruteCliArchiveName(version, releaseTarget);
    const archivePath = join(outDir, archiveName);
    if (releaseTarget.archiveExtension === 'zip') {
      const zip = new AdmZip();
      zip.addLocalFolder(payloadDir);
      await new Promise((resolvePromise, reject) => {
        zip.writeZip(archivePath, (error) => error ? reject(error) : resolvePromise());
      });
    } else {
      await execFileAsync('tar', ['-czf', archivePath, '-C', payloadDir, '.']);
    }
    checksums.push(`${await sha256File(archivePath)}  ${archiveName}`);
  }
  await writeFile(join(outDir, checksumManifestName), `${checksums.join('\n')}\n`, 'utf8');
  return { outDir, targets: selectedTargets.map((releaseTarget) => releaseTarget.id) };
}

function target(id, pkgTarget, executableName, archiveExtension) {
  return { id, pkgTarget, executableName, archiveExtension };
}

function releaseTargetForHost() {
  const targetItem = debruteCliReleaseTargets.find((releaseTarget) => releaseTarget.id === hostTargetId());
  if (!targetItem) {
    throw new Error(`No Debrute CLI release target for ${process.platform}-${process.arch}.`);
  }
  return targetItem;
}

function hostTargetId() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  return `${platform}-${process.arch}`;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
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
  const all = process.argv.includes('--all');
  packageDebruteCliRelease({ all })
    .then((result) => {
      console.log(`Packaged Debrute CLI assets in ${result.outDir}`);
      console.log(`Targets: ${result.targets.join(', ')}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
