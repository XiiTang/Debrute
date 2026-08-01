import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(
  join(root, 'assets/wasm/canvas-text-font-subset.lock.json'),
  'utf8'
));

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The locked Canvas text font subset build requires Apple Silicon macOS.');
}

const buildRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-text-font-subset-'));
try {
  const sourceRoot = join(buildRoot, 'src');
  const objectRoot = join(buildRoot, 'objects');
  const toolchainRoot = join(buildRoot, 'toolchain');
  await Promise.all([mkdir(sourceRoot), mkdir(objectRoot), mkdir(toolchainRoot)]);
  const inputs = [
    ['harfbuzz', lock.inputs.harfbuzz, 'tar.gz'],
    ['woff2', lock.inputs.woff2, 'tar.gz'],
    ['brotli', lock.inputs.brotli, 'tar.gz'],
    ['emscripten', {
      url: lock.inputs.emscripten.darwinArm64Url,
      sha256: lock.inputs.emscripten.darwinArm64Sha256
    }, 'tar.xz']
  ];
  for (const [name, input, extension] of inputs) {
    const archive = join(buildRoot, `${name}.${extension}`);
    await downloadVerified(input.url, input.sha256, archive);
    if (name === 'emscripten') {
      run('tar', ['-xJf', archive, '-C', toolchainRoot]);
    } else {
      const target = join(sourceRoot, name);
      await mkdir(target);
      run('tar', ['-xzf', archive, '--strip-components=1', '-C', target]);
    }
  }

  const wrapper = join(buildRoot, basename(lock.inputs.wrapper.path));
  const configOverride = join(buildRoot, basename(lock.inputs.configOverride.path));
  await Promise.all([
    copyFile(join(root, lock.inputs.wrapper.path), wrapper),
    copyFile(join(root, lock.inputs.configOverride.path), configOverride)
  ]);
  process.env.PATH = `${join(toolchainRoot, 'install/bin')}:${process.env.PATH ?? ''}`;
  const emscriptenRoot = join(toolchainRoot, 'install/emscripten');
  const brotliRoot = join(sourceRoot, 'brotli');
  const brotliSources = [
    'c/common/dictionary.c', 'c/common/transform.c', 'c/dec/bit_reader.c',
    'c/dec/decode.c', 'c/dec/huffman.c', 'c/dec/state.c',
    'c/enc/backward_references.c', 'c/enc/backward_references_hq.c',
    'c/enc/bit_cost.c', 'c/enc/block_splitter.c', 'c/enc/brotli_bit_stream.c',
    'c/enc/cluster.c', 'c/enc/compress_fragment.c',
    'c/enc/compress_fragment_two_pass.c', 'c/enc/dictionary_hash.c',
    'c/enc/encode.c', 'c/enc/encoder_dict.c', 'c/enc/entropy_encode.c',
    'c/enc/histogram.c', 'c/enc/literal_cost.c', 'c/enc/memory.c',
    'c/enc/metablock.c', 'c/enc/static_dict.c', 'c/enc/utf8_util.c'
  ];
  const brotliObjects = [];
  for (const source of brotliSources) {
    const object = join(objectRoot, `${basename(source, '.c')}.o`);
    run(join(emscriptenRoot, 'emcc'), [
      ...expandBuildRootFlags(lock.build.cFlags),
      `-I${join(brotliRoot, 'c/include')}`,
      `-I${brotliRoot}`,
      '-c', join(brotliRoot, source), '-o', object
    ]);
    brotliObjects.push(object);
  }
  const harfbuzzRoot = join(sourceRoot, 'harfbuzz');
  const woff2Root = join(sourceRoot, 'woff2');
  const output = join(buildRoot, basename(lock.artifact.path));
  run(join(emscriptenRoot, 'em++'), [
    ...expandBuildRootFlags(lock.build.cxxFlags),
    `-I${buildRoot}`,
    `-I${join(harfbuzzRoot, 'src')}`,
    `-I${join(woff2Root, 'include')}`,
    `-I${join(woff2Root, 'src')}`,
    `-I${join(brotliRoot, 'c/include')}`,
    `-I${brotliRoot}`,
    wrapper,
    join(harfbuzzRoot, 'src/harfbuzz-subset.cc'),
    ...[
      'table_tags.cc', 'variable_length.cc', 'woff2_common.cc', 'woff2_dec.cc',
      'woff2_out.cc', 'font.cc', 'glyph.cc', 'normalize.cc', 'transform.cc', 'woff2_enc.cc'
    ].map((source) => join(woff2Root, 'src', source)),
    ...brotliObjects,
    ...lock.build.linkFlags,
    '-o', output
  ]);
  const bytes = await readFile(output);
  const actualHash = sha256(bytes);
  if (actualHash !== lock.artifact.sha256 || bytes.byteLength !== lock.artifact.bytes) {
    const retained = join(process.cwd(), basename(output));
    await writeFile(retained, bytes);
    throw new Error(
      `Rebuilt artifact differs from lock (sha256 ${actualHash}, ${bytes.byteLength} bytes). `
      + `Candidate retained at ${retained}.`
    );
  }
  await copyFile(output, join(root, lock.artifact.path));
  console.log(`Rebuilt ${lock.artifact.path} with locked hash ${actualHash}.`);
} finally {
  await rm(buildRoot, { recursive: true, force: true });
}

async function downloadVerified(url, expectedHash, output) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualHash = sha256(bytes);
  if (actualHash !== expectedHash) {
    throw new Error(`Download hash mismatch for ${url}: expected ${expectedHash}, received ${actualHash}.`);
  }
  await writeFile(output, bytes);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status ?? 'signal'}): ${command}`);
  }
}

function expandBuildRootFlags(flags) {
  return flags.map((flag) => flag.replaceAll('<build-root>', buildRoot));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
