import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { build } from 'esbuild';

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgBin = join(workspaceRoot, 'node_modules/@yao-pkg/pkg/lib-es5/bin.js');

export const checksumManifestName = 'axis-cli_SHA256SUMS';

export const axisCliReleaseTargets = [
  target('darwin-arm64', 'node22-macos-arm64', 'axis', 'tar.gz'),
  target('darwin-x64', 'node22-macos-x64', 'axis', 'tar.gz'),
  target('linux-arm64', 'node22-linux-arm64', 'axis', 'tar.gz'),
  target('linux-x64', 'node22-linux-x64', 'axis', 'tar.gz'),
  target('windows-arm64', 'node22-win-arm64', 'axis.exe', 'zip'),
  target('windows-x64', 'node22-win-x64', 'axis.exe', 'zip')
];

export function axisCliArchiveName(version, releaseTarget) {
  return `axis-cli-${version}-${releaseTarget.id}.${releaseTarget.archiveExtension}`;
}

export function axisCliPayloadEntries(root, releaseTarget = releaseTargetForHost()) {
  return [
    { from: join(root, 'skills'), to: 'skills', recursive: true },
    { from: join(root, 'apps/web/dist'), to: 'web', recursive: true },
    ...sharpPayloadPackages(releaseTarget).map((packageName) => nodeModulePayloadEntry(root, packageName))
  ];
}

export async function packageAxisCliRelease({ all = false, outDir = join(workspaceRoot, 'release', 'axis-cli') } = {}) {
  const version = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')).version;
  const selectedTargets = all ? axisCliReleaseTargets : axisCliReleaseTargets.filter((releaseTarget) => releaseTarget.id === hostTargetId());
  if (selectedTargets.length === 0) {
    throw new Error(`No AXIS CLI release target for ${process.platform}-${process.arch}.`);
  }

  await execFileAsync(pnpmExecutable(), ['--filter', '@axis/web', 'build'], { cwd: workspaceRoot });

  const buildRoot = join(workspaceRoot, 'build', 'axis-cli-release');
  const bundlePath = join(buildRoot, 'axis-cli.cjs');
  await rm(buildRoot, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [join(workspaceRoot, 'apps/axis-cli/src/index.ts')],
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
      '--public-packages',
      '*'
    ], { cwd: workspaceRoot });
    const payloadDir = join(buildRoot, releaseTarget.id, 'payload');
    await mkdir(payloadDir, { recursive: true });
    await cp(executablePath, join(payloadDir, releaseTarget.executableName));
    for (const entry of axisCliPayloadEntries(workspaceRoot, releaseTarget)) {
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
    const archiveName = axisCliArchiveName(version, releaseTarget);
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
  const targetItem = axisCliReleaseTargets.find((releaseTarget) => releaseTarget.id === hostTargetId());
  if (!targetItem) {
    throw new Error(`No AXIS CLI release target for ${process.platform}-${process.arch}.`);
  }
  return targetItem;
}

function nodeModulePayloadEntry(root, packageName) {
  return {
    from: join(root, 'node_modules', ...packageName.split('/')),
    to: `node_modules/${packageName}`,
    recursive: true,
    dereference: true,
    ...(packageName === 'sharp' ? { excludeNestedNodeModules: true } : {})
  };
}

function sharpPayloadPackages(releaseTarget) {
  const nativePackages = {
    'darwin-arm64': ['@img/sharp-darwin-arm64', '@img/sharp-libvips-darwin-arm64'],
    'darwin-x64': ['@img/sharp-darwin-x64', '@img/sharp-libvips-darwin-x64'],
    'linux-arm64': ['@img/sharp-linux-arm64', '@img/sharp-libvips-linux-arm64'],
    'linux-x64': ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64'],
    'windows-arm64': ['@img/sharp-win32-arm64', '@img/sharp-libvips-win32-arm64'],
    'windows-x64': ['@img/sharp-win32-x64', '@img/sharp-libvips-win32-x64']
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
  packageAxisCliRelease({ all })
    .then((result) => {
      console.log(`Packaged AXIS CLI assets in ${result.outDir}`);
      console.log(`Targets: ${result.targets.join(', ')}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
