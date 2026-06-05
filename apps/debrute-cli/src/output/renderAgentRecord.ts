import type { DebruteCliErrorCode } from '../errors/cliErrors.js';

export type AgentRecordValue = string | number | boolean | null | undefined;

export interface AgentNamedRecord {
  name: string;
  fields: Record<string, AgentRecordValue>;
}

export type DebruteAgentResult =
  | {
      status: 'ok';
      command: string;
      fields?: Record<string, AgentRecordValue>;
      records?: AgentNamedRecord[];
    }
  | {
      status: 'error';
      command: string;
      code: DebruteCliErrorCode;
      message: string;
      fields?: Record<string, AgentRecordValue>;
      records?: AgentNamedRecord[];
    };

export function renderAgentRecord(result: DebruteAgentResult): string {
  const lines = result.status === 'ok'
    ? [`debrute/1 ok cmd=${formatValue(result.command)}`]
    : [
        `debrute/1 error cmd=${formatValue(result.command)} code=${formatValue(result.code)}`,
        `message=${formatValue(result.message)}`
      ];

  for (const record of result.records ?? []) {
    lines.push(`${record.name}${formatFields(record.fields)}`);
  }
  for (const [key, value] of Object.entries(result.fields ?? {})) {
    if (value !== undefined) {
      lines.push(`${key}=${formatValue(value)}`);
    }
  }
  return lines.join('\n');
}

function formatFields(fields: Record<string, AgentRecordValue>): string {
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  return pairs.length > 0 ? ` ${pairs.join(' ')}` : '';
}

function formatValue(value: AgentRecordValue): string {
  if (value === undefined || value === null) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return needsQuotes(value) ? `"${escapeValue(value)}"` : value;
}

function needsQuotes(value: string): boolean {
  return value.length === 0 || /[\s="\\\n\r]/.test(value);
}

function escapeValue(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('"', '\\"');
}
