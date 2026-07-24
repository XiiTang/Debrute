#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import {
  RuntimeControlError,
  connectRuntimeControl
} from '@debrute/runtime-control-client';
import { packageManagerCommand } from './package-manager-command.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(workspaceRoot, 'build', `browser-verification-project-${process.pid}`);
const fixtureHome = join(fixtureRoot, '.home');
const fixtureTemporaryDirectory = join(fixtureRoot, '.tmp');
const fixtureProjectId = randomUUID();
const fixtureTextPath = 'notes/browser-verification.md';
const fixtureImagePath = 'images/browser-verification.png';
const fixtureCanvasId = 'canvas-1';
const fixtureImageWidth = 4096;
const fixtureImageHeight = 3072;
const productVersion = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8')).version;

async function main() {
  await writeFixtureProject();
  const runtime = startWorkbenchRuntime();
  let browser;
  let context;
  let page;
  let verificationError;
  try {
    const launchUrl = await runtime.launchUrl;
    const projectOpenUrl = projectOpenUrlForOrigin(launchUrl, fixtureRoot);
    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
    await runViewportVerification(context, page, { launchUrl, projectOpenUrl }, { width: 1440, height: 900 }, 'desktop', 420, true);
    await page.close();
    page = await context.newPage();
    await runViewportVerification(context, page, { projectOpenUrl }, { width: 390, height: 844 }, 'narrow', 0, false);
  } catch (error) {
    verificationError = error;
    if (page) {
      console.error(`Browser verification failed at ${page.url()}`);
      console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 4000));
    }
  } finally {
    await page?.close();
    await context?.close();
    await browser?.close();
    try {
      await runtime.stop();
    } catch (error) {
      verificationError = verificationError
        ? new AggregateError([verificationError, error], 'Browser verification and Runtime cleanup failed.')
        : error;
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }
  if (verificationError) {
    throw verificationError;
  }
}

async function writeFixtureProject() {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(join(fixtureRoot, 'notes'), { recursive: true });
  await mkdir(join(fixtureRoot, 'images'), { recursive: true });
  await mkdir(fixtureHome, { recursive: true });
  await mkdir(fixtureTemporaryDirectory, { recursive: true });
  await mkdir(join(fixtureRoot, '.debrute', 'canvases'), { recursive: true });
  await mkdir(join(fixtureRoot, '.debrute', 'canvas-maps'), { recursive: true });
  await mkdir(join(fixtureRoot, '.debrute', 'reviews'), { recursive: true });

  const lines = Array.from(
    { length: 80 },
    (_, index) => `Line ${String(index + 1).padStart(3, '0')} - browser verification text viewport content.`
  );
  await writeFile(join(fixtureRoot, fixtureTextPath), `# Browser Verification\n\n${lines.join('\n')}\n`, 'utf8');
  await sharp({
    create: {
      width: fixtureImageWidth,
      height: fixtureImageHeight,
      channels: 4,
      background: { r: 32, g: 160, b: 224, alpha: 1 }
    }
  }).png().toFile(join(fixtureRoot, fixtureImagePath));
  await writeJson(join(fixtureRoot, '.debrute', 'project.json'), {
    project: {
      id: fixtureProjectId,
      name: 'browser-verification-project',
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:00.000Z'
    }
  });
  await writeJson(join(fixtureRoot, '.debrute', 'canvases', 'index.json'), {
    canvasOrder: [fixtureCanvasId]
  });
  await writeJson(join(fixtureRoot, '.debrute', 'canvases', `${fixtureCanvasId}.json`), {
    id: fixtureCanvasId,
    name: 'Browser Verification',
    nodeElements: [
      {
        projectRelativePath: fixtureTextPath,
        nodeKind: 'file',
        mediaKind: 'text',
        x: 120,
        y: 80,
        width: 420,
        height: 260,
        z: 0
      },
      {
        projectRelativePath: fixtureImagePath,
        nodeKind: 'file',
        mediaKind: 'image',
        x: 600,
        y: 80,
        width: 512,
        height: 384,
        z: 1
      }
    ],
    annotations: [],
    preferences: {
      showDiagnostics: true
    }
  });
  await writeFile(
    join(fixtureRoot, '.debrute', 'canvas-maps', `${fixtureCanvasId}.yaml`),
    `paths:\n  - ${fixtureTextPath}\n  - ${fixtureImagePath}\n`,
    'utf8'
  );
  await writeJson(join(fixtureRoot, '.debrute', 'reviews', 'canvas-feedback.json'), {
    updatedAt: '2026-07-07T00:00:00.000Z',
    entries: {}
  });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function startWorkbenchRuntime() {
  const command = packageManagerCommand(workspaceRoot, ['dev']);
  const toolHome = process.env.HOME;
  const child = spawn(command.command, command.args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOME: fixtureHome,
      USERPROFILE: fixtureHome,
      TMPDIR: fixtureTemporaryDirectory,
      DEBRUTE_DEV_NO_OPEN: '1',
      DEBRUTE_DEV_STOP_RUNTIME_ON_EXIT: '1',
      ...(toolHome ? {
        CARGO_HOME: process.env.CARGO_HOME ?? join(toolHome, '.cargo'),
        RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(toolHome, '.rustup'),
        COREPACK_HOME: process.env.COREPACK_HOME ?? join(toolHome, '.cache', 'node', 'corepack')
      } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });
  const exited = new Promise((resolveExit) => {
    child.once('exit', resolveExit);
  });
  const launchUrl = new Promise((resolveLaunchUrl, rejectLaunchUrl) => {
    const timer = setTimeout(() => rejectLaunchUrl(new Error('Timed out waiting for Debrute Workbench launch URL.')), 300000);
    let output = '';
    let resolved = false;
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      process.stdout.write(text);
      output += text;
      const match = /Debrute Workbench launch URL: (\S+)/.exec(output);
      if (!resolved && match?.[1]) {
        resolved = true;
        clearTimeout(timer);
        resolveLaunchUrl(match[1]);
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('exit', (code) => {
      if (!resolved && code !== 0) {
        clearTimeout(timer);
        rejectLaunchUrl(new Error(`Debrute Workbench dev runtime exited with code ${code}.`));
      }
    });
  });
  return {
    launchUrl,
    stop: async () => {
      try {
        await stopIsolatedRuntime();
      } finally {
        if (child.exitCode !== null || child.signalCode !== null) {
          await exited;
          return;
        }
        killChildTree(child, 'SIGTERM');
        const killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            killChildTree(child, 'SIGKILL');
          }
        }, 5000);
        await exited;
        clearTimeout(killTimer);
        await ensureChildProcessGroupStopped(child.pid);
      }
    }
  };
}

async function stopIsolatedRuntime() {
  let control;
  try {
    control = await connectRuntimeControl({
      role: 'launcher',
      productVersion,
      temporaryDirectory: fixtureTemporaryDirectory,
      handshakeTimeoutMs: 5000
    });
  } catch (error) {
    if (error instanceof RuntimeControlError && error.code === 'runtime_unavailable') {
      return;
    }
    throw error;
  }
  const stopped = new Promise((resolve) => control.onRuntimeLost(() => resolve()));
  try {
    const response = await control.quitProduct();
    if (response.result !== 'ok') {
      throw new Error(`Isolated Runtime rejected browser-verification shutdown: ${response.result}.`);
    }
    await Promise.race([
      stopped,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('Isolated Runtime did not stop after browser verification.')),
        10000
      ))
    ]);
  } finally {
    control.close();
  }
}

function killChildTree(child, signal) {
  if (process.platform === 'win32') {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function ensureChildProcessGroupStopped(processGroupId) {
  if (process.platform === 'win32') {
    return;
  }
  const deadline = Date.now() + 5000;
  while (processGroupExists(processGroupId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!processGroupExists(processGroupId)) {
    return;
  }
  try {
    process.kill(-processGroupId, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function projectOpenUrlForOrigin(launchUrl, projectRoot) {
  return new URL(`/open?path=${encodeURIComponent(projectRoot)}`, launchUrl).toString();
}

async function runViewportVerification(context, page, urls, viewport, label, targetScrollTop, fullCanvasWorkflow) {
  await page.setViewportSize(viewport);
  const failures = [];
  const requestLog = [];
  const pendingPreviewRequests = new Set();
  const canvasFeedbackLoad = observeCanvasTextResponse(page, (response) => (
    response.request().method() === 'GET'
    && response.url().includes('/canvas-feedback')
    && response.ok()
  ), { timeout: 60000 });
  page.on('request', (request) => {
    if (isCanvasPreviewRequest(request)) {
      pendingPreviewRequests.add(request);
    }
    if (isWorkbenchVerificationRequest(request.url())) {
      requestLog.push(`> ${request.method()} ${request.url()}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !isExpectedUnavailableCapabilityConsole(message)) {
      failures.push(`[${label}] console error: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => failures.push(`[${label}] page error: ${error.message}`));
  page.on('requestfailed', (request) => {
    pendingPreviewRequests.delete(request);
    if (isRequiredNetworkRequest(request) && !isExpectedAbortedPreviewRequest(request)) {
      failures.push(`[${label}] request failed: ${request.url()} ${request.failure()?.errorText ?? ''}`.trim());
    }
  });
  page.on('response', (response) => {
    pendingPreviewRequests.delete(response.request());
    if (isWorkbenchVerificationRequest(response.url())) {
      requestLog.push(`< ${response.status()} ${response.request().method()} ${response.url()}`);
    }
    if (
      response.status() >= 400
      && isRequiredNetworkRequest(response.request())
      && !isExpectedUnavailableCapabilityResponse(response)
    ) {
      failures.push(`[${label}] response failed: ${response.status()} ${response.url()}`);
    }
  });

  try {
    if (urls.launchUrl) {
      await waitForWorkbenchOrigin(context, urls.launchUrl);
      const root = await context.request.get(urls.launchUrl);
      if (root.status() !== 200) {
        throw new Error(`[${label}] stable Workbench root returned ${root.status()} instead of 200.`);
      }
    }
    if (urls.projectOpenUrl) {
      await page.goto(urls.projectOpenUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    }
    await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 60000 });
    await assertWorkbenchChrome(page, label);
    await assertIconButtonsHaveNames(page, label);
    await assertCanvasImageWorkflow(page, label);
    if (fullCanvasWorkflow) {
      await assertCanvasTextWorkflow(page, label, targetScrollTop, requestLog);
      await assertCanvasHoverSurface(page, label, requestLog, canvasFeedbackLoad);
      await assertCanvasImageResolutionWorkflow(page, label);
      await waitForPendingPreviewRequests(pendingPreviewRequests, label);
    } else {
      await assertCanvasTextNodeVisible(page, label);
    }
    if (failures.length > 0) {
      throw new Error(failures.join('\n'));
    }
  } catch (error) {
    const diagnostics = await browserStartupDiagnostics(page);
    throw new Error([
      error instanceof Error ? error.message : String(error),
      ...failures,
      `Request log:\n${requestLog.join('\n') || '(empty)'}`,
      `Browser startup diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`
    ].join('\n'));
  }
  console.log(`[${label}] Workbench launch, chrome, Canvas nodes, icon accessibility${fullCanvasWorkflow ? ', preview handoff, and hover geometry' : ''} passed.`);
}

async function waitForWorkbenchOrigin(context, launchUrl) {
  const rootUrl = new URL('/', launchUrl).toString();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const response = await context.request.get(rootUrl);
      if (response.ok()) {
        return;
      }
    } catch {
      // Vite has not bound its selected development port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for Workbench origin: ${rootUrl}`);
}

function isRequiredNetworkRequest(request) {
  return ['document', 'script', 'stylesheet', 'image', 'xhr', 'fetch', 'websocket'].includes(request.resourceType());
}

function isCanvasPreviewRequest(request) {
  if (request.method() !== 'GET') {
    return false;
  }
  const path = new URL(request.url()).pathname;
  return path.endsWith('/canvas-text-preview') || path.endsWith('/canvas-image-preview');
}

async function waitForPendingPreviewRequests(pending, label) {
  const deadline = Date.now() + 60000;
  while (pending.size > 0 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (pending.size > 0) {
    throw new Error(`[${label}] Canvas preview requests did not settle: ${[...pending].map((request) => request.url()).join(', ')}`);
  }
}

function isExpectedAbortedPreviewRequest(request) {
  const path = new URL(request.url()).pathname;
  return request.failure()?.errorText === 'net::ERR_ABORTED'
    && request.method() === 'GET'
    && (path.endsWith('/canvas-text-preview') || path.endsWith('/canvas-image-preview'));
}

function isExpectedUnavailableCapabilityResponse(response) {
  return response.status() === 503 && new URL(response.url()).pathname === '/api/runtime/product';
}

function isExpectedUnavailableCapabilityConsole(message) {
  return message.text().includes('503 (Service Unavailable)')
    && message.location().url
    && new URL(message.location().url).pathname === '/api/runtime/product';
}

function isWorkbenchVerificationRequest(url) {
  return url.includes('/api/global/events')
    || url.includes('/api/projects/open')
    || url.includes('/text-viewport')
    || url.includes('/canvas-feedback')
    || url.includes('/canvas-image-preview')
    || url.includes('/canvas-text-preview')
    || url.includes('/canvas-text-previews/');
}

function browserStartupDiagnostics(page) {
  return page.evaluate(() => ({
    url: window.location.href,
    resources: performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => url.includes('/api/'))
  }));
}

async function assertCanvasImageWorkflow(page, label) {
  const imageNode = page.locator(
    `[data-canvas-node-kind="file"][data-canvas-media-kind="image"][data-project-relative-path="${fixtureImagePath}"]`
  );
  await imageNode.waitFor({ state: 'visible', timeout: 60000 });
  const preview = imageNode.locator('img');
  await preview.waitFor({ state: 'visible', timeout: 60000 });
  const loaded = await preview.evaluate((image) => image.complete && image.naturalWidth > 0);
  if (!loaded) {
    throw new Error(`[${label}] Canvas image preview did not decode.`);
  }
  if (await imageNode.getByRole('button', { name: 'Retry' }).count() > 0) {
    throw new Error(`[${label}] Canvas image preview exposed a retry error.`);
  }
  console.log(`[${label}] Canvas image preview loaded through the Runtime Project media route.`);
}

async function assertCanvasImageResolutionWorkflow(page, label) {
  const imageNode = page.locator(
    `[data-canvas-node-kind="file"][data-canvas-media-kind="image"][data-project-relative-path="${fixtureImagePath}"]`
  );
  const preview = imageNode.locator('img[data-canvas-image-layer="visible"]');
  const initial = await readCanvasImageResolution(preview);
  if (initial.previewWidth >= fixtureImageWidth || initial.naturalWidth !== initial.previewWidth) {
    throw new Error(
      `[${label}] Initial Canvas image tier was invalid: ${JSON.stringify(initial)}.`
    );
  }

  await imageNode.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    for (let index = 0; index < 32; index += 1) {
      node.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        ctrlKey: true,
        deltaY: -10
      }));
    }
  });
  await page.waitForFunction(
    ({ selector, width }) => {
      const image = document.querySelector(selector);
      return image instanceof HTMLImageElement
        && image.complete
        && image.naturalWidth === width
        && image.dataset.previewWidth === String(width);
    },
    {
      selector: `[data-project-relative-path="${fixtureImagePath}"] img[data-canvas-image-layer="visible"]`,
      width: fixtureImageWidth
    },
    { timeout: 60000 }
  );
  const source = await readCanvasImageResolution(preview);
  if (
    source.previewWidth !== fixtureImageWidth
    || source.naturalWidth !== fixtureImageWidth
    || new URL(source.src).searchParams.get('w') !== String(fixtureImageWidth)
  ) {
    throw new Error(`[${label}] Canvas image did not reach its direct source tier: ${JSON.stringify(source)}.`);
  }
  console.log(
    `[${label}] Canvas image resolution changed from ${initial.naturalWidth}px to the ${source.naturalWidth}px direct source tier.`
  );
}

async function readCanvasImageResolution(preview) {
  await preview.waitFor({ state: 'visible', timeout: 60000 });
  return await preview.evaluate((image) => ({
    naturalWidth: image.naturalWidth,
    previewWidth: Number(image.dataset.previewWidth),
    src: image.currentSrc || image.src
  }));
}

async function assertCanvasTextNodeVisible(page, label) {
  const textNode = page.locator(
    `[data-canvas-node-kind="file"][data-canvas-media-kind="text"][data-project-relative-path="${fixtureTextPath}"]`
  ).first();
  await textNode.waitFor({ state: 'visible', timeout: 60000 });
  if (await textNode.getByText('Text Error', { exact: false }).count() > 0) {
    throw new Error(`[${label}] Canvas text node exposed an error state.`);
  }
  console.log(`[${label}] Canvas text node rendered in the narrow viewport.`);
}

async function assertWorkbenchChrome(page, label) {
  await page.getByTestId('workbench-titlebar').waitFor({ state: 'visible', timeout: 60000 });
  await page.getByTestId('floating-dock').waitFor({ state: 'visible', timeout: 60000 });
  await page.getByTestId('canvas-layer').waitFor({ state: 'visible', timeout: 60000 });
  await page.getByTestId('canvas-minimap-bar').waitFor({ state: 'visible', timeout: 60000 });
  await page.locator('.canvas-card-bar').waitFor({ state: 'visible', timeout: 60000 });

  const dockButtons = page.getByTestId('floating-dock').locator('button');
  const dockButtonCount = await dockButtons.count();
  if (dockButtonCount < 4) {
    throw new Error(`[${label}] FloatingDock expected at least 4 panel buttons, received ${dockButtonCount}.`);
  }
  await dockButtons.nth(1).click();
  await page.getByTestId('floating-panel-inspector').waitFor({ state: 'visible', timeout: 10000 });
  await dockButtons.nth(2).click();
  await page.getByTestId('floating-panel-settings').waitFor({ state: 'visible', timeout: 10000 });
  await dockButtons.nth(2).click();
  await dockButtons.nth(1).click();
  console.log(`[${label}] Workbench launch, title bar, FloatingDock, Settings, Inspector, minimap, and Canvas card bar rendered.`);
}

async function assertIconButtonsHaveNames(page, label) {
  const unnamed = await page.locator('button').evaluateAll((buttons) => (
    buttons
      .filter((button) => button.querySelector('svg') && !button.textContent?.trim() && !button.getAttribute('aria-label'))
      .map((button) => typeof button.className === 'string' && button.className ? button.className : button.outerHTML.slice(0, 120))
  ));
  if (unnamed.length > 0) {
    throw new Error(`[${label}] icon-only buttons missing accessible names: ${unnamed.join(', ')}`);
  }
  console.log(`[${label}] Lucide icon-only controls expose accessible names.`);
}

async function assertCanvasTextWorkflow(page, label, targetScrollTop, requestLog) {
  const textNode = page.locator(`[data-canvas-node-kind="file"][data-canvas-media-kind="text"][data-project-relative-path="${fixtureTextPath}"]`).first();
  await textNode.waitFor({ state: 'visible', timeout: 60000 });
  const textBody = textNode.locator('.canvas-text-body');
  const stackOrderChange = observeCanvasTextResponse(page, (response) => (
    response.request().method() === 'POST'
    && response.url().includes('/node-stack-order/bring-to-front')
    && response.ok()
  ), { timeout: 10000 });
  await clickVisibleElementPoint(page, textBody, label, 'Canvas text body');
  await waitForCanvasTextResponse(
    stackOrderChange,
    page,
    textNode,
    label,
    requestLog,
    'Canvas stack-order mutation'
  );
  await assertCanvasImageWorkflow(page, `${label}: text active`);
  const scroller = textNode.locator('.cm-scroller').first();
  await scroller.waitFor({ state: 'visible', timeout: 60000 });
  const scrollerHandle = await scroller.elementHandle();
  if (!scrollerHandle) {
    throw new Error(`[${label}] CodeMirror scroller was not available.`);
  }
  await page.waitForFunction(
    (element) => element.scrollHeight > element.clientHeight + 300,
    scrollerHandle,
    { timeout: 10000 }
  );
  const committedScrollTop = await scrollCanvasTextEditor(page, scroller, targetScrollTop, label);
  const viewportCommit = observeCanvasTextResponse(page, (response) => (
    response.request().method() === 'PATCH'
    && response.url().includes('/text-viewport')
    && response.ok()
  ), { timeout: 10000 });
  const previewSourceSave = observeCanvasTextResponse(page, (response) => (
    response.request().method() === 'POST'
    && response.url().includes('/canvas-text-previews/source')
    && response.ok()
  ), { timeout: 60000 });
  await clickCanvasSurfaceEmptyPoint(page, textNode, label);
  await waitForCanvasTextResponse(viewportCommit, page, textNode, label, requestLog, 'text viewport PATCH');
  await waitForCanvasTextResponse(previewSourceSave, page, textNode, label, requestLog, 'text preview source save');
  await textNode.locator('.canvas-text-preview-image').waitFor({ state: 'visible', timeout: 60000 });

  await clickVisibleElementPoint(page, textBody, label, 'Canvas text body');
  await scroller.waitFor({ state: 'visible', timeout: 60000 });
  const restoredScrollTop = await scroller.evaluate((element) => element.scrollTop);
  const restoreFloor = committedScrollTop - 120;
  if (restoredScrollTop < restoreFloor) {
    throw new Error(`[${label}] Canvas text scroll did not restore. Expected >= ${restoreFloor}, received ${restoredScrollTop}.`);
  }
  await page.keyboard.press('ArrowDown');
  const afterArrowScrollTop = await scroller.evaluate((element) => element.scrollTop);
  const arrowFloor = committedScrollTop - 170;
  if (afterArrowScrollTop < arrowFloor) {
    throw new Error(`[${label}] Cursor movement reset Canvas text scroll. Expected >= ${arrowFloor}, received ${afterArrowScrollTop}.`);
  }
  console.log(`[${label}] Canvas text scroll restore, preview handoff, and cursor movement passed.`);
}

async function clickVisibleElementPoint(page, locator, label, description) {
  const element = await locator.elementHandle();
  if (!element) {
    throw new Error(`[${label}] ${description} was unavailable.`);
  }
  const point = await visibleElementPoint(page, element);
  if (!point) {
    const diagnostics = await visibleElementPointDiagnostics(page, element);
    throw new Error(`[${label}] ${description} had no visible click point.\n${diagnostics}`);
  }
  await page.mouse.click(point.x, point.y);
}

async function moveToVisibleElementPoint(page, locator, label, description) {
  const element = await locator.elementHandle();
  if (!element) {
    throw new Error(`[${label}] ${description} was unavailable.`);
  }
  const point = await visibleElementPoint(page, element);
  if (!point) {
    const diagnostics = await visibleElementPointDiagnostics(page, element);
    throw new Error(`[${label}] ${description} had no visible hover point.\n${diagnostics}`);
  }
  await page.mouse.move(point.x, point.y);
}

async function visibleElementPoint(page, element) {
  return page.evaluate((target) => {
    const rect = target.getBoundingClientRect();
    const insetX = Math.min(80, Math.max(8, rect.width / 3));
    const insetY = Math.min(80, Math.max(8, rect.height / 3));
    const candidates = [
      { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      { x: rect.left + insetX, y: rect.top + insetY },
      { x: rect.right - insetX, y: rect.top + insetY },
      { x: rect.left + insetX, y: rect.bottom - insetY },
      { x: rect.right - insetX, y: rect.bottom - insetY }
    ];
    return candidates.find((candidate) => {
      if (candidate.x < 0 || candidate.y < 0 || candidate.x > window.innerWidth || candidate.y > window.innerHeight) {
        return false;
      }
      const hit = document.elementFromPoint(candidate.x, candidate.y);
      return hit instanceof Element && (hit === target || target.contains(hit));
    });
  }, element);
}

async function visibleElementPointDiagnostics(page, element) {
  return page.evaluate((target) => {
    const rect = target.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const hit = document.elementFromPoint(center.x, center.y);
    return JSON.stringify({
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      centerHitClassName: hit instanceof HTMLElement ? hit.className : undefined,
      centerHitTagName: hit?.tagName
    }, null, 2);
  }, element);
}

function observeCanvasTextResponse(page, predicate, options) {
  return page.waitForResponse(predicate, options).then(
    () => undefined,
    (error) => error
  );
}

async function waitForCanvasTextResponse(responsePromise, page, textNode, label, requestLog, description) {
  const error = await responsePromise;
  if (error) {
    const diagnostics = await canvasTextDiagnostics(page, textNode);
    const requests = requestLog.length > 0 ? requestLog.join('\n') : '(none)';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[${label}] Timed out waiting for ${description}: ${message}\n${diagnostics}\nCanvas text requests:\n${requests}`);
  }
}

async function scrollCanvasTextEditor(page, scroller, targetScrollTop, label) {
  await scroller.hover();
  let scrollTop = await scroller.evaluate((element) => element.scrollTop);
  for (let attempts = 0; attempts < 16 && scrollTop < targetScrollTop; attempts += 1) {
    await page.mouse.wheel(0, Math.max(160, targetScrollTop - scrollTop));
    await page.waitForTimeout(80);
    scrollTop = await scroller.evaluate((element) => element.scrollTop);
  }
  if (scrollTop < targetScrollTop - 80) {
    throw new Error(`[${label}] Canvas text editor did not reach the target scroll region. Expected >= ${targetScrollTop - 80}, received ${scrollTop}.`);
  }
  return scrollTop;
}

async function canvasTextDiagnostics(page, textNode) {
  return page.evaluate((node) => {
    const scroller = node.querySelector('.cm-scroller');
    const activeElement = document.activeElement;
    return JSON.stringify({
      nodeClassName: node.className,
      selected: node.classList.contains('selected'),
      editorCount: node.querySelectorAll('.canvas-text-editor').length,
      scrollerScrollTop: scroller instanceof HTMLElement ? scroller.scrollTop : undefined,
      scrollerScrollLeft: scroller instanceof HTMLElement ? scroller.scrollLeft : undefined,
      previewImageCount: node.querySelectorAll('.canvas-text-preview-image').length,
      previewEmptyCount: node.querySelectorAll('.canvas-text-preview-empty').length,
      captureTargetCount: document.querySelectorAll('.canvas-text-preview-capture-target').length,
      activeElementClassName: activeElement instanceof HTMLElement ? activeElement.className : undefined,
      activeElementTagName: activeElement?.tagName
    }, null, 2);
  }, await textNode.elementHandle());
}

async function clickCanvasSurfaceEmptyPoint(page, node, label) {
  const nodeElement = await node.elementHandle();
  if (!nodeElement) {
    throw new Error(`[${label}] Canvas text node geometry was unavailable.`);
  }

  const point = await page.evaluate((node) => {
    const surface = document.querySelector('[data-testid="canvas-surface"]');
    if (!(surface instanceof HTMLElement)) {
      return undefined;
    }
    const surfaceBox = surface.getBoundingClientRect();
    const nodeBox = node.getBoundingClientRect();
    const candidates = [
      { x: surfaceBox.left + 16, y: surfaceBox.top + 16 },
      { x: surfaceBox.right - 16, y: surfaceBox.top + 16 },
      { x: surfaceBox.left + 16, y: surfaceBox.bottom - 16 },
      { x: surfaceBox.right - 16, y: surfaceBox.bottom - 16 },
      { x: surfaceBox.left + surfaceBox.width / 2, y: surfaceBox.bottom - 24 },
      { x: surfaceBox.left + surfaceBox.width / 2, y: surfaceBox.top + surfaceBox.height / 2 }
    ];
    return candidates.find((candidate) => {
      const outsideNode = candidate.x < nodeBox.left
        || candidate.x > nodeBox.right
        || candidate.y < nodeBox.top
        || candidate.y > nodeBox.bottom;
      const hit = document.elementFromPoint(candidate.x, candidate.y);
      return outsideNode
        && hit instanceof Element
        && (hit === surface || surface.contains(hit))
        && !node.contains(hit);
    });
  }, nodeElement);
  if (!point) {
    throw new Error(`[${label}] No empty Canvas surface click point was available outside the text node.`);
  }

  await page.mouse.click(point.x, point.y);
  await page.waitForFunction((element) => !element.classList.contains('selected'), nodeElement, { timeout: 5000 });
}

async function assertCanvasHoverSurface(page, label, requestLog, canvasFeedbackLoad) {
  const textNode = page.locator(`[data-canvas-node-kind="file"][data-canvas-media-kind="text"][data-project-relative-path="${fixtureTextPath}"]`).first();
  await textNode.waitFor({ state: 'visible', timeout: 60000 });
  await waitForCanvasTextResponse(canvasFeedbackLoad, page, textNode, label, requestLog, 'Canvas feedback load');
  await clickCanvasSurfaceEmptyPoint(page, textNode, label);
  const feedbackBar = page.locator('.canvas-feedback-bar').first();
  await moveToVisibleElementPoint(page, textNode, label, 'Canvas text node hover target');
  const feedbackBarError = await feedbackBar.waitFor({ state: 'visible', timeout: 10000 }).then(
    () => undefined,
    (error) => error
  );
  if (feedbackBarError) {
    const diagnostics = await hoverDiagnostics(page, textNode);
    const requests = requestLog.length > 0 ? requestLog.join('\n') : '(none)';
    const message = feedbackBarError instanceof Error ? feedbackBarError.message : String(feedbackBarError);
    throw new Error(`[${label}] Timed out waiting for Canvas feedback bar: ${message}\n${diagnostics}\nWorkbench verification requests:\n${requests}`);
  }
  const box = await page.locator('.canvas-feedback-bar:visible').first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }).catch(() => undefined);
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(`[${label}] Canvas feedback bar has no visible geometry.`);
  }
  console.log(`[${label}] Canvas hover and feedback bar geometry passed.`);
}

async function hoverDiagnostics(page, textNode) {
  return page.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + 40, rect.top + 40);
    return JSON.stringify({
      nodeClassName: node.className,
      selected: node.classList.contains('selected'),
      hovered: node.classList.contains('hovered'),
      feedbackBarCount: document.querySelectorAll('.canvas-feedback-bar').length,
      canvasFeedbackBarDataCount: document.querySelectorAll('[data-canvas-feedback-bar="true"]').length,
      hitClassName: hit instanceof HTMLElement ? hit.className : undefined,
      hitTagName: hit?.tagName
    }, null, 2);
  }, await textNode.elementHandle());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
