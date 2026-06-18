export interface RuntimeSecretRedactionOptions {
  secrets?: string[];
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

export function redactRuntimeSecrets(
  value: unknown,
  options: RuntimeSecretRedactionOptions = {}
): unknown {
  return redactValue(value, normalizedSecrets(options.secrets));
}

export function redactRuntimeSecretString(
  value: string,
  options: RuntimeSecretRedactionOptions = {}
): string {
  return redactString(value, normalizedSecrets(options.secrets));
}

function normalizedSecrets(secrets: string[] | undefined): string[] {
  return [...new Set((secrets ?? []).map((secret) => secret.trim()).filter(Boolean))];
}

function redactValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    return redactString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, childValue]) => [
    key,
    isSensitiveName(key, SENSITIVE_FIELD_NAMES) ? REDACTED : redactValue(childValue, secrets)
  ]));
}

function redactString(value: string, secrets: string[]): string {
  const withoutSecrets = secrets.reduce((current, secret) => current.split(secret).join(REDACTED), value);
  const mediaDataUrl = redactMediaDataUrl(withoutSecrets);
  if (mediaDataUrl !== undefined) {
    return mediaDataUrl;
  }
  return redactUrlQueryParams(withoutSecrets);
}

function redactMediaDataUrl(value: string): string | undefined {
  if (!/^data:(image|audio|video)\//i.test(value)) {
    return undefined;
  }
  const payloadIndex = value.indexOf(',');
  return payloadIndex >= 0 ? `${value.slice(0, payloadIndex + 1)}${REDACTED}` : REDACTED;
}

function redactUrlQueryParams(value: string): string {
  const redactedInlineUrls = value.replace(/https?:\/\/[^\s"'<>]+/g, (url) => redactSingleUrlQueryParams(url));
  if (redactedInlineUrls !== value) {
    return redactedInlineUrls;
  }
  return redactSingleUrlQueryParams(value);
}

function redactSingleUrlQueryParams(value: string): string {
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
