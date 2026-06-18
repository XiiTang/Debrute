import type { AdobeBridgeErrorCode } from '@debrute/app-protocol';

const SUPPORTED_SEND_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.psd']);

const ADOBE_BRIDGE_ERROR_LABELS: Record<AdobeBridgeErrorCode, string> = {
  adobe_bridge_disabled: 'Adobe Bridge is disabled.',
  adobe_discovery_unavailable: 'Adobe Bridge discovery is unavailable.',
  adobe_client_offline: 'Photoshop is offline.',
  project_offline: 'The Debrute project is offline.',
  project_not_linked: 'Connect this project to Photoshop before transferring.',
  target_directory_missing: 'The target directory does not exist.',
  target_directory_not_visible: 'The target directory is not visible in the project tree.',
  unsupported_file_type: 'This project file is not supported by Photoshop transfer.',
  upload_too_large: 'The Photoshop upload is too large.',
  invalid_transfer_payload: 'The Adobe Bridge transfer payload is invalid.',
  no_active_document: 'Photoshop has no active document.',
  photoshop_place_failed: 'Photoshop could not place the file as a Smart Object.',
  transfer_url_expired: 'The transfer URL has expired.',
  transfer_timeout: 'The transfer timed out.'
};

export function adobeBridgeErrorLabel(code: AdobeBridgeErrorCode): string {
  return ADOBE_BRIDGE_ERROR_LABELS[code];
}

export function isSupportedAdobeBridgeWorkbenchFile(projectRelativePath: string): boolean {
  if (
    projectRelativePath === '.git'
    || projectRelativePath.startsWith('.git/')
    || projectRelativePath === '.debrute'
    || projectRelativePath.startsWith('.debrute/')
  ) {
    return false;
  }
  const dotIndex = projectRelativePath.lastIndexOf('.');
  if (dotIndex < 0) {
    return false;
  }
  return SUPPORTED_SEND_EXTENSIONS.has(projectRelativePath.slice(dotIndex).toLowerCase());
}
