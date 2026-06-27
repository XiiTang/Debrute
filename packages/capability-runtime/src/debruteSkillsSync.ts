import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { userHomeDir } from '@debrute/project-core';
import type {
  DebruteSkillsDiagnostic,
  DebruteSkillsState,
  SkillRecord,
  SkillsStatusSnapshot,
  SkillsSyncInput,
  SkillsSyncSnapshot
} from '@debrute/app-protocol';
import {
  loadSkillsSnapshot,
  sharedSkillsSources,
  type SkillDiagnostic,
  type SkillsSnapshot
} from './skillsRegistry.js';

export type DebruteSkillsSyncErrorCode =
  | 'skills_bundle_unavailable'
  | 'skills_bundle_invalid'
  | 'skills_shared_root_unreadable'
  | 'skills_permission_denied'
  | 'skills_sync_failed'
  | 'skills_state_unreadable'
  | 'skills_io_failed';

export type DebruteSkillsDiagnosticCode =
  | DebruteSkillsSyncErrorCode
  | SkillDiagnostic['code']
  | 'skills_not_installed';

type DebruteSkillsSnapshot = Omit<SkillsSnapshot, 'diagnostics'> & { diagnostics: DebruteSkillsDiagnostic[] };

export interface DebruteSkillsSyncService {
  status(): Promise<SkillsStatusSnapshot>;
  sync(input: SkillsSyncInput): Promise<SkillsSyncSnapshot>;
}

export interface DebruteSkillsSyncServiceInput {
  userHome?: string;
  bundledSkillsRoot?: string;
  debruteVersion: string;
  now?: () => string;
  tempName?: (skillName: string) => string;
}

export class DebruteSkillsSyncError extends Error {
  constructor(
    readonly code: DebruteSkillsSyncErrorCode,
    message: string,
    readonly fields: Record<string, string | number | boolean> = {}
  ) {
    super(message);
    this.name = 'DebruteSkillsSyncError';
  }
}

export function createDebruteSkillsSyncService(input: DebruteSkillsSyncServiceInput): DebruteSkillsSyncService {
  return new DefaultDebruteSkillsSyncService(input);
}

class DefaultDebruteSkillsSyncService implements DebruteSkillsSyncService {
  constructor(private readonly input: DebruteSkillsSyncServiceInput) {}

  async status(): Promise<SkillsStatusSnapshot> {
    const sharedRoot = this.sharedRoot();
    const statePath = this.statePath();
    const installed = await loadInstalled(sharedRoot);
    const stateResult = await readState(statePath);
    const bundled = await this.loadBundledForStatus();
    const diagnostics: DebruteSkillsDiagnostic[] = [
      ...installed.diagnostics,
      ...stateResult.diagnostics,
      ...bundled.diagnostics
    ];
    const bundledNames = [...(bundled.snapshot?.skills.map((skill) => skill.name) ?? [])].sort((left, right) => left.localeCompare(right));
    const installedNames = new Set(installed.skills.map((skill) => skill.name));
    const missingBundledSkillNames = bundled.snapshot
      ? bundledNames.filter((name) => !installedNames.has(name))
      : [];
    return {
      ...installed,
      diagnostics,
      statePath,
      ...(stateResult.state ? { state: stateResult.state } : {}),
      currentDebruteVersion: this.input.debruteVersion,
      sharedSkillsRoot: sharedRoot,
      ...(this.input.bundledSkillsRoot ? { bundledSkillsRoot: resolve(this.input.bundledSkillsRoot) } : {}),
      bundledRootAvailable: bundled.snapshot !== undefined,
      bundledSkills: bundledNames,
      missingBundledSkills: missingBundledSkillNames,
      missingBundledSkillCount: missingBundledSkillNames.length,
      skippedDeletedSkills: stateResult.state?.skippedDeletedSkills ?? []
    };
  }

  async sync(input: SkillsSyncInput): Promise<SkillsSyncSnapshot> {
    const bundled = await loadBundled(this.requireBundledRoot());
    assertBundledSkillsValid(bundled);
    const installedBefore = await loadInstalled(this.sharedRoot());
    const stateResult = await readState(this.statePath());
    assertStateReadable(stateResult, input.force);
    const planned = planSync({
      bundledSkills: bundled.skills,
      installedSkills: installedBefore.skills,
      force: input.force,
      ...(stateResult.state ? { previousState: stateResult.state } : {})
    });
    const updatedSkills: SkillRecord[] = [];

    for (const skill of planned.toUpdate) {
      await replaceSkillDirectory({
        sourceDir: skill.skillDir,
        destinationDir: join(this.sharedRoot(), skill.name),
        tempDir: join(this.sharedRoot(), this.tempName(skill.name))
      });
      updatedSkills.push(skill);
    }

    const syncDiagnostics = [
      ...bundled.diagnostics,
      ...installedBefore.diagnostics,
      ...stateResult.diagnostics
    ];
    await writeStateOrThrow(this.statePath(), {
      debruteVersion: this.input.debruteVersion,
      bundledSkills: sortSkillNames(bundled.skills),
      updatedSkills: sortSkillNames(updatedSkills),
      addedBundledSkills: sortSkillNames(planned.addedBundledSkills),
      skippedDeletedSkills: planned.skippedDeletedSkills,
      diagnostics: syncDiagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
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
      addedBundledSkills: planned.addedBundledSkills.map((skill) => installedByName.get(skill.name) ?? skill),
      skippedDeletedSkills: planned.skippedDeletedSkills
    };
  }

  private sharedRoot(): string {
    return sharedSkillsSources({ userHome: this.userHome() })[0]!.root;
  }

  private statePath(): string {
    return join(this.userHome(), '.debrute', 'skills-state.json');
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
      throw new DebruteSkillsSyncError('skills_bundle_unavailable', 'Bundled Debrute Skills root is not configured.');
    }
    return resolve(this.input.bundledSkillsRoot);
  }

  private async loadBundledForStatus(): Promise<{ snapshot?: DebruteSkillsSnapshot; diagnostics: DebruteSkillsDiagnostic[] }> {
    if (!this.input.bundledSkillsRoot) {
      return {
        diagnostics: [{
          source: 'debrute-sync',
          root: dirname(this.statePath()),
          code: 'skills_bundle_unavailable',
          severity: 'warning',
          message: 'Bundled Debrute Skills root is not configured.'
        }]
      };
    }
    try {
      const snapshot = await loadBundled(resolve(this.input.bundledSkillsRoot));
      return { snapshot, diagnostics: snapshot.diagnostics };
    } catch (error) {
      if (error instanceof DebruteSkillsSyncError) {
        return {
          diagnostics: [{
            source: 'debrute-repository',
            root: resolve(this.input.bundledSkillsRoot),
            code: error.code,
            severity: 'warning',
            message: error.message
          }]
        };
      }
      throw error;
    }
  }
}

function assertBundledSkillsValid(snapshot: DebruteSkillsSnapshot): void {
  if (snapshot.diagnostics.length === 0) {
    return;
  }
  throw new DebruteSkillsSyncError(
    'skills_bundle_invalid',
    'Bundled Debrute Skills are invalid.',
    { diagnostics: snapshot.diagnostics.length }
  );
}

function assertStateReadable(stateResult: { state?: DebruteSkillsState; diagnostics: DebruteSkillsDiagnostic[] }, force: boolean): void {
  if (force) {
    return;
  }
  const stateDiagnostic = stateResult.diagnostics.find((diagnostic) => diagnostic.code === 'skills_state_unreadable');
  if (!stateDiagnostic) {
    return;
  }
  throw new DebruteSkillsSyncError(
    'skills_state_unreadable',
    stateDiagnostic.message,
    stateDiagnostic.path ? { path: stateDiagnostic.path } : {}
  );
}

async function loadInstalled(sharedRoot: string): Promise<DebruteSkillsSnapshot> {
  const snapshot = await loadSkillsSnapshot({ sources: [{ source: 'shared-agents', root: sharedRoot }] });
  return {
    ...snapshot,
    diagnostics: snapshot.diagnostics.map((diagnostic): DebruteSkillsDiagnostic => diagnostic.code === 'skill_root_io_failed'
      ? {
          source: diagnostic.source,
          root: diagnostic.root,
          ...(diagnostic.path ? { path: diagnostic.path } : {}),
          code: 'skills_shared_root_unreadable',
          severity: 'warning',
          message: diagnostic.message
        }
      : {
          ...diagnostic,
          severity: 'warning'
        })
  };
}

async function loadBundled(bundledRoot: string): Promise<DebruteSkillsSnapshot> {
  try {
    const rootStat = await stat(bundledRoot);
    if (!rootStat.isDirectory()) {
      throw new DebruteSkillsSyncError('skills_bundle_unavailable', `Bundled Debrute Skills root is not a directory: ${bundledRoot}`, { path: bundledRoot });
    }
    const snapshot = await loadSkillsSnapshot({ sources: [{ source: 'debrute-repository', root: bundledRoot }] });
    return {
      ...snapshot,
      diagnostics: normalizeBundledDiagnostics(snapshot.diagnostics, bundledRoot)
    };
  } catch (error) {
    if (error instanceof DebruteSkillsSyncError) {
      throw error;
    }
    if (isMissingPathError(error)) {
      throw new DebruteSkillsSyncError('skills_bundle_unavailable', `Bundled Debrute Skills root is unavailable: ${bundledRoot}`, { path: bundledRoot });
    }
    throw new DebruteSkillsSyncError('skills_bundle_unavailable', `Bundled Debrute Skills root cannot be read: ${errorMessage(error)}`, { path: bundledRoot });
  }
}

function normalizeBundledDiagnostics(diagnostics: SkillDiagnostic[], bundledRoot: string): DebruteSkillsDiagnostic[] {
  if (diagnostics.length === 0) {
    return [];
  }
  return [
    ...diagnostics.map((diagnostic): DebruteSkillsDiagnostic => ({
      ...diagnostic,
      severity: 'warning'
    })),
    {
      source: 'debrute-repository',
      root: bundledRoot,
      code: 'skills_bundle_invalid',
      severity: 'warning',
      message: 'One or more bundled Debrute Skills are invalid.'
    }
  ];
}

interface SyncPlan {
  toUpdate: SkillRecord[];
  addedBundledSkills: SkillRecord[];
  skippedDeletedSkills: string[];
}

function planSync(input: {
  bundledSkills: SkillRecord[];
  installedSkills: SkillRecord[];
  previousState?: DebruteSkillsState;
  force: boolean;
}): SyncPlan {
  const bundledByName = new Map(sortSkills(input.bundledSkills).map((skill) => [skill.name, skill]));
  if (input.force || !input.previousState) {
    const allBundled = [...bundledByName.values()];
    return {
      toUpdate: allBundled,
      addedBundledSkills: input.force ? [] : allBundled,
      skippedDeletedSkills: []
    };
  }

  const installedNames = new Set(input.installedSkills.map((skill) => skill.name));
  const previousBundledNames = new Set(input.previousState.bundledSkills);
  const toUpdateNames = new Set<string>();
  const addedNames = new Set<string>();
  const skippedDeletedSkills: string[] = [];

  for (const name of bundledByName.keys()) {
    if (installedNames.has(name)) {
      toUpdateNames.add(name);
      continue;
    }
    if (!previousBundledNames.has(name)) {
      toUpdateNames.add(name);
      addedNames.add(name);
      continue;
    }
    skippedDeletedSkills.push(name);
  }

  return {
    toUpdate: [...toUpdateNames].sort().map((name) => bundledByName.get(name)!),
    addedBundledSkills: [...addedNames].sort().map((name) => bundledByName.get(name)!),
    skippedDeletedSkills: skippedDeletedSkills.sort()
  };
}

function sortSkills(skills: SkillRecord[]): SkillRecord[] {
  return [...skills].sort((left, right) => left.name.localeCompare(right.name));
}

function sortSkillNames(skills: SkillRecord[]): string[] {
  return skills.map((skill) => skill.name).sort((left, right) => left.localeCompare(right));
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
      throw new DebruteSkillsSyncError('skills_permission_denied', `Debrute Skills sync lacks permission for ${input.destinationDir}: ${errorMessage(error)}`, { path: input.destinationDir });
    }
    throw new DebruteSkillsSyncError('skills_sync_failed', `Failed to sync Debrute Skill ${input.destinationDir}: ${errorMessage(error)}`, { path: input.destinationDir });
  }
}

async function readState(statePath: string): Promise<{ state?: DebruteSkillsState; diagnostics: DebruteSkillsDiagnostic[] }> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
    if (!isDebruteSkillsState(parsed)) {
      return {
        diagnostics: [{
          source: 'debrute-sync',
          root: dirname(statePath),
          path: statePath,
          code: 'skills_state_unreadable',
          severity: 'warning',
          message: 'Debrute Skills state is invalid.'
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
        source: 'debrute-sync',
        root: dirname(statePath),
        path: statePath,
        code: 'skills_state_unreadable',
        severity: 'warning',
        message: `Debrute Skills state cannot be read: ${errorMessage(error)}`
      }]
    };
  }
}

async function writeStateOrThrow(statePath: string, state: DebruteSkillsState): Promise<void> {
  try {
    await mkdir(dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempPath, statePath);
  } catch (error) {
    if (isPermissionError(error)) {
      throw new DebruteSkillsSyncError('skills_permission_denied', `Debrute Skills state cannot be written: ${errorMessage(error)}`, { path: statePath });
    }
    throw new DebruteSkillsSyncError('skills_io_failed', `Debrute Skills state cannot be written: ${errorMessage(error)}`, { path: statePath });
  }
}

function isDebruteSkillsState(value: unknown): value is DebruteSkillsState {
  if (!isRecord(value)
    || typeof value.debruteVersion !== 'string'
    || typeof value.updatedAt !== 'string') {
    return false;
  }
  return stringArray(value.bundledSkills)
    && stringArray(value.updatedSkills)
    && stringArray(value.addedBundledSkills)
    && stringArray(value.skippedDeletedSkills)
    && Array.isArray(value.diagnostics)
    && value.diagnostics.every((diagnostic) => isRecord(diagnostic)
      && (diagnostic.source === undefined || diagnostic.source === 'shared-agents' || diagnostic.source === 'debrute-repository' || diagnostic.source === 'debrute-sync')
      && (diagnostic.root === undefined || typeof diagnostic.root === 'string')
      && typeof diagnostic.code === 'string'
      && (diagnostic.severity === 'info' || diagnostic.severity === 'warning' || diagnostic.severity === 'error')
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
