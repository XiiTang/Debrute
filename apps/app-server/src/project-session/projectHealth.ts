import type { ProjectHealthSummary } from '@debrute/app-protocol';
import type { DebruteProjectMetadata } from '@debrute/project-core';
import type { Diagnostic } from '@debrute/canvas-core';

export function createProjectHealthSummary(input: {
  metadata: DebruteProjectMetadata;
  canvasCount: number;
  diagnostics: Diagnostic[];
  runtimeDataLocation: string;
  checkedAt: string;
}): ProjectHealthSummary {
  return {
    projectName: input.metadata.project.name,
    canvasCount: input.canvasCount,
    diagnosticCounts: projectDiagnosticCounts(input.diagnostics),
    runtimeDataLocation: input.runtimeDataLocation,
    checkedAt: input.checkedAt
  };
}

export function projectDiagnosticCounts(
  diagnostics: Diagnostic[]
): ProjectHealthSummary['diagnosticCounts'] {
  return {
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length,
    infos: diagnostics.filter((diagnostic) => diagnostic.severity === 'info').length
  };
}
