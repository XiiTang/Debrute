import type { Dirent } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { userHomeDir } from '@debrute/project-core';
import type {
  DebruteSkillsDiagnostic,
  OfficialDebruteSkillsMaterializeSnapshot,
  OfficialDebruteSkillsStatusSnapshot,
  SkillRecord
} from '@debrute/app-protocol';
import {
  loadSkillsSnapshot,
  sharedSkillsSources,
  type SkillDiagnostic,
  type SkillsSnapshot
} from './skillsRegistry.js';

export type OfficialDebruteSkillsMaterializeErrorCode =
  | 'skills_payload_unavailable'
  | 'skills_payload_invalid'
  | 'skills_shared_root_unreadable'
  | 'skills_permission_denied'
  | 'skills_materialize_failed';

export type OfficialDebruteSkillsDiagnosticCode =
  | OfficialDebruteSkillsMaterializeErrorCode
  | SkillDiagnostic['code'];

type DebruteSkillsSnapshot = Omit<SkillsSnapshot, 'diagnostics'> & { diagnostics: DebruteSkillsDiagnostic[] };

export interface OfficialDebruteSkillsMaterializer {
  status(): Promise<OfficialDebruteSkillsStatusSnapshot>;
  materialize(): Promise<OfficialDebruteSkillsMaterializeSnapshot>;
}

export interface OfficialDebruteSkillsMaterializerInput {
  userHome?: string;
  payloadSkillsRoot?: string;
  debruteVersion: string;
  tempName?: (skillName: string) => string;
}

export class OfficialDebruteSkillsMaterializeError extends Error {
  constructor(
    readonly code: OfficialDebruteSkillsMaterializeErrorCode,
    message: string,
    readonly fields: Record<string, string | number | boolean> = {}
  ) {
    super(message);
    this.name = 'OfficialDebruteSkillsMaterializeError';
  }
}

export function createOfficialDebruteSkillsMaterializer(
  input: OfficialDebruteSkillsMaterializerInput
): OfficialDebruteSkillsMaterializer {
  return new DefaultOfficialDebruteSkillsMaterializer(input);
}

class DefaultOfficialDebruteSkillsMaterializer implements OfficialDebruteSkillsMaterializer {
  constructor(private readonly input: OfficialDebruteSkillsMaterializerInput) {}

  async status(): Promise<OfficialDebruteSkillsStatusSnapshot> {
    const sharedRoot = this.sharedRoot();
    const installed = await loadInstalled(sharedRoot);
    const payload = await this.loadPayloadForStatus();
    const diagnostics: DebruteSkillsDiagnostic[] = [
      ...installed.diagnostics,
      ...payload.diagnostics
    ];
    return {
      ...installed,
      diagnostics,
      currentDebruteVersion: this.input.debruteVersion,
      sharedSkillsRoot: sharedRoot,
      ...(this.input.payloadSkillsRoot ? { payloadSkillsRoot: resolve(this.input.payloadSkillsRoot) } : {}),
      payloadRootAvailable: payload.snapshot !== undefined,
      payloadSkills: [...(payload.snapshot?.skills.map((skill) => skill.name) ?? [])].sort((left, right) => left.localeCompare(right))
    };
  }

  async materialize(): Promise<OfficialDebruteSkillsMaterializeSnapshot> {
    const payload = await loadPayload(this.requirePayloadRoot());
    assertPayloadSkillsValid(payload);
    const materialized = sortSkills(payload.skills);
    await materializeManagedOfficialSkills({
      sharedRoot: this.sharedRoot(),
      payloadSkills: materialized,
      tempName: (skillName) => join(this.sharedRoot(), this.tempName(skillName))
    });

    const status = await this.status();
    const installedByName = new Map(status.skills.map((skill) => [skill.name, skill]));
    return {
      ...status,
      materializedSkills: materialized.map((skill) => installedByName.get(skill.name) ?? skill)
    };
  }

  private sharedRoot(): string {
    return sharedSkillsSources({ userHome: this.userHome() })[0]!.root;
  }

  private userHome(): string {
    return this.input.userHome ?? userHomeDir();
  }

  private tempName(skillName: string): string {
    return this.input.tempName?.(skillName) ?? `.${skillName}.${randomUUID()}.tmp`;
  }

  private requirePayloadRoot(): string {
    if (!this.input.payloadSkillsRoot) {
      throw new OfficialDebruteSkillsMaterializeError('skills_payload_unavailable', 'Debrute Skills payload root is not configured.');
    }
    return resolve(this.input.payloadSkillsRoot);
  }

  private async loadPayloadForStatus(): Promise<{ snapshot?: DebruteSkillsSnapshot; diagnostics: DebruteSkillsDiagnostic[] }> {
    if (!this.input.payloadSkillsRoot) {
      return {
        diagnostics: [{
          source: 'debrute-materialize',
          root: dirname(this.sharedRoot()),
          code: 'skills_payload_unavailable',
          severity: 'warning',
          message: 'Debrute Skills payload root is not configured.'
        }]
      };
    }
    try {
      const snapshot = await loadPayload(resolve(this.input.payloadSkillsRoot));
      return { snapshot, diagnostics: snapshot.diagnostics };
    } catch (error) {
      if (error instanceof OfficialDebruteSkillsMaterializeError) {
        return {
          diagnostics: [{
            source: 'debrute-repository',
            root: resolve(this.input.payloadSkillsRoot),
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

function assertPayloadSkillsValid(snapshot: DebruteSkillsSnapshot): void {
  if (snapshot.diagnostics.length === 0) {
    return;
  }
  throw new OfficialDebruteSkillsMaterializeError(
    'skills_payload_invalid',
    'Debrute Skills payload is invalid.',
    { diagnostics: snapshot.diagnostics.length }
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

async function loadPayload(payloadRoot: string): Promise<DebruteSkillsSnapshot> {
  try {
    const rootStat = await stat(payloadRoot);
    if (!rootStat.isDirectory()) {
      throw new OfficialDebruteSkillsMaterializeError('skills_payload_unavailable', `Debrute Skills payload root is not a directory: ${payloadRoot}`, { path: payloadRoot });
    }
    const snapshot = await loadSkillsSnapshot({ sources: [{ source: 'debrute-repository', root: payloadRoot }] });
    return {
      ...snapshot,
      diagnostics: normalizePayloadDiagnostics(snapshot.diagnostics, payloadRoot)
    };
  } catch (error) {
    if (error instanceof OfficialDebruteSkillsMaterializeError) {
      throw error;
    }
    if (isMissingPathError(error)) {
      throw new OfficialDebruteSkillsMaterializeError('skills_payload_unavailable', `Debrute Skills payload root is unavailable: ${payloadRoot}`, { path: payloadRoot });
    }
    throw new OfficialDebruteSkillsMaterializeError('skills_payload_unavailable', `Debrute Skills payload root cannot be read: ${errorMessage(error)}`, { path: payloadRoot });
  }
}

function normalizePayloadDiagnostics(diagnostics: SkillDiagnostic[], payloadRoot: string): DebruteSkillsDiagnostic[] {
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
      root: payloadRoot,
      code: 'skills_payload_invalid',
      severity: 'warning',
      message: 'One or more Debrute Skills payload packages are invalid.'
    }
  ];
}

function sortSkills(skills: SkillRecord[]): SkillRecord[] {
  return [...skills].sort((left, right) => left.name.localeCompare(right.name));
}

async function materializeManagedOfficialSkills(input: {
  sharedRoot: string;
  payloadSkills: SkillRecord[];
  tempName: (skillName: string) => string;
}): Promise<void> {
  try {
    await mkdir(input.sharedRoot, { recursive: true });
    const officialDirs = await officialManagedSkillDirectories(input.sharedRoot);
    await Promise.all(officialDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    for (const skill of input.payloadSkills) {
      await replaceSkillDirectory({
        sourceDir: skill.skillDir,
        destinationDir: join(input.sharedRoot, skill.name),
        tempDir: input.tempName(skill.name)
      });
    }
  } catch (error) {
    if (error instanceof OfficialDebruteSkillsMaterializeError) {
      throw error;
    }
    if (isPermissionError(error)) {
      throw new OfficialDebruteSkillsMaterializeError('skills_permission_denied', `Debrute Skills materialize lacks permission for ${input.sharedRoot}: ${errorMessage(error)}`, { path: input.sharedRoot });
    }
    throw new OfficialDebruteSkillsMaterializeError('skills_materialize_failed', `Failed to materialize Debrute Skills: ${errorMessage(error)}`, { path: input.sharedRoot });
  }
}

async function officialManagedSkillDirectories(sharedRoot: string): Promise<string[]> {
  let entries: Array<Dirent<string>>;
  try {
    entries = await readdir(sharedRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
  const directories: string[] = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const directory = join(sharedRoot, entry.name);
    if (await isOfficialManagedSkillDirectory(directory)) {
      directories.push(directory);
    }
  }
  return directories;
}

async function isOfficialManagedSkillDirectory(directory: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(join(directory, 'SKILL.md'), 'utf8');
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
  const frontmatter = parseSkillFrontmatter(content);
  if (!frontmatter) {
    return false;
  }
  const metadata = frontmatter.metadata;
  return isRecord(metadata)
    && metadata['debrute.managed'] === 'true'
    && metadata['debrute.package'] === 'debrute';
}

function parseSkillFrontmatter(content: string): Record<string, unknown> | undefined {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) {
    return undefined;
  }
  try {
    const frontmatter = parseYaml(match[1] ?? '');
    return isRecord(frontmatter) ? frontmatter : undefined;
  } catch {
    return undefined;
  }
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
      throw new OfficialDebruteSkillsMaterializeError('skills_permission_denied', `Debrute Skills materialize lacks permission for ${input.destinationDir}: ${errorMessage(error)}`, { path: input.destinationDir });
    }
    throw new OfficialDebruteSkillsMaterializeError('skills_materialize_failed', `Failed to materialize Debrute Skill ${input.destinationDir}: ${errorMessage(error)}`, { path: input.destinationDir });
  }
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
