import { cliError } from '../errors/cliErrors.js';

export function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw cliError('invalid_json_input', `${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw cliError('invalid_json_input', `${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}
