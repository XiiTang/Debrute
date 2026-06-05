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
    diagnosticCounts: {
      errors: input.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
      warnings: input.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length,
      infos: input.diagnostics.filter((diagnostic) => diagnostic.severity === 'info').length
    },
    runtimeDataLocation: input.runtimeDataLocation,
    checkedAt: input.checkedAt
  };
}
