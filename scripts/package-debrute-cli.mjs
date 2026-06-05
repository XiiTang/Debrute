import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { build } from 'esbuild';
import {
  checksumManifestName,
  cliReleaseAssetName
} from './release-asset-contract.mjs';
export { checksumManifestName } from './release-asset-contract.mjs';

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkgBin = join(workspaceRoot, 'node_modules/@yao-pkg/pkg/lib-es5/bin.js');

export const debruteCliReleaseTargets = [
  target('darwin-arm64', 'node22-macos-arm64', 'debrute', 'tar.gz'),
  target('darwin-x64', 'node22-macos-x64', 'debrute', 'tar.gz'),
  target('linux-arm64', 'node22-linux-arm64', 'debrute', 'tar.gz'),
  target('linux-x64', 'node22-linux-x64', 'debrute', 'tar.gz'),
  target('windows-arm64', 'node22-win-arm64', 'debrute.exe', 'zip'),
  target('windows-x64', 'node22-win-x64', 'debrute.exe', 'zip')
];

export const debruteCliPkgFlags = ['--public', '--public-packages', '*', '--no-bytecode'];

export function debruteCliArchiveName(version, releaseTarget) {
  return cliReleaseAssetName(version, releaseTarget);
}

export function debruteCliPayloadEntries(root, releaseTarget = releaseTargetForHost()) {
  return [
    { from: join(root, 'skills'), to: 'skills', recursive: true },
    { from: join(root, 'apps/web/dist'), to: 'web', recursive: true },
    ...sharpPayloadPackages(releaseTarget).map((packageName) => nodeModulePayloadEntry(root, packageName))
  ];
}

export async function packageDebruteCliRelease({ all = false, outDir = join(workspaceRoot, 'release', 'debrute-cli') } = {}) {
  const version = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')).version;
  const selectedTargets = all ? debruteCliReleaseTargets : debruteCliReleaseTargets.filter((releaseTarget) => releaseTarget.id === hostTargetId());
  if (selectedTargets.length === 0) {
    throw new Error(`No Debrute CLI release target for ${process.platform}-${process.arch}.`);
  }

  await execFileAsync(pnpmExecutable(), ['check'], { cwd: workspaceRoot });
  await execFileAsync(pnpmExecutable(), ['--filter', '@debrute/web', 'build'], { cwd: workspaceRoot });

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
    target: 'node22',
    external: ['sharp'],
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
        dereference: entry.dereference ?? false,
        filter: entry.excludeNestedNodeModules
          ? (source) => source === entry.from || !source.startsWith(join(entry.from, 'node_modules'))
          : undefined
      });
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

function nodeModulePayloadEntry(root, packageName) {
  return {
    from: resolveNodeModulePackageRoot(root, packageName),
    to: `node_modules/${packageName}`,
    recursive: true,
    dereference: true,
    ...(packageName === 'sharp' ? { excludeNestedNodeModules: true } : {})
  };
}

export function resolveNodeModulePackageRoot(root, packageName) {
  const packageSegments = packageName.split('/');
  const directPath = join(root, 'node_modules', ...packageSegments);
  if (existsSync(directPath)) return directPath;

  const pnpmHoistPath = join(root, 'node_modules', '.pnpm', 'node_modules', ...packageSegments);
  if (existsSync(pnpmHoistPath)) return pnpmHoistPath;

  if (resolve(root) === workspaceRoot) {
    return dirname(require.resolve(`${packageName}/package.json`, { paths: [root] }));
  }
  return directPath;
}

function sharpPayloadPackages(releaseTarget) {
  const nativePackages = {
    'darwin-arm64': ['@img/sharp-darwin-arm64', '@img/sharp-libvips-darwin-arm64'],
    'darwin-x64': ['@img/sharp-darwin-x64', '@img/sharp-libvips-darwin-x64'],
    'linux-arm64': ['@img/sharp-linux-arm64', '@img/sharp-libvips-linux-arm64'],
    'linux-x64': ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64'],
    'windows-arm64': ['@img/sharp-win32-arm64'],
    'windows-x64': ['@img/sharp-win32-x64']
  }[releaseTarget.id];
  if (!nativePackages) {
    throw new Error(`No sharp native package mapping for ${releaseTarget.id}.`);
  }
  return ['sharp', '@img/colour', 'detect-libc', 'semver', ...nativePackages];
}

function hostTargetId() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  return `${platform}-${process.arch}`;
}

function pnpmExecutable() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

async function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
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
