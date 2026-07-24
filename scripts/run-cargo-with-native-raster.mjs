import { spawn } from 'node:child_process';

import { prepareNativeRasterPayload } from './native-raster-payload.mjs';
import { ensureNativeRasterPayload } from './prepare-native-raster.mjs';

const separator = process.argv.indexOf('--');
const arguments_ = separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1);
if (arguments_.length === 0) {
  throw new Error('A Cargo command is required.');
}
const profile = arguments_.includes('--release') ? 'release' : 'debug';
await ensureNativeRasterPayload();
const env = await prepareNativeRasterPayload({ profile });
const child = spawn('cargo', arguments_, {
  cwd: process.cwd(),
  env,
  stdio: 'inherit'
});
const exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', resolveExit);
});
process.exit(exitCode ?? 1);
