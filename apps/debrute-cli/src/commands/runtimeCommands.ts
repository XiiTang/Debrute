import type { SkillsStatusSnapshot, SkillsSyncSnapshot } from '@debrute/app-protocol';
import type { DebruteSkillsSyncService } from '@debrute/capability-runtime';
import { cliError } from '../errors/cliErrors.js';
import { commandSpecRecords, commandSpecs, specForCommandPath } from './helpSpec.js';
import type { ParsedDebruteArgs } from '../parser/parseDebruteArgs.js';
import type { AgentNamedRecord, DebruteAgentResult } from '../output/renderAgentRecord.js';

export interface RuntimeCommandServices {
  skillsService?: DebruteSkillsSyncService;
}

export async function runRuntimeCommand(args: ParsedDebruteArgs, services: RuntimeCommandServices = {}): Promise<DebruteAgentResult> {
  if (args.command === 'commands') {
    return {
      status: 'ok',
      command: 'commands',
      records: commandSpecRecords(),
      fields: { count: commandSpecs.length }
    };
  }

  if (args.command === 'help') {
    const specItem = specForCommandPath(args.positional);
    if (!specItem) {
      throw cliError('invalid_command', `Unknown Debrute CLI command: ${args.positional.join(' ')}`);
    }
    return {
      status: 'ok',
      command: 'help',
      records: commandSpecRecords([specItem])
    };
  }

  if (args.command === 'skills.status') {
    return skillsStatusResult(args.command, await requiredSkillsService(services.skillsService, args.command).status());
  }

  if (args.command === 'skills.sync') {
    return skillsSyncResult(args.command, await requiredSkillsService(services.skillsService, args.command).sync({
      force: args.options.force === 'true'
    }));
  }

  throw cliError('invalid_command', `Unknown Debrute CLI command: ${args.command}`);
}

function skillsStatusResult(command: string, snapshot: SkillsStatusSnapshot): DebruteAgentResult {
  return {
    status: 'ok',
    command,
    records: [
      ...snapshot.skills.map((skill): AgentNamedRecord => ({
        name: 'skill',
        fields: {
          name: skill.name,
          source: skill.source,
          version: skill.debruteVersion,
          path: skill.skillPath
        }
      })),
      ...snapshot.missingBundledSkills.map((name): AgentNamedRecord => ({
        name: 'missing_bundled_skill',
        fields: { name }
      })),
      ...snapshot.skippedDeletedSkills.map((name): AgentNamedRecord => ({
        name: 'skipped_deleted_skill',
        fields: { name, reason: 'user_deleted' }
      })),
      ...snapshot.diagnostics.map((diagnostic): AgentNamedRecord => ({
        name: 'diagnostic',
        fields: {
          source: diagnostic.source,
          code: diagnostic.code,
          severity: diagnostic.severity,
          path: diagnostic.path,
          message: diagnostic.message
        }
      }))
    ],
    fields: {
      skills: snapshot.skills.length,
      diagnostics: snapshot.diagnostics.length,
      source_root: snapshot.sharedSkillsRoot,
      state_path: snapshot.statePath,
      debrute_version: snapshot.currentDebruteVersion,
      bundled_root: snapshot.bundledSkillsRoot,
      bundled_skills: snapshot.bundledSkills.length,
      installed_debrute_skills: snapshot.skills.length,
      missing_bundled_skills: snapshot.missingBundledSkills.length,
      skipped_deleted_skills: snapshot.skippedDeletedSkills.length
    }
  };
}

function skillsSyncResult(command: string, snapshot: SkillsSyncSnapshot): DebruteAgentResult {
  return {
    status: 'ok',
    command,
    records: [
      ...snapshot.updatedSkills.map((skill): AgentNamedRecord => ({
        name: 'updated_skill',
        fields: {
          name: skill.name,
          version: skill.debruteVersion,
          path: skill.skillPath
        }
      })),
      ...snapshot.addedBundledSkills.map((skill): AgentNamedRecord => ({
        name: 'added_skill',
        fields: {
          name: skill.name,
          version: skill.debruteVersion,
          path: skill.skillPath
        }
      })),
      ...snapshot.skippedDeletedSkills.map((name): AgentNamedRecord => ({
        name: 'skipped_deleted_skill',
        fields: { name, reason: 'user_deleted' }
      })),
      ...snapshot.diagnostics.map((diagnostic): AgentNamedRecord => ({
        name: 'diagnostic',
        fields: {
          source: diagnostic.source,
          code: diagnostic.code,
          severity: diagnostic.severity,
          path: diagnostic.path,
          message: diagnostic.message
        }
      }))
    ],
    fields: {
      updated: snapshot.updatedSkills.length,
      added: snapshot.addedBundledSkills.length,
      skipped_deleted: snapshot.skippedDeletedSkills.length,
      diagnostics: snapshot.diagnostics.length,
      state_path: snapshot.statePath,
      force: snapshot.force
    }
  };
}

function requiredSkillsService(service: DebruteSkillsSyncService | undefined, command: string): DebruteSkillsSyncService {
  if (!service) {
    throw cliError('internal_error', `Skills sync service is required for ${command}.`);
  }
  return service;
}
