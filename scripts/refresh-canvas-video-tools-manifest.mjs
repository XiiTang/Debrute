import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canvasVideoToolsIdentity,
  refreshCanvasVideoToolsPayloadManifest
} from './canvas-video-tools-payload.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const identityArgument = process.argv.indexOf('--identity');
const identity = identityArgument >= 0
  ? process.argv[identityArgument + 1]
  : canvasVideoToolsIdentity();
if (!identity) throw new Error('--identity requires a value.');

await refreshCanvasVideoToolsPayloadManifest({
  root: join(workspaceRoot, 'target/release/canvas-video-tools'),
  identity
});
