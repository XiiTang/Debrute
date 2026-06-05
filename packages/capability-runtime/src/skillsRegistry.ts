import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SkillRecord, SkillSourceKind } from '@debrute/app-protocol';

export interface SkillSourceRoot {
  source: SkillSourceKind;
  root: string;
}

export interface SkillDiagnostic {
  source: SkillSourceKind;
  root: string;
  path?: string;
  code:
    | 'skill_missing_file'
    | 'skill_invalid_frontmatter'
    | 'skill_missing_name'
    | 'skill_invalid_name'
    | 'skill_missing_description'
    | 'skill_invalid_description'
    | 'debrute_skill_name_mismatch'
    | 'debrute_skill_missing_metadata'
    | 'debrute_skill_invalid_metadata'
    | 'skill_root_io_failed'
    | 'skill_package_io_failed';
  message: string;
}

export interface SkillsSnapshot {
  sources: SkillSourceRoot[];
  skills: SkillRecord[];
  diagnostics: SkillDiagnostic[];
}

const SKILL_NAME_PATTERN = /^[A-Za-z0-9_:-]{1,64}$/;

export function sharedSkillsSources(input: { userHome: string }): SkillSourceRoot[] {
  return [{ source: 'shared-agents', root: join(input.userHome, '.agents/skills') }];
}

export async function loadSkillsSnapshot(input: { sources: SkillSourceRoot[] }): Promise<SkillsSnapshot> {
  const skills: SkillRecord[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const source of input.sources) {
    const root = resolve(source.root);
    let entries: Array<Dirent<string>>;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      diagnostics.push({
        source: source.source,
        root,
        code: 'skill_root_io_failed',
        message: `Failed to read Skills root: ${errorMessage(error)}`
      });
      continue;
    }

    for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name.startsWith('debrute-')) {
        continue;
      }
      const result = await loadSkillPackage({ source: source.source, root }, entry.name);
      if (result.skill) {
        skills.push(result.skill);
      }
      diagnostics.push(...result.diagnostics);
    }
  }

  return {
    sources: input.sources.map((source) => ({ ...source, root: resolve(source.root) })),
    skills,
    diagnostics
  };
}

async function loadSkillPackage(source: SkillSourceRoot, dirName: string): Promise<{ skill?: SkillRecord; diagnostics: SkillDiagnostic[] }> {
  const diagnostics: SkillDiagnostic[] = [];
  const skillDir = resolve(source.root, dirName);
  const skillPath = join(skillDir, 'SKILL.md');
  let content: string;
  try {
    content = await readFile(skillPath, 'utf8');
  } catch (error) {
    diagnostics.push({
      source: source.source,
      root: source.root,
      path: skillPath,
      code: isMissingPathError(error) ? 'skill_missing_file' : 'skill_package_io_failed',
      message: isMissingPathError(error) ? 'Skill package is missing SKILL.md.' : `Failed to read Skill package: ${errorMessage(error)}`
    });
    return { diagnostics };
  }

  const parsed = parseSkillMarkdown(content);
  if (!parsed.ok) {
    diagnostics.push({
      source: source.source,
      root: source.root,
      path: skillPath,
      code: 'skill_invalid_frontmatter',
      message: parsed.message
    });
    return { diagnostics };
  }

  const fieldDiagnostics = validateSkillFields(source, skillPath, parsed.frontmatter);
  diagnostics.push(...fieldDiagnostics);
  const debruteDiagnostics = validateDebruteSkillFields(source, skillPath, dirName, parsed.frontmatter);
  diagnostics.push(...debruteDiagnostics);
  if (fieldDiagnostics.length > 0 || debruteDiagnostics.length > 0) {
    return { diagnostics };
  }

  const name = parsed.frontmatter.name as string;
  const description = parsed.frontmatter.description as string;
  const metadata = parsed.frontmatter.metadata as Record<string, unknown>;
  const shortDescription = shortDescriptionFromFrontmatter(parsed.frontmatter);
  return {
    skill: {
      name,
      description,
      ...(shortDescription ? { shortDescription } : {}),
      source: source.source,
      root: source.root,
      skillDir,
      skillPath,
      ...(typeof metadata['debrute.version'] === 'string' ? { debruteVersion: metadata['debrute.version'] } : {})
    },
    diagnostics
  };
}

function validateDebruteSkillFields(source: SkillSourceRoot, skillPath: string, dirName: string, frontmatter: Record<string, unknown>): SkillDiagnostic[] {
  const diagnostics: SkillDiagnostic[] = [];
  if (frontmatter.name !== dirName) {
    diagnostics.push({
      source: source.source,
      root: source.root,
      path: skillPath,
      code: 'debrute_skill_name_mismatch',
      message: `Debrute Skill directory "${dirName}" must match frontmatter name "${String(frontmatter.name ?? '')}".`
    });
  }
  const metadata = frontmatter.metadata;
  if (!isRecord(metadata)) {
    diagnostics.push({
      source: source.source,
      root: source.root,
      path: skillPath,
      code: 'debrute_skill_missing_metadata',
      message: 'Debrute Skill frontmatter requires metadata with debrute.managed and debrute.package.'
    });
    return diagnostics;
  }
  if (metadata['debrute.managed'] !== 'true' || metadata['debrute.package'] !== 'debrute') {
    diagnostics.push({
      source: source.source,
      root: source.root,
      path: skillPath,
      code: 'debrute_skill_invalid_metadata',
      message: 'Debrute Skill metadata must declare debrute.managed: "true" and debrute.package: "debrute".'
    });
  }
  return diagnostics;
}

function parseSkillMarkdown(content: string): { ok: true; frontmatter: Record<string, unknown> } | { ok: false; message: string } {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) {
    return { ok: false, message: 'SKILL.md must start with YAML frontmatter.' };
  }
  try {
    const frontmatter = parseYaml(match[1] ?? '');
    if (!isRecord(frontmatter)) {
      return { ok: false, message: 'SKILL.md frontmatter must be a mapping.' };
    }
    return { ok: true, frontmatter };
  } catch (error) {
    return { ok: false, message: `Invalid YAML frontmatter: ${errorMessage(error)}` };
  }
}

function validateSkillFields(source: SkillSourceRoot, skillPath: string, frontmatter: Record<string, unknown>): SkillDiagnostic[] {
  const diagnostics: SkillDiagnostic[] = [];
  const name = frontmatter.name;
  if (typeof name !== 'string' || name.length === 0) {
    diagnostics.push({
      source: source.source,
      root: source.root,
      path: skillPath,
      code: 'skill_missing_name',
      message: 'Skill frontmatter requires a non-empty name.'
    });
  } else if (!SKILL_NAME_PATTERN.test(name)) {
    diagnostics.push({
      source: source.source,
      root: source.root,
      path: skillPath,
      code: 'skill_invalid_name',
      message: `Skill name must match ${SKILL_NAME_PATTERN.source}.`
    });
  }

  const description = frontmatter.description;
  if (typeof description !== 'string' || description.length === 0) {
    diagnostics.push({
      source: source.source,
      root: source.root,
      path: skillPath,
      code: 'skill_missing_description',
      message: 'Skill frontmatter requires a non-empty description.'
    });
  } else if (description.length > 1024) {
    diagnostics.push({
      source: source.source,
      root: source.root,
      path: skillPath,
      code: 'skill_invalid_description',
      message: 'Skill description must be at most 1024 characters.'
    });
  }
  return diagnostics;
}

function shortDescriptionFromFrontmatter(frontmatter: Record<string, unknown>): string | undefined {
  const metadata = frontmatter.metadata;
  if (!isRecord(metadata)) {
    return undefined;
  }
  const value = metadata['short-description'];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
