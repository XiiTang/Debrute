import type { DebruteProductPlatform } from '@debrute/app-protocol';

export function requireDesktopPlatform(platform: NodeJS.Platform): DebruteProductPlatform {
  if (platform === 'darwin' || platform === 'win32') return platform;
  throw new Error(`Debrute Desktop does not support platform: ${platform}`);
}
