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
const releaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const manifestKeys = [
  'architecture',
  'controlProtocol',
  'controlProtocolVersion',
  'entrypoints',
  'files',
  'platform',
  'product',
  'productVersion',
  'schemaVersion'
];
const entrypointKeys = ['cli', 'modelDocs', 'nativeWorkers', 'runtime', 'skills', 'web'];
const manifestFileKeys = ['path', 'sha256', 'sizeBytes'];
const requiredProductComponents = ['runtime', 'web', 'skills', 'model-docs', 'native-workers'];

export async function assembleProductSeed(input = {}) {
  const root = resolve(input.workspaceRoot ?? workspaceRoot);
  const platform = input.platform ?? process.platform;
  const architecture = input.architecture ?? process.arch;
  if (!supportedPlatforms.has(platform)) {
    throw new Error(`Unsupported Product platform: ${platform}`);
  }
  if (architecture !== 'arm64' && architecture !== 'x64') {
    throw new Error(`Unsupported Product architecture: ${architecture}`);
  }
  if (platform === 'win32' && architecture !== 'x64') {
    throw new Error(`Unsupported Windows Product architecture: ${architecture}`);
  }
  const destination = resolve(input.destination ?? join(root, 'apps/desktop/dist-electron/product-seed'));
  await rm(destination, { recursive: true, force: true });

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
  await cp(resolve(input.webRoot ?? join(root, 'apps/web/dist')), join(destination, 'web'), {
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

  const { controlProtocol, controlProtocolVersion } = await readControlProtocol(root);
  const files = await inventory(destination);
  const entrypoints = productEntrypoints(platform === 'darwin' ? 'macos' : 'windows');
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
  return { destination, manifest };
}

export async function refreshProductSeedManifest(destination) {
  const root = resolve(destination);
  const manifestPath = join(root, 'product-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files = await inventory(root);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export async function validateProductSeed(destination, input = {}) {
  const root = resolve(destination);
  const manifest = JSON.parse(await readFile(join(root, 'product-manifest.json'), 'utf8'));
  const invalid = (detail) => {
    throw new Error(`Product seed manifest is invalid (${detail}): ${root}`);
  };
  assertExactKeys(manifest, manifestKeys, 'root fields', invalid);
  if (manifest.schemaVersion !== 1) invalid('schemaVersion');
  if (manifest.product !== 'debrute') invalid('product');
  if (typeof manifest.productVersion !== 'string' || !releaseVersionPattern.test(manifest.productVersion)) {
    invalid('productVersion');
  }
  const { controlProtocol, controlProtocolVersion } = await readControlProtocol(
    resolve(input.workspaceRoot ?? workspaceRoot)
  );
  if (
    manifest.controlProtocol !== controlProtocol
    || manifest.controlProtocolVersion !== controlProtocolVersion
  ) {
    invalid('control protocol');
  }
  if (!['macos', 'windows'].includes(manifest.platform)) invalid('platform');
  if (!['arm64', 'x64'].includes(manifest.architecture)) invalid('architecture');
  if (manifest.platform === 'windows' && manifest.architecture !== 'x64') {
    invalid('platform architecture');
  }

  assertExactKeys(manifest.entrypoints, entrypointKeys, 'entrypoints', invalid);
  const expectedEntrypoints = productEntrypoints(manifest.platform);
  if (entrypointKeys.some((key) => manifest.entrypoints[key] !== expectedEntrypoints[key])) {
    invalid('entrypoints');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) invalid('files');
  const declaredPaths = new Set();
  const components = new Set();
  for (const file of manifest.files) {
    assertExactKeys(file, manifestFileKeys, 'file fields', invalid);
    if (!isProductPath(file.path) || declaredPaths.has(file.path)) invalid('file path');
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) invalid('file size');
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      invalid('file digest');
    }
    declaredPaths.add(file.path);
    components.add(file.path.split('/')[0]);
  }
  if (requiredProductComponents.some((component) => !components.has(component))) {
    invalid('required components');
  }
  if (Object.values(manifest.entrypoints).some((entrypoint) => !declaredPaths.has(entrypoint))) {
    invalid('missing entrypoint');
  }
  const files = await inventory(root);
  const actualByPath = new Map(files.map((file) => [file.path, file]));
  if (
    files.length !== manifest.files.length
    || manifest.files.some((file) => JSON.stringify(actualByPath.get(file.path)) !== JSON.stringify(file))
  ) {
    throw new Error(`Product seed inventory does not match its manifest: ${root}`);
  }
  if (manifest.platform === 'macos') {
    for (const entrypoint of [manifest.entrypoints.runtime, manifest.entrypoints.cli]) {
      if (((await stat(join(root, entrypoint))).mode & 0o111) === 0) {
        invalid(`non-executable entrypoint ${entrypoint}`);
      }
    }
  }
  return manifest;
}

function productEntrypoints(platform) {
  return platform === 'windows'
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
}

function assertExactKeys(value, expected, label, invalid) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)
  ) {
    invalid(label);
  }
}

function isProductPath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && path !== 'product-manifest.json'
    && path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

async function readControlProtocol(root) {
  const protocolSource = await readFile(join(root, 'apps/runtime/src/control/protocol.rs'), 'utf8');
  return {
    controlProtocol: capture(
      protocolSource,
      /pub const CONTROL_PROTOCOL: &str = "([^"]+)";/,
      'Control protocol'
    ),
    controlProtocolVersion: Number(capture(
      protocolSource,
      /pub const CONTROL_PROTOCOL_VERSION: u32 = (\d+);/,
      'Control protocol version'
    ))
  };
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
