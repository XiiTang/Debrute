import { execFile as execFileCallback, spawn } from 'node:child_process';
import { chmod, copyFile, cp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleepTimeout } from 'node:timers/promises';
import type { ProductReplacementPlan } from '@debrute/daemon';

export interface ProductReplacementHelperOperations {
  readPlan(path: string): Promise<ProductReplacementPlan>;
  waitForPid(pid: number): Promise<void>;
  applyMacos(plan: ProductReplacementPlan): Promise<void>;
  applyWindows(plan: ProductReplacementPlan): Promise<void>;
  applyLinux(plan: ProductReplacementPlan): Promise<void>;
  relaunch(path: string): Promise<void>;
  writeLog(planPath: string, message: string): Promise<void>;
}

export interface ProductReplacementExecResult {
  stdout: string;
  stderr: string;
}

export interface NodeProductReplacementHelperDependencies {
  execFile(file: string, args: string[]): Promise<ProductReplacementExecResult>;
  copyDirectory(source: string, destination: string): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
  removePath(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  spawnDetached(file: string, args: string[]): Promise<void>;
  isProcessRunning(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

export async function runProductReplacementHelper(
  planPath: string,
  operations: ProductReplacementHelperOperations = nodeProductReplacementHelperOperations()
): Promise<void> {
  const plan = await operations.readPlan(planPath);
  if (plan.desktopPid !== undefined) {
    await operations.waitForPid(plan.desktopPid);
  }
  await operations.waitForPid(plan.runtimePid);
  if (plan.platform === 'darwin') {
    await operations.applyMacos(plan);
  } else if (plan.platform === 'win32') {
    await operations.applyWindows(plan);
  } else {
    await operations.applyLinux(plan);
  }
  if (plan.relaunchDesktop) {
    await operations.relaunch(plan.desktopInstallPath);
  }
  await operations.writeLog(planPath, `Applied Debrute ${plan.updateVersion}.\n`);
}

export function nodeProductReplacementHelperOperations(
  dependencies: NodeProductReplacementHelperDependencies = nodeProductReplacementHelperDependencies()
): ProductReplacementHelperOperations {
  return {
    readPlan: async (path) => JSON.parse(await readFile(path, 'utf8')) as ProductReplacementPlan,
    waitForPid: async (pid) => {
      while (dependencies.isProcessRunning(pid)) {
        await dependencies.sleep(250);
      }
    },
    applyMacos: async (plan) => {
      const installedAppPath = macosAppBundlePath(plan.desktopInstallPath);
      if (plan.downloadedAssetPath.endsWith('.dmg')) {
        const attach = await dependencies.execFile('hdiutil', ['attach', '-nobrowse', '-readonly', plan.downloadedAssetPath]);
        const mountPoint = parseDmgMountPoint(attach.stdout);
        try {
          const found = await dependencies.execFile('find', [mountPoint, '-maxdepth', '1', '-name', '*.app', '-type', 'd', '-print', '-quit']);
          const sourceAppPath = found.stdout.trim();
          if (!sourceAppPath) {
            throw new Error(`No .app bundle found in mounted Debrute DMG: ${mountPoint}`);
          }
          await dependencies.removePath(installedAppPath);
          await dependencies.copyDirectory(sourceAppPath, installedAppPath);
        } finally {
          await dependencies.execFile('hdiutil', ['detach', mountPoint]);
        }
        return;
      }
      throw new Error(`Unsupported macOS Debrute update asset: ${plan.downloadedAssetPath}`);
    },
    applyWindows: async (plan) => {
      await dependencies.execFile(plan.downloadedAssetPath, ['/S']);
    },
    applyLinux: async (plan) => {
      await dependencies.copyFile(plan.downloadedAssetPath, plan.desktopInstallPath);
      await dependencies.chmod(plan.desktopInstallPath, 0o755);
    },
    relaunch: async (path) => {
      if (process.platform === 'darwin') {
        await dependencies.spawnDetached('open', [macosAppBundlePath(path)]);
        return;
      }
      await dependencies.spawnDetached(path, []);
    },
    writeLog: async (planPath, message) => {
      await writeFile(join(dirname(planPath), 'product-replacement.log'), message, 'utf8');
    }
  };
}

function nodeProductReplacementHelperDependencies(): NodeProductReplacementHelperDependencies {
  return {
    execFile: execFile,
    copyDirectory: async (source, destination) => {
      await cp(source, destination, { recursive: true });
    },
    copyFile,
    removePath: async (path) => {
      await rm(path, { recursive: true, force: true });
    },
    chmod,
    spawnDetached: async (file, args) => {
      const child = spawn(file, args, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    },
    isProcessRunning: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    sleep: sleepTimeout
  };
}

function execFile(file: string, args: string[]): Promise<ProductReplacementExecResult> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function macosAppBundlePath(path: string): string {
  const marker = '.app';
  const index = path.indexOf(marker);
  return index === -1 ? path : path.slice(0, index + marker.length);
}

function parseDmgMountPoint(output: string): string {
  const mountPoint = output
    .split(/\r?\n/)
    .map((line) => line.split('\t').at(-1)?.trim())
    .find((part) => part?.startsWith('/Volumes/'));
  if (!mountPoint) {
    throw new Error('Unable to determine Debrute DMG mount point.');
  }
  return mountPoint;
}
