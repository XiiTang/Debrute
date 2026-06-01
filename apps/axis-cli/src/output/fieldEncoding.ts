export type PrimitiveFieldRecord = Record<string, string | number | boolean>;

export function primitiveOutputFields(outputs: Record<string, unknown>): PrimitiveFieldRecord {
  return primitiveFields(outputs);
}

export function primitiveFields(fields: unknown): PrimitiveFieldRecord {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {};
  }
  return Object.fromEntries(Object.entries(fields)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) as Record<string, string | number | boolean>;
}
