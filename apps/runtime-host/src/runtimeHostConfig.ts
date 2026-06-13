export interface RuntimeHostConfig {
  host: '127.0.0.1';
  daemonPort: number;
  tokenFile: string;
  webDistDir: string;
}

export interface ParseRuntimeHostConfigInput {
  env: NodeJS.ProcessEnv;
}

export function parseRuntimeHostConfig(input: ParseRuntimeHostConfigInput): RuntimeHostConfig {
  const env = input.env;
  return {
    host: '127.0.0.1',
    daemonPort: parsePositiveInteger(requireEnv(env, 'DEBRUTE_RUNTIME_HOST_DAEMON_PORT'), 'DEBRUTE_RUNTIME_HOST_DAEMON_PORT'),
    tokenFile: requireEnv(env, 'DEBRUTE_RUNTIME_HOST_TOKEN_FILE'),
    webDistDir: requireEnv(env, 'DEBRUTE_RUNTIME_HOST_WEB_DIST_DIR')
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}
