import { primitiveFields } from '../output/fieldEncoding.js';

export type AxisCliErrorCode =
  | 'invalid_command'
  | 'invalid_argument'
  | 'missing_argument'
  | 'invalid_input'
  | 'invalid_json_input'
  | 'project_not_found'
  | 'project_invalid'
  | 'project_validation_failed'
  | 'flowmap_invalid_draft_path'
  | 'flowmap_draft_read_failed'
  | 'flowmap_invalid_yaml'
  | 'model_not_configured'
  | 'model_unavailable'
  | 'model_request_failed'
  | 'runtime_config_error'
  | 'runtime_launch_failed'
  | 'runtime_health_failed'
  | 'runtime_state_unreadable'
  | 'runtime_state_write_failed'
  | 'runtime_lock_timeout'
  | 'skills_bundle_unavailable'
  | 'skills_bundle_invalid'
  | 'skills_shared_root_unreadable'
  | 'skills_permission_denied'
  | 'skills_sync_failed'
  | 'skills_state_unreadable'
  | 'skills_io_failed'
  | 'internal_error';

export type AxisCliExitCode = 0 | 1 | 2 | 3 | 4 | 5;

export class AxisCliError extends Error {
  constructor(
    readonly code: AxisCliErrorCode,
    message: string,
    readonly fields: Record<string, string | number | boolean> = {}
  ) {
    super(message);
    this.name = 'AxisCliError';
  }
}

export function cliError(
  code: AxisCliErrorCode,
  message: string,
  fields: Record<string, string | number | boolean> = {}
): AxisCliError {
  return new AxisCliError(code, message, fields);
}

export function isAxisCliError(error: unknown): error is AxisCliError {
  return error instanceof AxisCliError;
}

export function exitCodeForCliError(error: unknown): AxisCliExitCode {
  if (!isAxisCliError(error)) {
    return 5;
  }
  if (
    error.code === 'invalid_command'
    || error.code === 'invalid_argument'
    || error.code === 'missing_argument'
    || error.code === 'invalid_input'
    || error.code === 'invalid_json_input'
  ) {
    return 2;
  }
  if (
    error.code === 'runtime_config_error'
    || error.code === 'runtime_launch_failed'
    || error.code === 'runtime_health_failed'
    || error.code === 'runtime_state_unreadable'
    || error.code === 'runtime_state_write_failed'
    || error.code === 'runtime_lock_timeout'
    || error.code === 'model_not_configured'
    || error.code === 'skills_bundle_unavailable'
    || error.code === 'skills_shared_root_unreadable'
    || error.code === 'skills_permission_denied'
  ) {
    return 3;
  }
  if (error.code === 'model_request_failed' || error.code === 'model_unavailable') {
    return 4;
  }
  if (error.code === 'internal_error') {
    return 5;
  }
  return 1;
}

export function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeServiceErrorCode(code: string): AxisCliErrorCode {
  if (isAxisCliErrorCode(code)) {
    return code;
  }
  if (
    code === 'no_llm_model_configured'
    || code === 'image_model_not_configured'
    || code === 'video_model_not_configured'
  ) {
    return 'model_not_configured';
  }
  if (code === 'image_model_official_doc_missing') {
    return 'runtime_config_error';
  }
  if (code === 'llm_model_unavailable') {
    return 'model_unavailable';
  }
  if (
    code === 'llm_request_failed'
    || code === 'llm_request_timeout'
    || code === 'image_request_failed'
    || code === 'video_request_failed'
    || code === 'request_failed'
    || code === 'response_parse_failed'
  ) {
    return 'model_request_failed';
  }
  if (code === 'invalid_image_input' || code === 'llm_invalid_json') {
    return 'invalid_input';
  }
  return 'internal_error';
}

export function primitiveErrorFields(fields: unknown): AxisCliError['fields'] {
  return primitiveFields(fields);
}

export function projectLoadCliError(error: unknown, projectRoot: string): AxisCliError {
  const code = isNodeError(error) && error.code === 'ENOENT'
    ? 'project_not_found'
    : 'project_invalid';
  return cliError(code, messageFromUnknown(error), { path: projectRoot });
}

function isAxisCliErrorCode(code: string): code is AxisCliErrorCode {
  return [
    'invalid_command',
    'invalid_argument',
    'missing_argument',
    'invalid_input',
    'invalid_json_input',
    'project_not_found',
    'project_invalid',
    'project_validation_failed',
    'flowmap_invalid_draft_path',
    'flowmap_draft_read_failed',
    'flowmap_invalid_yaml',
    'model_not_configured',
    'model_unavailable',
    'model_request_failed',
    'runtime_config_error',
    'runtime_launch_failed',
    'runtime_health_failed',
    'runtime_state_unreadable',
    'runtime_state_write_failed',
    'runtime_lock_timeout',
    'skills_bundle_unavailable',
    'skills_bundle_invalid',
    'skills_shared_root_unreadable',
    'skills_permission_denied',
    'skills_sync_failed',
    'skills_state_unreadable',
    'skills_io_failed',
    'internal_error'
  ].includes(code);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}
