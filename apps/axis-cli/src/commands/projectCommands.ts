import type { ProjectSessionSnapshot } from '@axis/app-protocol';
import type { AxisAppServer } from '@axis/app-server';
import { cliError, normalizeServiceErrorCode, primitiveErrorFields, projectLoadCliError } from '../errors/cliErrors.js';
import type { ParsedAxisArgs } from '../parser/parseAxisArgs.js';
import type { AgentNamedRecord, AxisAgentResult } from '../output/renderAgentRecord.js';

export async function runProjectCommand(args: ParsedAxisArgs, server: AxisAppServer): Promise<AxisAgentResult> {
  if (!args.projectRoot) {
    throw cliError('missing_argument', `${args.command} requires <project>.`);
  }

  if (args.command === 'project.init') {
    return projectSnapshotResult(args.command, await server.initProjectForCli(args.projectRoot));
  }

  if (args.command === 'project.status') {
    return projectSnapshotResult(args.command, await projectSnapshot(server, args.projectRoot));
  }

  if (args.command === 'project.validate') {
    const snapshot = await projectSnapshot(server, args.projectRoot);
    if (snapshot.health.diagnosticCounts.errors > 0) {
      return {
        status: 'error',
        command: args.command,
        code: 'project_validation_failed',
        message: 'Project validation failed.',
        records: diagnosticRecords(snapshot),
        fields: diagnosticCountFields(snapshot)
      };
    }
    return {
      ...projectSnapshotResult(args.command, snapshot),
      records: diagnosticRecords(snapshot)
    };
  }

  if (args.command === 'flowmap.publish') {
    try {
      await server.publishFlowmapDraftForProject(args.projectRoot, { sourceDraftPath: args.options.from! });
    } catch (error) {
      if (isServiceError(error)) {
        throw cliError(normalizeServiceErrorCode(error.code), error.message, primitiveErrorFields(error.fields));
      }
      throw projectLoadCliError(error, args.projectRoot);
    }
    return {
      status: 'ok',
      command: args.command,
      fields: { source: args.options.from! }
    };
  }

  if (args.command === 'generated-asset.lookup') {
    const lookup = await server.lookupGeneratedAssetMetadataForCli(args.projectRoot, { projectRelativePath: args.options.path! });
    return {
      status: 'ok',
      command: args.command,
      fields: generatedAssetLookupFields(lookup)
    };
  }

  throw cliError('invalid_command', `Unknown AXIS CLI command: ${args.command}`);
}

async function projectSnapshot(server: AxisAppServer, projectRoot: string): Promise<ProjectSessionSnapshot> {
  try {
    return await server.projectStatusForCli(projectRoot);
  } catch (error) {
    throw projectLoadCliError(error, projectRoot);
  }
}

function projectSnapshotResult(command: string, snapshot: ProjectSessionSnapshot): AxisAgentResult {
  return {
    status: 'ok',
    command,
    fields: {
      project_root: snapshot.projectRoot,
      project_name: snapshot.health.projectName,
      canvases: snapshot.health.canvasCount,
      ...diagnosticCountFields(snapshot)
    }
  };
}

function diagnosticCountFields(snapshot: ProjectSessionSnapshot) {
  return {
    errors: snapshot.health.diagnosticCounts.errors,
    warnings: snapshot.health.diagnosticCounts.warnings,
    infos: snapshot.health.diagnosticCounts.infos
  };
}

function diagnosticRecords(snapshot: ProjectSessionSnapshot): AgentNamedRecord[] {
  return snapshot.diagnostics.map((diagnostic) => ({
    name: 'diagnostic',
    fields: {
      id: diagnostic.id,
      source: diagnostic.source,
      severity: diagnostic.severity,
      code: diagnostic.code,
      path: diagnostic.filePath,
      message: diagnostic.message
    }
  }));
}

function generatedAssetLookupFields(lookup: Awaited<ReturnType<AxisAppServer['lookupGeneratedAssetMetadata']>>) {
  if (lookup.status === 'unavailable') {
    return {
      status: lookup.status,
      reason: lookup.reason,
      message: lookup.message
    };
  }
  return {
    status: lookup.status,
    hash: lookup.fingerprint.hash,
    records: lookup.status === 'matched' ? lookup.records.length : 0,
    metadata: JSON.stringify(lookup)
  };
}

function isServiceError(error: unknown): error is Error & { code: string; fields?: unknown } {
  return error instanceof Error
    && typeof (error as { code?: unknown }).code === 'string'
    && 'fields' in error;
}
