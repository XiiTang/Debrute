import { cp, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createOfficialDebruteSkillsMaterializer } from '@debrute/capability-runtime';
import { userHomeDir } from '@debrute/project-core';
import type { ManagedCliDiagnostic } from '@debrute/app-protocol';
import type { DebruteReplacementHelperCommand } from '../http/createDebruteDaemonHttpServer.js';
import { parseProductPayloadManifest } from './ProductPayloadManifest.js';

export interface ManagedProductCliServiceInput {
  productVersion: string;
  cliPayloadDir: string;
  skillsPayloadDir: string;
  managedBinDir: string;
  managedProductRoot: string;
  productManifestPath: string;
  webDistDir: string;
  desktopInstallPath: string;
  replacementHelperPath: string;
  userHome?: string;
}

export class ManagedProductCliService {
  private lastDiagnostic: ManagedCliDiagnostic;

  constructor(private readonly input: ManagedProductCliServiceInput) {
    this.lastDiagnostic = {
      status: 'error',
      version: input.productVersion,
      path: this.wrapperPath(),
      message: 'Managed Debrute CLI has not been materialized yet.'
    };
  }

  async ensureCurrent(): Promise<ManagedCliDiagnostic> {
    try {
      await this.ensureCurrentUnsafe();
      const skillsStatus = await createOfficialDebruteSkillsMaterializer({
        userHome: this.userHome(),
        payloadSkillsRoot: this.input.skillsPayloadDir,
        debruteVersion: this.input.productVersion
      }).materialize();
      this.lastDiagnostic = {
        status: 'ready',
        version: this.input.productVersion,
        path: this.wrapperPath(),
        skillsVersion: skillsStatus.currentDebruteVersion,
        skillsRoot: skillsStatus.sharedSkillsRoot
      };
    } catch (error) {
      this.lastDiagnostic = {
        status: 'error',
        version: this.input.productVersion,
        path: this.wrapperPath(),
        message: errorMessage(error)
      };
    }
    return this.lastDiagnostic;
  }

  diagnostic(): ManagedCliDiagnostic {
    return this.lastDiagnostic;
  }

  replacementHelperCommand(): DebruteReplacementHelperCommand {
    return {
      executablePath: this.targetCliPath(),
      helperPath: this.managedReplacementHelperPath()
    };
  }

  private async ensureCurrentUnsafe(): Promise<void> {
    const manifest = parseProductPayloadManifest(JSON.parse(await readFile(this.input.productManifestPath, 'utf8')) as unknown);
    if (manifest.productVersion !== this.input.productVersion) {
      throw new Error(`Product payload manifest version ${manifest.productVersion} does not match runtime product version ${this.input.productVersion}.`);
    }
    const versionRoot = join(this.input.managedProductRoot, this.input.productVersion);
    await replaceDirectory(this.input.cliPayloadDir, join(versionRoot, 'cli'));
    await replaceDirectory(this.input.skillsPayloadDir, join(versionRoot, 'skills'));
    await writeJsonAtomic(join(this.input.managedProductRoot, 'product-manifest.json'), manifest);
    await copyFileIfDifferent(this.input.replacementHelperPath, this.managedReplacementHelperPath());
    await writeJsonAtomic(join(this.input.managedProductRoot, 'product-runtime.json'), {
      productVersion: this.input.productVersion,
      webDistDir: this.input.webDistDir,
      desktopInstallPath: this.input.desktopInstallPath,
      replacementHelperPath: this.managedReplacementHelperPath()
    });
    await writeWrapper({
      wrapperPath: this.wrapperPath(),
      targetPath: this.targetCliPath(),
      platform: process.platform
    });
  }

  private wrapperPath(): string {
    return join(this.input.managedBinDir, process.platform === 'win32' ? 'debrute.cmd' : 'debrute');
  }

  private targetCliPath(): string {
    const executable = process.platform === 'win32' ? 'debrute.exe' : 'debrute';
    return join(this.input.managedProductRoot, this.input.productVersion, 'cli', executable);
  }

  private managedReplacementHelperPath(): string {
    return join(this.input.managedProductRoot, 'product-replacement-helper.cjs');
  }

  private userHome(): string {
    return this.input.userHome ?? userHomeDir();
  }
}

async function replaceDirectory(source: string, destination: string): Promise<void> {
  if (samePath(source, destination)) {
    return;
  }
  const temporary = `${destination}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, temporary, { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
}

async function copyFileIfDifferent(source: string, destination: string): Promise<void> {
  if (samePath(source, destination)) {
    return;
  }
  await cp(source, destination);
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

async function writeWrapper(input: { wrapperPath: string; targetPath: string; platform: NodeJS.Platform }): Promise<void> {
  await mkdir(dirname(input.wrapperPath), { recursive: true });
  if (input.platform === 'win32') {
    await writeFile(input.wrapperPath, `@echo off\r\n"${input.targetPath}" %*\r\n`, 'utf8');
    return;
  }
  await writeFile(input.wrapperPath, `#!/bin/sh\nexec "${input.targetPath}" "$@"\n`, 'utf8');
  await chmod(input.wrapperPath, 0o755);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
