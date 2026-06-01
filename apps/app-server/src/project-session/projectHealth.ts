import type { ProjectHealthSummary } from '@axis/app-protocol';
import type { AxisProjectMetadata } from '@axis/project-core';
import type { Diagnostic } from '@axis/canvas-core';

export function createProjectHealthSummary(input: {
  metadata: AxisProjectMetadata;
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
