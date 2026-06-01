import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { userHomeDir } from '@axis/project-core';
import type {
  AxisSkillsDiagnostic,
  AxisSkillsState,
  SkillRecord,
  SkillsStatusSnapshot,
  SkillsSyncInput,
  SkillsSyncSnapshot
} from '@axis/app-protocol';
import {
  loadSkillsSnapshot,
  sharedSkillsSources,
  type SkillDiagnostic,
  type SkillsSnapshot
} from './skillsRegistry.js';

export type AxisSkillsSyncErrorCode =
  | 'skills_bundle_unavailable'
  | 'skills_bundle_invalid'
  | 'skills_shared_root_unreadable'
  | 'skills_permission_denied'
  | 'skills_sync_failed'
  | 'skills_state_unreadable'
  | 'skills_io_failed';

export type AxisSkillsDiagnosticCode =
  | AxisSkillsSyncErrorCode
  | SkillDiagnostic['code']
  | 'skills_not_installed'
  | 'skills_state_outdated';

type AxisSkillsSnapshot = Omit<SkillsSnapshot, 'diagnostics'> & { diagnostics: AxisSkillsDiagnostic[] };

export interface AxisSkillsSyncService {
  status(): Promise<SkillsStatusSnapshot>;
  sync(input: SkillsSyncInput): Promise<SkillsSyncSnapshot>;
}

export interface AxisSkillsSyncServiceInput {
  userHome?: string;
  bundledSkillsRoot?: string;
  axisVersion: string;
  now?: () => string;
  tempName?: (skillName: string) => string;
}

export class AxisSkillsSyncError extends Error {
  constructor(
    readonly code: AxisSkillsSyncErrorCode,
    message: string,
    readonly fields: Record<string, string | number | boolean> = {}
  ) {
    super(message);
    this.name = 'AxisSkillsSyncError';
  }
}

export function createAxisSkillsSyncService(input: AxisSkillsSyncServiceInput): AxisSkillsSyncService {
  return new DefaultAxisSkillsSyncService(input);
}

class DefaultAxisSkillsSyncService implements AxisSkillsSyncService {
  constructor(private readonly input: AxisSkillsSyncServiceInput) {}

  async status(): Promise<SkillsStatusSnapshot> {
    const sharedRoot = this.sharedRoot();
    const statePath = this.statePath();
    const installed = await loadInstalled(sharedRoot);
    const stateResult = await readState(statePath);
    const bundled = await this.loadBundledForStatus();
    const diagnostics: AxisSkillsDiagnostic[] = [
      ...installed.diagnostics,
      ...stateResult.diagnostics,
      ...bundled.diagnostics
    ];
    const bundledNames = [...(bundled.snapshot?.skills.map((skill) => skill.name) ?? [])].sort((left, right) => left.localeCompare(right));
    const installedNames = new Set(installed.skills.map((skill) => skill.name));
    const missingBundledSkillCount = bundled.snapshot
      ? bundledNames.filter((name) => !installedNames.has(name)).length
      : undefined;
    const outdatedState = stateResult.state?.axisVersion !== undefined && stateResult.state.axisVersion !== this.input.axisVersion;
    if (outdatedState) {
      diagnostics.push({
        source: 'axis-sync',
        root: dirname(statePath),
        path: statePath,
        code: 'skills_state_outdated',
        message: `AXIS Skills were last synced by AXIS ${stateResult.state!.axisVersion}; running AXIS ${this.input.axisVersion}.`
      });
    }

    return {
      ...installed,
      diagnostics,
      statePath,
      ...(stateResult.state ? { state: stateResult.state, stateVersion: stateResult.state.schemaVersion } : {}),
      currentAxisVersion: this.input.axisVersion,
      sharedSkillsRoot: sharedRoot,
      ...(this.input.bundledSkillsRoot ? { bundledSkillsRoot: resolve(this.input.bundledSkillsRoot) } : {}),
      bundledRootAvailable: bundled.snapshot !== undefined,
      bundledSkills: bundledNames,
      ...(missingBundledSkillCount === undefined ? {} : { missingBundledSkillCount }),
      outdatedState
    };
  }

  async sync(input: SkillsSyncInput): Promise<SkillsSyncSnapshot> {
    const bundled = await loadBundled(this.requireBundledRoot());
    const stateResult = await readState(this.statePath());
    const installedBefore = await loadInstalled(this.sharedRoot());
    const planned = planSync({
      force: input.force,
      bundledSkills: bundled.skills,
      installedSkills: installedBefore.skills,
      ...(stateResult.state ? { previousState: stateResult.state } : {})
    });
    const updatedSkills: SkillRecord[] = [];

    for (const skill of planned.update) {
      await replaceSkillDirectory({
        sourceDir: skill.skillDir,
        destinationDir: join(this.sharedRoot(), skill.name),
        tempDir: join(this.sharedRoot(), this.tempName(skill.name))
      });
      updatedSkills.push(skill);
    }

    const syncDiagnostics = [
      ...bundled.diagnostics,
      ...stateResult.diagnostics,
      ...installedBefore.diagnostics
    ];
    await writeStateOrThrow(this.statePath(), {
      schemaVersion: 1,
      axisVersion: this.input.axisVersion,
      bundledSkills: bundled.skills.map((skill) => skill.name).sort((left, right) => left.localeCompare(right)),
      updatedSkills: updatedSkills.map((skill) => skill.name).sort((left, right) => left.localeCompare(right)),
      skippedSkills: planned.skip,
      diagnostics: syncDiagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.path ? { path: diagnostic.path } : {})
      })),
      updatedAt: this.now()
    });

    const status = await this.status();
    const installedByName = new Map(status.skills.map((skill) => [skill.name, skill]));
    return {
      ...status,
      force: input.force,
      updatedSkills: updatedSkills.map((skill) => installedByName.get(skill.name) ?? skill),
      skippedSkills: planned.skip
    };
  }

  private sharedRoot(): string {
    return sharedSkillsSources({ userHome: this.userHome() })[0]!.root;
  }

  private statePath(): string {
    return join(this.userHome(), '.axis', 'skills-state.json');
  }

  private userHome(): string {
    return this.input.userHome ?? userHomeDir();
  }

  private now(): string {
    return this.input.now?.() ?? new Date().toISOString();
  }

  private tempName(skillName: string): string {
    return this.input.tempName?.(skillName) ?? `.${skillName}.${randomUUID()}.tmp`;
  }

  private requireBundledRoot(): string {
    if (!this.input.bundledSkillsRoot) {
      throw new AxisSkillsSyncError('skills_bundle_unavailable', 'Bundled AXIS Skills root is not configured.');
    }
    return resolve(this.input.bundledSkillsRoot);
  }

  private async loadBundledForStatus(): Promise<{ snapshot?: AxisSkillsSnapshot; diagnostics: AxisSkillsDiagnostic[] }> {
    if (!this.input.bundledSkillsRoot) {
      return {
        diagnostics: [{
          source: 'axis-sync',
          root: dirname(this.statePath()),
          code: 'skills_bundle_unavailable',
          message: 'Bundled AXIS Skills root is not configured.'
        }]
      };
    }
    try {
      const snapshot = await loadBundled(resolve(this.input.bundledSkillsRoot));
      return { snapshot, diagnostics: snapshot.diagnostics };
    } catch (error) {
      if (error instanceof AxisSkillsSyncError) {
        return {
          diagnostics: [{
            source: 'axis-repository',
            root: resolve(this.input.bundledSkillsRoot),
            code: error.code,
            message: error.message
          }]
        };
      }
      throw error;
    }
  }
}

async function loadInstalled(sharedRoot: string): Promise<AxisSkillsSnapshot> {
  const snapshot = await loadSkillsSnapshot({ sources: [{ source: 'shared-agents', root: sharedRoot }] });
  return {
    ...snapshot,
    diagnostics: snapshot.diagnostics.map((diagnostic): AxisSkillsDiagnostic => diagnostic.code === 'skill_root_io_failed'
      ? {
          source: diagnostic.source,
          root: diagnostic.root,
          ...(diagnostic.path ? { path: diagnostic.path } : {}),
          code: 'skills_shared_root_unreadable',
          message: diagnostic.message
        }
      : diagnostic)
  };
}

async function loadBundled(bundledRoot: string): Promise<AxisSkillsSnapshot> {
  try {
    const rootStat = await stat(bundledRoot);
    if (!rootStat.isDirectory()) {
      throw new AxisSkillsSyncError('skills_bundle_unavailable', `Bundled AXIS Skills root is not a directory: ${bundledRoot}`, { path: bundledRoot });
    }
    const snapshot = await loadSkillsSnapshot({ sources: [{ source: 'axis-repository', root: bundledRoot }] });
    return {
      ...snapshot,
      diagnostics: normalizeBundledDiagnostics(snapshot.diagnostics, bundledRoot)
    };
  } catch (error) {
    if (error instanceof AxisSkillsSyncError) {
      throw error;
    }
    if (isMissingPathError(error)) {
      throw new AxisSkillsSyncError('skills_bundle_unavailable', `Bundled AXIS Skills root is unavailable: ${bundledRoot}`, { path: bundledRoot });
    }
    throw new AxisSkillsSyncError('skills_bundle_unavailable', `Bundled AXIS Skills root cannot be read: ${errorMessage(error)}`, { path: bundledRoot });
  }
}

function normalizeBundledDiagnostics(diagnostics: SkillDiagnostic[], bundledRoot: string): AxisSkillsDiagnostic[] {
  if (diagnostics.length === 0) {
    return [];
  }
  return [
    ...diagnostics,
    {
      source: 'axis-repository',
      root: bundledRoot,
      code: 'skills_bundle_invalid',
      message: 'One or more bundled AXIS Skills are invalid.'
    }
  ];
}

function planSync(input: {
  force: boolean;
  bundledSkills: SkillRecord[];
  installedSkills: SkillRecord[];
  previousState?: AxisSkillsState;
}): { update: SkillRecord[]; skip: string[] } {
  const installed = new Set(input.installedSkills.map((skill) => skill.name));
  const previous = new Set(input.previousState?.bundledSkills ?? []);
  const update: SkillRecord[] = [];
  const skip: string[] = [];
  for (const skill of [...input.bundledSkills].sort((left, right) => left.name.localeCompare(right.name))) {
    if (input.force || installed.has(skill.name) || !previous.has(skill.name)) {
      update.push(skill);
    } else {
      skip.push(skill.name);
    }
  }
  return { update, skip };
}

async function replaceSkillDirectory(input: { sourceDir: string; destinationDir: string; tempDir: string }): Promise<void> {
  try {
    await mkdir(dirname(input.destinationDir), { recursive: true });
    await rm(input.tempDir, { recursive: true, force: true });
    await cp(input.sourceDir, input.tempDir, { recursive: true });
    await rm(input.destinationDir, { recursive: true, force: true });
    await rename(input.tempDir, input.destinationDir);
  } catch (error) {
    await rm(input.tempDir, { recursive: true, force: true }).catch(() => undefined);
    if (isPermissionError(error)) {
      throw new AxisSkillsSyncError('skills_permission_denied', `AXIS Skills sync lacks permission for ${input.destinationDir}: ${errorMessage(error)}`, { path: input.destinationDir });
    }
    throw new AxisSkillsSyncError('skills_sync_failed', `Failed to sync AXIS Skill ${input.destinationDir}: ${errorMessage(error)}`, { path: input.destinationDir });
  }
}

async function readState(statePath: string): Promise<{ state?: AxisSkillsState; diagnostics: AxisSkillsDiagnostic[] }> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
    if (!isAxisSkillsState(parsed)) {
      return {
        diagnostics: [{
          source: 'axis-sync',
          root: dirname(statePath),
          path: statePath,
          code: 'skills_state_unreadable',
          message: 'AXIS Skills state is invalid.'
        }]
      };
    }
    return { state: parsed, diagnostics: [] };
  } catch (error) {
    if (isMissingPathError(error)) {
      return { diagnostics: [] };
    }
    return {
      diagnostics: [{
        source: 'axis-sync',
        root: dirname(statePath),
        path: statePath,
        code: 'skills_state_unreadable',
        message: `AXIS Skills state cannot be read: ${errorMessage(error)}`
      }]
    };
  }
}

async function writeStateOrThrow(statePath: string, state: AxisSkillsState): Promise<void> {
  try {
    await mkdir(dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempPath, statePath);
  } catch (error) {
    if (isPermissionError(error)) {
      throw new AxisSkillsSyncError('skills_permission_denied', `AXIS Skills state cannot be written: ${errorMessage(error)}`, { path: statePath });
    }
    throw new AxisSkillsSyncError('skills_io_failed', `AXIS Skills state cannot be written: ${errorMessage(error)}`, { path: statePath });
  }
}

function isAxisSkillsState(value: unknown): value is AxisSkillsState {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.axisVersion !== 'string' || typeof value.updatedAt !== 'string') {
    return false;
  }
  return stringArray(value.bundledSkills)
    && stringArray(value.updatedSkills)
    && stringArray(value.skippedSkills)
    && Array.isArray(value.diagnostics)
    && value.diagnostics.every((diagnostic) => isRecord(diagnostic)
      && typeof diagnostic.code === 'string'
      && typeof diagnostic.message === 'string'
      && (diagnostic.path === undefined || typeof diagnostic.path === 'string'));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isPermissionError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
