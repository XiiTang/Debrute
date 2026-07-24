import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MACOS_RUNTIME_APP_NAME,
  MACOS_RUNTIME_EXECUTABLE,
  assembleMacosRuntimeApplication
} from './macos-runtime-app.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supportedPlatforms = new Set(['darwin', 'win32']);

export async function assembleProductSeed(input = {}) {
  const root = resolve(input.workspaceRoot ?? workspaceRoot);
  const platform = input.platform ?? process.platform;
  const architecture = input.architecture ?? process.arch;
  const destination = resolve(input.destination ?? join(root, 'apps/desktop/dist-electron/product-seed'));
  await rm(destination, { recursive: true, force: true });
  if (!supportedPlatforms.has(platform)) {
    await mkdir(destination, { recursive: true });
    await writeFile(
      join(destination, 'UNSUPPORTED_PLATFORM.txt'),
      'Debrute Runtime Product is supported only on macOS and Windows.\n',
      'utf8'
    );
    return { supported: false, destination };
  }
  if (architecture !== 'arm64' && architecture !== 'x64') {
    throw new Error(`Unsupported Product architecture: ${architecture}`);
  }
  if (platform === 'win32' && architecture !== 'x64') {
    throw new Error(`Unsupported Windows Product architecture: ${architecture}`);
  }

  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = requiredString(packageJson.version, 'root package version');
  const executableSuffix = platform === 'win32' ? '.exe' : '';
  const binaryRoot = resolve(input.binaryRoot ?? join(root, 'target/release'));
  const runtimePath = join(binaryRoot, `debrute-runtime${executableSuffix}`);
  const cliPath = join(binaryRoot, `debrute${executableSuffix}`);
  await requireNonEmptyFile(runtimePath, 'Rust Runtime');
  await requireNonEmptyFile(cliPath, 'Rust CLI');

  await mkdir(destination, { recursive: true });
  if (platform === 'win32') {
    await copyFile(runtimePath, join(destination, 'runtime/debrute-runtime.exe'));
  }
  await copyFile(cliPath, join(destination, `runtime/debrute${executableSuffix}`));
  const nativeRasterRoot = join(binaryRoot, 'native-raster');
  const nativeRasterFiles = await readdir(nativeRasterRoot, { withFileTypes: true });
  if (nativeRasterFiles.length === 0 || nativeRasterFiles.some((entry) => !entry.isFile())) {
    throw new Error(`Native raster payload is unavailable: ${nativeRasterRoot}`);
  }
  for (const required of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'versions.json']) {
    if (!nativeRasterFiles.some((entry) => entry.name === required)) {
      throw new Error(`Native raster payload is missing ${required}: ${nativeRasterRoot}`);
    }
  }
  if (platform === 'darwin') {
    await assembleMacosRuntimeApplication({
      destination: join(destination, 'runtime', MACOS_RUNTIME_APP_NAME),
      runtimeBinary: runtimePath,
      nativeRasterRoot,
      icon: join(root, 'apps/desktop/build/icon.icns'),
      version
    });
    await chmod(join(destination, 'runtime/debrute'), 0o755);
  } else {
    for (const entry of nativeRasterFiles) {
      await copyFile(join(nativeRasterRoot, entry.name), join(destination, 'runtime', entry.name));
    }
  }
  await cp(resolve(input.webRoot ?? join(root, 'apps/desktop/dist')), join(destination, 'web'), {
    recursive: true,
    dereference: true
  });
  await cp(join(root, 'skills'), join(destination, 'skills'), { recursive: true, dereference: true });
  await copyModelDocs(root, destination);
  await mkdir(join(destination, 'native-workers'), { recursive: true });
  await writeFile(join(destination, 'native-workers/manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    workers: []
  }, null, 2)}\n`, 'utf8');

  const protocolSource = await readFile(join(root, 'apps/runtime/src/control/protocol.rs'), 'utf8');
  const controlProtocol = capture(protocolSource, /pub const CONTROL_PROTOCOL: &str = "([^"]+)";/, 'Control protocol');
  const controlProtocolVersion = Number(capture(
    protocolSource,
    /pub const CONTROL_PROTOCOL_VERSION: u32 = (\d+);/,
    'Control protocol version'
  ));
  const files = await inventory(destination);
  const entrypoints = platform === 'win32'
    ? {
        runtime: 'runtime/debrute-runtime.exe',
        web: 'web/index.html',
        cli: 'runtime/debrute.exe',
        skills: 'skills/debrute-core/SKILL.md',
        modelDocs: 'model-docs/models.json',
        nativeWorkers: 'native-workers/manifest.json'
      }
    : {
        runtime: `runtime/${MACOS_RUNTIME_APP_NAME}/${MACOS_RUNTIME_EXECUTABLE}`,
        web: 'web/index.html',
        cli: 'runtime/debrute',
        skills: 'skills/debrute-core/SKILL.md',
        modelDocs: 'model-docs/models.json',
        nativeWorkers: 'native-workers/manifest.json'
      };
  for (const entrypoint of Object.values(entrypoints)) {
    if (!files.some((file) => file.path === entrypoint)) {
      throw new Error(`Product entrypoint is missing: ${entrypoint}`);
    }
  }
  const manifest = {
    schemaVersion: 1,
    product: 'debrute',
    productVersion: version,
    controlProtocol,
    controlProtocolVersion,
    platform: platform === 'darwin' ? 'macos' : 'windows',
    architecture,
    entrypoints,
    files
  };
  await writeFile(join(destination, 'product-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { supported: true, destination, manifest };
}

export async function refreshProductSeedManifest(destination) {
  const root = resolve(destination);
  const manifestPath = join(root, 'product-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files = await inventory(root);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function copyModelDocs(root, destination) {
  await mkdir(join(destination, 'model-docs'), { recursive: true });
  await copyFile(join(root, 'assets/runtime-model-catalog.json'), join(destination, 'model-docs/models.json'));
  await cp(
    join(root, 'assets/model-docs/snapshots'),
    join(destination, 'model-docs/snapshots'),
    { recursive: true, dereference: true }
  );
}

async function copyFile(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { dereference: true });
}

async function inventory(root) {
  const paths = [];
  await collectFiles(root, root, paths);
  return await Promise.all(paths.sort().map(async (path) => {
    const bytes = await readFile(join(root, path));
    return {
      path,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    };
  }));
}

async function collectFiles(root, directory, paths) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Product seed may not contain symlinks: ${path}`);
    }
    if (entry.isDirectory()) {
      await collectFiles(root, path, paths);
    } else if (entry.isFile()) {
      const productPath = relative(root, path).split(sep).join('/');
      if (productPath !== 'product-manifest.json') {
        paths.push(productPath);
      }
    } else {
      throw new Error(`Product seed contains an unsupported entry: ${path}`);
    }
  }
}

async function requireNonEmptyFile(path, label) {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size === 0) {
    throw new Error(`${label} is unavailable: ${path}`);
  }
}

function capture(source, pattern, label) {
  const value = pattern.exec(source)?.[1];
  if (!value) {
    throw new Error(`${label} is unavailable.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function isDirectCliInvocation(moduleUrl, argvPath) {
  if (!argvPath) return false;
  return resolve(fileURLToPath(moduleUrl)) === resolve(argvPath);
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  assembleProductSeed().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
