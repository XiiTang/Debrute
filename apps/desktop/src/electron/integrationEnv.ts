const MACOS_INTEGRATION_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin'
];

export interface DesktopIntegrationEnvInput {
  platform?: NodeJS.Platform;
  envPath?: string;
}

export function resolveDesktopIntegrationEnvPath(input: DesktopIntegrationEnvInput = {}): string {
  const platform = input.platform ?? process.platform;
  const delimiter = platform === 'win32' ? ';' : ':';
  const entries = splitPath(input.envPath ?? process.env.PATH ?? '', delimiter);
  if (platform === 'darwin') {
    entries.push(...MACOS_INTEGRATION_PATHS);
  }
  return [...new Set(entries)].join(delimiter);
}

function splitPath(value: string, delimiter: string): string[] {
  return value.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}
