export interface ModelRunMetadataRedactionOptions {
  apiKey?: string;
}

const REDACTED = '[redacted]';

const SENSITIVE_FIELD_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'xapikey',
  'apikey',
  'key',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'cookie',
  'setcookie',
  'secret',
  'clientsecret',
  'password',
  'privatekey'
]);

const SENSITIVE_QUERY_PARAM_NAMES = new Set([
  'key',
  'apikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'secret',
  'password',
  'signature',
  'xamzsignature'
]);

export function redactModelRunMetadata(
  value: unknown,
  options: ModelRunMetadataRedactionOptions = {}
): unknown {
  const apiKey = typeof options.apiKey === 'string' && options.apiKey.length > 0 ? options.apiKey : undefined;
  return redactValue(value, apiKey);
}

function redactValue(value: unknown, apiKey: string | undefined): unknown {
  if (typeof value === 'string') {
    return redactString(value, apiKey);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, apiKey));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, childValue]) => [
    key,
    isSensitiveName(key, SENSITIVE_FIELD_NAMES) ? REDACTED : redactValue(childValue, apiKey)
  ]));
}

function redactString(value: string, apiKey: string | undefined): string {
  const withoutApiKey = apiKey ? value.split(apiKey).join(REDACTED) : value;
  const mediaDataUrl = redactMediaDataUrl(withoutApiKey);
  if (mediaDataUrl !== undefined) {
    return mediaDataUrl;
  }
  return redactUrlQueryParams(withoutApiKey);
}

function redactMediaDataUrl(value: string): string | undefined {
  if (!/^data:(image|audio|video)\//i.test(value)) {
    return undefined;
  }
  const payloadIndex = value.indexOf(',');
  return payloadIndex >= 0 ? `${value.slice(0, payloadIndex + 1)}${REDACTED}` : REDACTED;
}

function redactUrlQueryParams(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return value;
  }
  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveName(key, SENSITIVE_QUERY_PARAM_NAMES)) {
      url.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  return changed ? url.toString() : value;
}

function isSensitiveName(name: string, names: Set<string>): boolean {
  return names.has(normalizeName(name));
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '');
}
