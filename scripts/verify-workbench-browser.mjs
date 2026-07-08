#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { packageManagerCommand } from './package-manager-command.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(workspaceRoot, 'build', 'browser-verification-project');
const fixtureHome = join(fixtureRoot, '.home');
const fixtureTextPath = 'notes/browser-verification.md';
const fixtureCanvasId = 'canvas-1';

async function main() {
  await writeFixtureProject();
  const runtime = startWorkbenchRuntime();
  let browser;
  let context;
  try {
    const launchUrl = await runtime.launchUrl;
    const projectLaunchUrl = withProjectOpenNext(launchUrl, fixtureRoot);
    const projectOpenUrl = projectOpenUrlForOrigin(launchUrl, fixtureRoot);
    browser = await chromium.launch();
    context = await browser.newContext();
    await runViewportVerification(context, projectLaunchUrl, { width: 1440, height: 900 }, 'desktop', 420);
    await runViewportVerification(context, projectOpenUrl, { width: 390, height: 844 }, 'narrow', 620);
  } finally {
    await context?.close();
    await browser?.close();
    await runtime.stop();
  }
}

async function writeFixtureProject() {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(join(fixtureRoot, 'notes'), { recursive: true });
  await mkdir(fixtureHome, { recursive: true });
  await mkdir(join(fixtureRoot, '.debrute', 'canvases'), { recursive: true });
  await mkdir(join(fixtureRoot, '.debrute', 'canvas-maps'), { recursive: true });
  await mkdir(join(fixtureRoot, '.debrute', 'reviews'), { recursive: true });

  const lines = Array.from(
    { length: 160 },
    (_, index) => `Line ${String(index + 1).padStart(3, '0')} - browser verification text viewport content.`
  );
  await writeFile(join(fixtureRoot, fixtureTextPath), `# Browser Verification\n\n${lines.join('\n')}\n`, 'utf8');
  await writeJson(join(fixtureRoot, '.debrute', 'project.json'), {
    project: {
      id: '00000000-0000-4000-8000-000000000001',
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
    nodeElements: [{
      projectRelativePath: fixtureTextPath,
      nodeKind: 'file',
      mediaKind: 'text',
      x: 120,
      y: 80,
      width: 420,
      height: 260,
      z: 0
    }],
    annotations: [],
    preferences: {
      showDiagnostics: true
    }
  });
  await writeFile(join(fixtureRoot, '.debrute', 'canvas-maps', `${fixtureCanvasId}.yaml`), `paths:\n  - ${fixtureTextPath}\n`, 'utf8');
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
  const child = spawn(command.command, command.args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOME: fixtureHome,
      USERPROFILE: fixtureHome,
      ...sourceDevProductEnv()
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = new Promise((resolveExit) => {
    child.once('exit', resolveExit);
  });
  const launchUrl = new Promise((resolveLaunchUrl, rejectLaunchUrl) => {
    const timer = setTimeout(() => rejectLaunchUrl(new Error('Timed out waiting for Debrute Workbench launch URL.')), 120000);
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
      if (child.exitCode !== null || child.signalCode !== null) {
        await exited;
        return;
      }
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 5000);
      await exited;
      clearTimeout(killTimer);
    }
  };
}

function sourceDevProductEnv() {
  return {
    DEBRUTE_DAEMON_PRODUCT_VERSION: readRootProductVersion(),
    DEBRUTE_DAEMON_CLI_PATH: join(workspaceRoot, 'apps/debrute-cli/src/index.ts'),
    DEBRUTE_DAEMON_SKILLS_PAYLOAD_DIR: join(workspaceRoot, 'skills')
  };
}

function readRootProductVersion() {
  const packageJsonPath = join(workspaceRoot, 'package.json');
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (!isRecord(parsed) || typeof parsed.version !== 'string' || parsed.version.trim() === '') {
    throw new Error(`Invalid Debrute root package version: ${packageJsonPath}.`);
  }
  return parsed.version;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withProjectOpenNext(launchUrl, projectRoot) {
  const url = new URL(launchUrl);
  url.searchParams.set('next', `/open?path=${encodeURIComponent(projectRoot)}`);
  return url.toString();
}

function projectOpenUrlForOrigin(launchUrl, projectRoot) {
  return new URL(`/open?path=${encodeURIComponent(projectRoot)}`, launchUrl).toString();
}

async function runViewportVerification(context, url, viewport, label, targetScrollTop) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  const failures = [];
  const requestLog = [];
  const canvasFeedbackLoad = observeCanvasTextResponse(page, (response) => (
    response.request().method() === 'GET'
    && response.url().includes('/canvas-feedback')
    && response.ok()
  ), { timeout: 60000 });
  page.on('request', (request) => {
    if (isWorkbenchVerificationRequest(request.url())) {
      requestLog.push(`> ${request.method()} ${request.url()}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      failures.push(`[${label}] console error: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => failures.push(`[${label}] page error: ${error.message}`));
  page.on('requestfailed', (request) => {
    if (isRequiredNetworkRequest(request)) {
      failures.push(`[${label}] request failed: ${request.url()} ${request.failure()?.errorText ?? ''}`.trim());
    }
  });
  page.on('response', (response) => {
    if (isWorkbenchVerificationRequest(response.url())) {
      requestLog.push(`< ${response.status()} ${response.request().method()} ${response.url()}`);
    }
    if (response.status() >= 400 && isRequiredNetworkRequest(response.request())) {
      failures.push(`[${label}] response failed: ${response.status()} ${response.url()}`);
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 60000 });
    await assertWorkbenchChrome(page, label);
    await assertIconButtonsHaveNames(page, label);
    await assertCanvasTextWorkflow(page, label, targetScrollTop, requestLog);
    await assertCanvasHoverSurface(page, label, requestLog, canvasFeedbackLoad);
    if (failures.length > 0) {
      throw new Error(failures.join('\n'));
    }
    console.log(`[${label}] Workbench launch, chrome, Canvas text, preview handoff, icon accessibility, and hover geometry passed.`);
  } finally {
    await page.close();
  }
}

function isRequiredNetworkRequest(request) {
  return ['document', 'script', 'stylesheet', 'xhr', 'fetch', 'websocket'].includes(request.resourceType());
}

function isWorkbenchVerificationRequest(url) {
  return url.includes('/text-viewport')
    || url.includes('/canvas-feedback')
    || url.includes('/canvas-text-preview')
    || url.includes('/canvas-text-previews/');
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
  await clickVisibleElementPoint(page, textBody, label, 'Canvas text body');
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
  if (!(await feedbackBar.isVisible().catch(() => false))) {
    await moveToVisibleElementPoint(page, textNode, label, 'Canvas text node hover target');
  }
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
  const box = await feedbackBar.boundingBox();
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
