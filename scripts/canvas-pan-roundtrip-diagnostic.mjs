#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9223';
const DEFAULT_DISTANCE = 1500;
const DEFAULT_SETTLE_MS = 1800;
const DEFAULT_INITIAL_SETTLE_MS = 1800;
const DEFAULT_STEPS = 1;
const DEFAULT_STEP_SETTLE_MS = 48;
const DEFAULT_INPUT_MODE = 'cdp';

export function summarizePanRoundTripResult(result) {
  const before = snapshotByLabel(result, 'before-pan');
  const back = snapshotByLabel(result, 'after-pan-back');
  const beforeKeys = new Set(before.visibleImages.map(visibleImageKey));
  const backKeys = new Set(back.visibleImages.map(visibleImageKey));
  const missingVisibleImagesAfterBack = before.visibleImages
    .filter((image) => !backKeys.has(visibleImageKey(image)))
    .map((image) => ({
      path: image.path,
      src: image.src,
      width: image.width
    }));
  const requestsForBeforeVisibleImages = result.networkRequests
    .filter((request) => beforeKeys.has(visibleImageKey(request)))
    .map((request) => ({
      phase: request.phase,
      path: request.path,
      src: request.src,
      width: request.width,
      status: request.status,
      fromDiskCache: request.fromDiskCache,
      encodedDataLength: request.encodedDataLength
    }));
  const blankVisibleImageNodesAfterBack = [...back.blankVisibleImageNodePaths];
  const nextOnlyImageNodesAfterBack = [...back.nextOnlyImageNodePaths];
  const motionSamples = result.motionSamples ?? [];
  const blankVisibleImageNodesDuringMotion = motionSamples
    .filter((sample) => sample.blankVisibleImageNodePaths.length > 0)
    .map((sample) => ({
      label: sample.label,
      paths: [...sample.blankVisibleImageNodePaths]
    }));
  const nextOnlyImageNodesDuringMotion = motionSamples
    .filter((sample) => sample.nextOnlyImageNodePaths.length > 0)
    .map((sample) => ({
      label: sample.label,
      paths: [...sample.nextOnlyImageNodePaths]
    }));
  const sameVisibleImagesAfterBack = missingVisibleImagesAfterBack.length === 0;
  const passed = sameVisibleImagesAfterBack
    && requestsForBeforeVisibleImages.length === 0
    && blankVisibleImageNodesAfterBack.length === 0
    && blankVisibleImageNodesDuringMotion.length === 0;

  return {
    passed,
    sameVisibleImagesAfterBack,
    missingVisibleImagesAfterBack,
    requestsForBeforeVisibleImages,
    blankVisibleImageNodesAfterBack,
    nextOnlyImageNodesAfterBack,
    blankVisibleImageNodesDuringMotion,
    nextOnlyImageNodesDuringMotion,
    networkByPhase: countBy(result.networkRequests, (request) => request.phase),
    networkByWidth: countBy(result.networkRequests, (request) => String(request.width)),
    imageLayers: Object.fromEntries(result.snapshots.map((snapshot) => [snapshot.label, snapshot.imageLayers]))
  };
}

export function parseCliArgs(argv) {
  const args = {
    cdpUrl: DEFAULT_CDP_URL,
    targetUrl: undefined,
    distance: DEFAULT_DISTANCE,
    settleMs: DEFAULT_SETTLE_MS,
    initialSettleMs: DEFAULT_INITIAL_SETTLE_MS,
    steps: DEFAULT_STEPS,
    stepSettleMs: DEFAULT_STEP_SETTLE_MS,
    inputMode: DEFAULT_INPUT_MODE
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    } else if (arg === '--cdp-url') {
      args.cdpUrl = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === '--target-url' || arg === '--url') {
      args.targetUrl = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === '--distance') {
      args.distance = positiveNumber(requiredValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--settle-ms') {
      args.settleMs = positiveNumber(requiredValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--initial-settle-ms') {
      args.initialSettleMs = positiveNumber(requiredValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--steps') {
      args.steps = positiveInteger(requiredValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--step-settle-ms') {
      args.stepSettleMs = positiveNumber(requiredValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--input-mode') {
      args.inputMode = inputMode(requiredValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--summary-only') {
      args.summaryOnly = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

export async function runPanRoundTripDiagnostic(options = {}) {
  const cdpUrl = options.cdpUrl ?? DEFAULT_CDP_URL;
  const distance = options.distance ?? DEFAULT_DISTANCE;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const initialSettleMs = options.initialSettleMs ?? DEFAULT_INITIAL_SETTLE_MS;
  const steps = options.steps ?? DEFAULT_STEPS;
  const stepSettleMs = options.stepSettleMs ?? DEFAULT_STEP_SETTLE_MS;
  const inputMode = options.inputMode ?? DEFAULT_INPUT_MODE;
  const client = await connectToPageTarget(cdpUrl, options.targetUrl);
  let phase = 'setup';
  const requestById = new Map();
  const networkRequests = [];

  client.onEvent((message) => {
    if (message.method === 'Network.requestWillBeSent') {
      const preview = parsePreviewRequest(message.params?.request?.url);
      if (!preview) {
        return;
      }
      const record = {
        requestId: message.params.requestId,
        phase,
        ...preview,
        status: undefined,
        fromDiskCache: false,
        encodedDataLength: undefined,
        failed: undefined
      };
      requestById.set(record.requestId, record);
      networkRequests.push(record);
    } else if (message.method === 'Network.responseReceived') {
      const record = requestById.get(message.params.requestId);
      if (record) {
        record.status = message.params.response.status;
        record.fromDiskCache = Boolean(message.params.response.fromDiskCache);
      }
    } else if (message.method === 'Network.loadingFinished') {
      const record = requestById.get(message.params.requestId);
      if (record) {
        record.encodedDataLength = message.params.encodedDataLength;
      }
    } else if (message.method === 'Network.loadingFailed') {
      const record = requestById.get(message.params.requestId);
      if (record) {
        record.failed = message.params.errorText;
      }
    }
  });

  try {
    await client.send('Runtime.enable');
    await waitInPage(client, initialSettleMs);
    await client.send('Network.enable', {
      maxTotalBufferSize: 100000000,
      maxResourceBufferSize: 10000000
    });
    await startCanvasPanRoundTripCapture(client);

    const snapshots = [];
    const motionSamples = [];
    snapshots.push(await capturePageSnapshot(client, 'before-pan'));

    phase = 'pan-away';
    motionSamples.push(...await dispatchCanvasWheelSequence({
      client,
      labelPrefix: 'pan-away',
      distance,
      steps,
      stepSettleMs,
      inputMode,
      setPhase: (nextPhase) => {
        phase = nextPhase;
      }
    }));
    await waitInPage(client, settleMs);
    snapshots.push(await capturePageSnapshot(client, 'after-pan-away'));

    phase = 'pan-back';
    motionSamples.push(...await dispatchCanvasWheelSequence({
      client,
      labelPrefix: 'pan-back',
      distance: -distance,
      steps,
      stepSettleMs,
      inputMode,
      setPhase: (nextPhase) => {
        phase = nextPhase;
      }
    }));
    await waitInPage(client, settleMs);
    snapshots.push(await capturePageSnapshot(client, 'after-pan-back'));

    phase = 'stopped';
    const finalCounterTotals = await client.evaluate(`(() => window.__debruteCanvasPerf.stopCapture().counterTotals ?? {})()`);
    const targetUrl = await client.evaluate('location.href');
    const result = {
      targetUrl,
      distance,
      steps,
      snapshots,
      motionSamples,
      networkRequests: networkRequests.map(stripRequestId),
      finalCounterTotals
    };
    return {
      result,
      summary: summarizePanRoundTripResult(result)
    };
  } finally {
    await client.close();
  }
}

export async function startCanvasPanRoundTripCapture(client) {
  await client.evaluate(`(() => {
    if (!window.__debruteCanvasPerf) {
      throw new Error('window.__debruteCanvasPerf is not available. Start the development Workbench with --canvas-perf and use a main-world CDP target.');
    }
    window.__debruteCanvasPerf.stopCapture();
    performance.clearResourceTimings();
    window.__debruteCanvasPerf.startCapture({ label: 'canvas-pan-roundtrip-diagnostic' });
  })()`);
}

async function connectToPageTarget(cdpUrl, targetUrl) {
  const targets = await fetchJson(`${trimTrailingSlash(cdpUrl)}/json/list`);
  const target = targetUrl
    ? targets.find((item) => item.type === 'page' && String(item.url ?? '').includes(targetUrl))
    : targets.find((item) => item.type === 'page' && String(item.url ?? '').includes('/projects/'))
      ?? targets.find((item) => item.type === 'page');
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No CDP page target found at ${cdpUrl}. Start Chrome with --remote-debugging-port=9223 and open the Debrute project page.`);
  }
  return createCdpClient(target.webSocketDebuggerUrl);
}

function createCdpClient(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const eventHandlers = new Set();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const pendingRequest = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(pendingRequest.timer);
      if (message.error) {
        pendingRequest.reject(new Error(JSON.stringify(message.error)));
      } else {
        pendingRequest.resolve(message.result);
      }
      return;
    }
    for (const handler of eventHandlers) {
      handler(message);
    }
  });

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  return {
    async send(method, params = {}, timeoutMs = 10000) {
      await opened;
      const id = nextId;
      nextId += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for CDP method ${method}.`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
      });
    },
    async evaluate(expression, timeoutMs = 10000) {
      const result = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true
      }, timeoutMs);
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      }
      return result.result.value;
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    async close() {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    }
  };
}

async function capturePageSnapshot(client, label) {
  return client.evaluate(`(() => {
    const capture = window.__debruteCanvasPerf.exportCapture();
    const nodes = [...document.querySelectorAll('[data-canvas-node-path]')];
    const imageNodes = nodes.filter((node) => node.classList.contains('image') || node.querySelector('img[data-canvas-image-layer]'));
    const visibleImageNodePaths = imageNodes
      .filter((node) => getComputedStyle(node).display !== 'none')
      .map((node) => node.dataset.canvasNodePath)
      .filter(Boolean);
    const visibleImages = [...document.querySelectorAll('img[data-canvas-image-layer="visible"]')]
      .map((img) => {
        const node = img.closest('[data-canvas-node-path]');
        const src = img.currentSrc || img.src;
        return {
          path: node?.dataset.canvasNodePath ?? '',
          src,
          width: Number(new URL(src).searchParams.get('w')),
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          display: node ? getComputedStyle(node).display : ''
        };
      })
      .filter((image) => image.path);
    const visibleLayerPaths = new Set(visibleImages.map((image) => image.path));
    const nextImages = [...document.querySelectorAll('img[data-canvas-image-layer="next"]')]
      .map((img) => {
        const node = img.closest('[data-canvas-node-path]');
        const src = img.currentSrc || img.src;
        return {
          path: node?.dataset.canvasNodePath ?? '',
          src,
          width: Number(new URL(src).searchParams.get('w')),
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          display: node ? getComputedStyle(node).display : ''
        };
      })
      .filter((image) => image.path);
    const nextLayerPaths = new Set(nextImages.map((image) => image.path));
    const completeNextLayerPaths = new Set(nextImages
      .filter((image) => image.complete && image.naturalWidth > 0)
      .map((image) => image.path));
    const blankVisibleImageNodePaths = visibleImageNodePaths.filter((path) => !visibleLayerPaths.has(path) && !completeNextLayerPaths.has(path));
    const nextOnlyImageNodePaths = visibleImageNodePaths.filter((path) => nextLayerPaths.has(path) && !visibleLayerPaths.has(path));
    return {
      label: ${JSON.stringify(label)},
      camera: capture.canvas?.camera ?? null,
      imageLayers: capture.canvas?.imageLayers ?? {
        visible: visibleImages.length,
        next: nextLayerPaths.size,
        previewSources: visibleImages.length + nextLayerPaths.size,
        rawSources: 0
      },
      visibleImages,
      nextImages,
      visibleImageNodePaths,
      blankVisibleImageNodePaths,
      nextOnlyImageNodePaths,
      resourceCount: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/canvas-image-preview')).length
    };
  })()`);
}

export async function dispatchCanvasWheelSequence(input) {
  const samples = [];
  const stepDelta = input.distance / input.steps;
  const captureSnapshot = input.captureSnapshot ?? ((label) => capturePageSnapshot(input.client, label));
  for (let step = 1; step <= input.steps; step += 1) {
    const phase = `${input.labelPrefix}-step-${step}`;
    input.setPhase(phase);
    await dispatchCanvasWheel(input.client, stepDelta, input.stepSettleMs, input.inputMode ?? DEFAULT_INPUT_MODE);
    samples.push(await captureSnapshot(phase));
  }
  input.setPhase(input.labelPrefix);
  return samples;
}

async function dispatchCanvasWheel(client, deltaY, settleMs, inputMode) {
  if (inputMode === 'dom') {
    await dispatchCanvasDomWheel(client, deltaY);
    await waitInNode(settleMs);
    return;
  }
  const point = await canvasSurfaceCenterPoint(client);
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY
  });
  await waitInNode(settleMs);
}

async function dispatchCanvasDomWheel(client, deltaY) {
  await client.evaluate(`(() => {
    const surface = document.querySelector('.canvas-surface');
    if (!surface) {
      throw new Error('No .canvas-surface element found.');
    }
    const rect = surface.getBoundingClientRect();
    surface.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      deltaY: ${JSON.stringify(deltaY)}
    }));
  })()`);
}

async function canvasSurfaceCenterPoint(client) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const surface = document.querySelector('.canvas-surface');
      if (!surface) {
        throw new Error('No .canvas-surface element found.');
      }
      const rect = surface.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    })()`,
    returnByValue: true,
    awaitPromise: false,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  const point = result.result?.value;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error('Unable to resolve the canvas surface center point.');
  }
  return point;
}

async function waitInPage(client, settleMs) {
  await client.evaluate(`new Promise((resolve) => setTimeout(resolve, ${JSON.stringify(settleMs)}))`, settleMs + 5000);
}

async function waitInNode(settleMs) {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
}

function parsePreviewRequest(url) {
  if (!url || !url.includes('/canvas-image-preview')) {
    return undefined;
  }
  const parsed = new URL(url);
  return {
    src: url,
    path: parsed.searchParams.get('path') ?? '',
    width: Number(parsed.searchParams.get('w') ?? 0)
  };
}

function stripRequestId(request) {
  const { requestId: _requestId, ...rest } = request;
  return rest;
}

function snapshotByLabel(result, label) {
  const snapshot = result.snapshots.find((item) => item.label === label);
  if (!snapshot) {
    throw new Error(`Missing diagnostic snapshot: ${label}`);
  }
  return snapshot;
}

function visibleImageKey(input) {
  return `${input.path}\u001f${input.src}`;
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed ${response.status}: ${url}`);
  }
  return response.json();
}

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function positiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${flag} must be a positive number.`);
  }
  return number;
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || !Number.isInteger(number)) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return number;
}

function inputMode(value, flag) {
  if (value !== 'cdp' && value !== 'dom') {
    throw new Error(`${flag} must be one of: cdp, dom.`);
  }
  return value;
}

function usage() {
  return `Usage:
  pnpm dev:electron -- --canvas-perf
  node scripts/canvas-pan-roundtrip-diagnostic.mjs --target-url 'http://127.0.0.1:17322/projects/<id>'

The target development Workbench must be started with --canvas-perf so its
Project pages register window.__debruteCanvasPerf. Production builds do not
expose the probe.

Options:
  --cdp-url <url>       Chrome DevTools Protocol HTTP URL. Default: ${DEFAULT_CDP_URL}
  --target-url <url>    Debrute page URL or unique URL substring. Defaults to the first /projects/ page.
  --distance <px>       Wheel delta used for pan-away and pan-back. Default: ${DEFAULT_DISTANCE}
  --settle-ms <ms>      Wait after each wheel event before sampling. Default: ${DEFAULT_SETTLE_MS}
  --initial-settle-ms <ms>
                       Wait before starting capture so initial page loads do not pollute the run. Default: ${DEFAULT_INITIAL_SETTLE_MS}
  --steps <count>       Split each pan leg into sampled wheel steps. Default: ${DEFAULT_STEPS}
  --step-settle-ms <ms> Wait after each sampled wheel step. Default: ${DEFAULT_STEP_SETTLE_MS}
  --input-mode <mode>   Wheel dispatch mode: cdp or dom. Default: ${DEFAULT_INPUT_MODE}
  --summary-only        Print only the pass/fail summary.
`;
}

async function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const output = await runPanRoundTripDiagnostic(args);
  console.log(JSON.stringify(args.summaryOnly ? output.summary : output, null, 2));
  if (!output.summary.passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
