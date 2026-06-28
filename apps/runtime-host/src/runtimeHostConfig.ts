export interface RuntimeHostConfig {
  host: '127.0.0.1';
  daemonPort: number;
  tokenFile: string;
  webDistDir: string;
  productVersion: string;
  cliPayloadDir: string;
  skillsPayloadDir: string;
  managedBinDir: string;
  managedProductRoot: string;
  productManifestPath: string;
  desktopInstallPath: string;
  replacementHelperPath: string;
  desktopPid?: number;
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
    webDistDir: requireEnv(env, 'DEBRUTE_RUNTIME_HOST_WEB_DIST_DIR'),
    productVersion: requireEnv(env, 'DEBRUTE_RUNTIME_HOST_PRODUCT_VERSION'),
    cliPayloadDir: requireEnv(env, 'DEBRUTE_RUNTIME_HOST_CLI_PAYLOAD_DIR'),
    skillsPayloadDir: requireEnv(env, 'DEBRUTE_RUNTIME_HOST_SKILLS_PAYLOAD_DIR'),
    managedBinDir: requireEnv(env, 'DEBRUTE_RUNTIME_HOST_MANAGED_BIN_DIR'),
    managedProductRoot: requireEnv(env, 'DEBRUTE_RUNTIME_HOST_MANAGED_PRODUCT_ROOT'),
    productManifestPath: requireEnv(env, 'DEBRUTE_RUNTIME_HOST_PRODUCT_MANIFEST_PATH'),
    desktopInstallPath: requireEnv(env, 'DEBRUTE_RUNTIME_HOST_DESKTOP_INSTALL_PATH'),
    replacementHelperPath: requireEnv(env, 'DEBRUTE_RUNTIME_HOST_REPLACEMENT_HELPER_PATH'),
    ...(env.DEBRUTE_RUNTIME_HOST_DESKTOP_PID
      ? { desktopPid: parsePositiveInteger(env.DEBRUTE_RUNTIME_HOST_DESKTOP_PID, 'DEBRUTE_RUNTIME_HOST_DESKTOP_PID') }
      : {})
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
