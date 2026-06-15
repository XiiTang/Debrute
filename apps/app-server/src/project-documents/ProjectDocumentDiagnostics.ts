import type { Diagnostic } from '@debrute/canvas-core';
import { serviceError, type ServiceError } from '../server/ServiceErrors.js';

export type ProjectDocumentErrorCode =
  | 'document_push_conflict'
  | 'document_push_failed'
  | 'document_invalid_source'
  | 'document_invalid_pushed'
  | 'document_drift'
  | 'document_descriptor_violation';

export function documentServiceError(
  code: ProjectDocumentErrorCode,
  message: string,
  fields: Record<string, string | number | boolean> = {}
): ServiceError {
  return serviceError(code, message, fields);
}

export function projectDocumentDiagnostic(input: {
  id: string;
  code: string;
  message: string;
  severity: Diagnostic['severity'];
  filePath?: string;
  line?: number;
  column?: number;
  entityId?: string;
}): Diagnostic {
  return {
    id: input.id,
    source: 'project',
    severity: input.severity,
    code: input.code,
    message: input.message,
    ...(input.filePath ? { filePath: input.filePath } : {}),
    ...(input.line !== undefined ? { line: input.line } : {}),
    ...(input.column !== undefined ? { column: input.column } : {}),
    ...(input.entityId ? { entityId: input.entityId } : {})
  };
}
