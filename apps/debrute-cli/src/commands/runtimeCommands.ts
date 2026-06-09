import type { DebruteAppServer, CliImageModelDetail, CliRuntimeDiagnostic, CliVideoModelDetail } from '@debrute/app-server';
import type { SkillsStatusSnapshot, SkillsSyncSnapshot } from '@debrute/app-protocol';
import type { DebruteSkillsSyncService } from '@debrute/capability-runtime';
import { cliError, normalizeServiceErrorCode } from '../errors/cliErrors.js';
import { parseJsonObject } from '../parser/jsonInput.js';
import { primitiveOutputFields } from '../output/fieldEncoding.js';
import { commandSpecRecords, commandSpecs, specForCommandPath } from './helpSpec.js';
import type { ParsedDebruteArgs } from '../parser/parseDebruteArgs.js';
import type { AgentNamedRecord, DebruteAgentResult } from '../output/renderAgentRecord.js';

export interface RuntimeCommandServices {
  server?: DebruteAppServer;
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

  if (args.command === 'runtime.status') {
    const runtimeServer = requiredServer(services.server, args.command);
    const [status, skills] = await Promise.all([
      runtimeServer.runtimeStatusForCli(),
      requiredSkillsService(services.skillsService, args.command).status()
    ]);
    return {
      status: 'ok',
      command: args.command,
      fields: {
        ok: status.ok,
        image_models: status.imageModels,
        available_image_models: status.availableImageModels,
        video_models: status.videoModels,
        available_video_models: status.availableVideoModels,
        llm_models: status.availableLlmModels,
        skills: skills.skills.length,
        diagnostics: status.diagnostics + skills.diagnostics.length
      }
    };
  }

  if (args.command === 'runtime.doctor') {
    const [doctor, skills] = await Promise.all([
      requiredServer(services.server, args.command).runtimeDoctorForCli(),
      requiredSkillsService(services.skillsService, args.command).status()
    ]);
    const diagnostics = [...doctor.diagnostics, ...skillsDoctorDiagnostics(skills)];
    return {
      status: 'ok',
      command: args.command,
      records: diagnostics.map((diagnostic) => ({
        name: 'diagnostic',
        fields: {
          code: diagnostic.code,
          severity: diagnostic.severity,
          message: diagnostic.message
        }
      })),
      fields: { diagnostics: diagnostics.length }
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

  if (args.command === 'models.image.list') {
    const models = await requiredServer(services.server, args.command).listImageModelsForCli();
    return imageModelListResult(args.command, models);
  }

  if (args.command === 'models.video.list') {
    const models = await requiredServer(services.server, args.command).listVideoModelsForCli();
    return videoModelListResult(args.command, models);
  }

  if (args.command === 'models.image.describe') {
    const model = await requiredServer(services.server, args.command).describeImageModelForCli(args.positional[0]!);
    return imageModelDetailResult(args.command, model);
  }

  if (args.command === 'models.video.describe') {
    const model = await requiredServer(services.server, args.command).describeVideoModelForCli(args.positional[0]!);
    return videoModelDetailResult(args.command, model);
  }

  if (args.command === 'llm.request') {
    const result = await requiredServer(services.server, args.command).runLlmRequestForCli(parseJsonObject(args.options['input-json']!, '--input-json'));
    if (result.status === 'error') {
      return {
        status: 'error',
        command: args.command,
        code: normalizeServiceErrorCode(result.error.code),
        message: result.error.message,
        fields: primitiveOutputFields(result.outputs ?? {})
      };
    }
    return {
      status: 'ok',
      command: args.command,
      fields: primitiveOutputFields(result.outputs)
    };
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

function requiredServer(server: DebruteAppServer | undefined, command: string): DebruteAppServer {
  if (!server) {
    throw cliError('internal_error', `AppServer is required for ${command}.`);
  }
  return server;
}

function requiredSkillsService(service: DebruteSkillsSyncService | undefined, command: string): DebruteSkillsSyncService {
  if (!service) {
    throw cliError('internal_error', `Skills sync service is required for ${command}.`);
  }
  return service;
}

function skillsDoctorDiagnostics(snapshot: SkillsStatusSnapshot): CliRuntimeDiagnostic[] {
  const diagnostics: CliRuntimeDiagnostic[] = snapshot.diagnostics.map((diagnostic) => ({
    severity: diagnostic.severity === 'error' ? 'error' : 'warning',
    code: diagnostic.code,
    message: skillsDoctorMessage(diagnostic.code, diagnostic.message)
  }));
  if (
    snapshot.state?.debruteVersion
    && snapshot.state.debruteVersion !== snapshot.currentDebruteVersion
  ) {
    diagnostics.push({
      severity: 'warning',
      code: 'skills_out_of_sync',
      message: `Debrute Skills ${snapshot.state.debruteVersion} out of sync with Debrute CLI ${snapshot.currentDebruteVersion}. Run: debrute skills sync`
    });
  }
  if (snapshot.skills.length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'skills_not_installed',
      message: 'No Debrute-managed Skills are installed. Run: debrute skills sync.'
    });
  }
  return diagnostics;
}

function skillsDoctorMessage(code: string, fallback: string): string {
  if (code === 'skills_bundle_unavailable') {
    return 'Bundled Debrute Skills are unavailable. Reinstall Debrute CLI or run from a complete development checkout.';
  }
  return fallback;
}

function imageModelListResult(command: string, models: Array<{ id: string; parameters: Record<string, string> }>): DebruteAgentResult {
  return {
    status: 'ok',
    command,
    records: models.map((model) => ({
      name: 'model',
      fields: {
        id: model.id,
        parameters: JSON.stringify(model.parameters)
      }
    })),
    fields: {
      count: models.length
    }
  };
}

function videoModelListResult(command: string, models: Array<{ id: string; parameters: Record<string, string> }>): DebruteAgentResult {
  return {
    status: 'ok',
    command,
    records: models.map((model) => ({
      name: 'model',
      fields: {
        id: model.id,
        parameters: JSON.stringify(model.parameters)
      }
    })),
    fields: {
      count: models.length
    }
  };
}

function videoModelDetailResult(command: string, model: CliVideoModelDetail): DebruteAgentResult {
  return {
    status: 'ok',
    command,
    records: [
      {
        name: 'model',
        fields: {
          id: model.id
        }
      },
      {
        name: 'official_doc',
        fields: {
          urls: JSON.stringify(model.officialDocUrls),
          snapshot: model.officialSnapshotPath,
          captured_at: model.officialCapturedAt
        }
      }
    ],
    fields: {
      summary: model.summary,
      capabilities: JSON.stringify(model.capabilities),
      arguments_schema: JSON.stringify(model.argumentsSchema),
      description_markdown: model.descriptionMarkdown
    }
  };
}

function imageModelDetailResult(command: string, model: CliImageModelDetail): DebruteAgentResult {
  return {
    status: 'ok',
    command,
    records: [
      {
        name: 'model',
        fields: {
          id: model.id
        }
      },
      {
        name: 'official_doc',
        fields: {
          urls: JSON.stringify(model.officialDocUrls),
          snapshot: model.officialSnapshotPath,
          captured_at: model.officialCapturedAt
        }
      }
    ],
    fields: {
      summary: model.summary,
      capabilities: JSON.stringify(model.capabilities),
      arguments_schema: JSON.stringify(model.argumentsSchema),
      description_markdown: model.descriptionMarkdown
    }
  };
}
