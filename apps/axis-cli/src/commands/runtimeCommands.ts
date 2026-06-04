import type { AxisAppServer, CliImageModelDetail, CliRuntimeDiagnostic } from '@axis/app-server';
import type { SkillsStatusSnapshot, SkillsSyncSnapshot } from '@axis/app-protocol';
import type { AxisSkillsSyncService } from '@axis/capability-runtime';
import { cliError, normalizeServiceErrorCode } from '../errors/cliErrors.js';
import { parseJsonObject } from '../parser/jsonInput.js';
import { primitiveOutputFields } from '../output/fieldEncoding.js';
import { commandSpecRecords, commandSpecs, specForCommandPath } from './helpSpec.js';
import type { ParsedAxisArgs } from '../parser/parseAxisArgs.js';
import type { AgentNamedRecord, AxisAgentResult } from '../output/renderAgentRecord.js';

export interface RuntimeCommandServices {
  server?: AxisAppServer;
  skillsService?: AxisSkillsSyncService;
}

export async function runRuntimeCommand(args: ParsedAxisArgs, services: RuntimeCommandServices = {}): Promise<AxisAgentResult> {
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
      throw cliError('invalid_command', `Unknown AXIS CLI command: ${args.positional.join(' ')}`);
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
    return modelListResult(args.command, models);
  }

  if (args.command === 'models.image.describe') {
    const model = await requiredServer(services.server, args.command).describeImageModelForCli(args.positional[0]!);
    return imageModelDetailResult(args.command, model);
  }

  if (args.command === 'models.video.describe') {
    const model = await requiredServer(services.server, args.command).describeVideoModelForCli(args.positional[0]!);
    return modelDetailResult(args.command, model);
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

  throw cliError('invalid_command', `Unknown AXIS CLI command: ${args.command}`);
}

function skillsStatusResult(command: string, snapshot: SkillsStatusSnapshot): AxisAgentResult {
  return {
    status: 'ok',
    command,
    records: [
      ...snapshot.skills.map((skill): AgentNamedRecord => ({
        name: 'skill',
        fields: {
          name: skill.name,
          source: skill.source,
          version: skill.axisVersion,
          path: skill.skillPath
        }
      })),
      ...snapshot.diagnostics.map((diagnostic): AgentNamedRecord => ({
        name: 'diagnostic',
        fields: {
          source: diagnostic.source,
          code: diagnostic.code,
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
      axis_version: snapshot.currentAxisVersion,
      bundled_root: snapshot.bundledSkillsRoot,
      missing_bundled_skills: snapshot.missingBundledSkillCount
    }
  };
}

function skillsSyncResult(command: string, snapshot: SkillsSyncSnapshot): AxisAgentResult {
  return {
    status: 'ok',
    command,
    records: [
      ...snapshot.updatedSkills.map((skill): AgentNamedRecord => ({
        name: 'updated_skill',
        fields: {
          name: skill.name,
          version: skill.axisVersion,
          path: skill.skillPath
        }
      })),
      ...snapshot.diagnostics.map((diagnostic): AgentNamedRecord => ({
        name: 'diagnostic',
        fields: {
          source: diagnostic.source,
          code: diagnostic.code,
          path: diagnostic.path,
          message: diagnostic.message
        }
      }))
    ],
    fields: {
      updated: snapshot.updatedSkills.length,
      diagnostics: snapshot.diagnostics.length,
      state_path: snapshot.statePath,
      force: snapshot.force
    }
  };
}

function requiredServer(server: AxisAppServer | undefined, command: string): AxisAppServer {
  if (!server) {
    throw cliError('internal_error', `AppServer is required for ${command}.`);
  }
  return server;
}

function requiredSkillsService(service: AxisSkillsSyncService | undefined, command: string): AxisSkillsSyncService {
  if (!service) {
    throw cliError('internal_error', `Skills sync service is required for ${command}.`);
  }
  return service;
}

function skillsDoctorDiagnostics(snapshot: SkillsStatusSnapshot): CliRuntimeDiagnostic[] {
  const diagnostics: CliRuntimeDiagnostic[] = snapshot.diagnostics.map((diagnostic) => ({
    severity: 'warning',
    code: diagnostic.code,
    message: skillsDoctorMessage(diagnostic.code, diagnostic.message)
  }));
  if (snapshot.skills.length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'skills_not_installed',
      message: `No AXIS-managed Skills are installed. Run: axis skills sync --force.`
    });
  }
  return diagnostics;
}

function skillsDoctorMessage(code: string, fallback: string): string {
  if (code === 'skills_bundle_unavailable') {
    return 'Bundled AXIS Skills are unavailable. Reinstall AXIS CLI or run from a complete development checkout.';
  }
  return fallback;
}

function imageModelListResult(command: string, models: Array<{ id: string; parameters: Record<string, string> }>): AxisAgentResult {
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

function modelListResult(command: string, models: Array<{ id: string }>): AxisAgentResult {
  return {
    status: 'ok',
    command,
    records: models.map((model) => ({
      name: 'model',
      fields: {
        id: model.id
      }
    })),
    fields: {
      count: models.length
    }
  };
}

function modelDetailResult(
  command: string,
  model: {
    id: string;
    summary: string;
    argumentsSchema: Record<string, unknown>;
    capabilities: Record<string, unknown>;
    usageNotes: string;
  }
): AxisAgentResult {
  return {
    status: 'ok',
    command,
    records: [{
      name: 'model',
      fields: {
        id: model.id
      }
    }],
    fields: {
      summary: model.summary,
      capabilities: JSON.stringify(model.capabilities),
      arguments_schema: JSON.stringify(model.argumentsSchema),
      usage: model.usageNotes
    }
  };
}

function imageModelDetailResult(command: string, model: CliImageModelDetail): AxisAgentResult {
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
