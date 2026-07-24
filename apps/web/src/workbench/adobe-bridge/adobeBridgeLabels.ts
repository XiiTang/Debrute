import type { AdobeBridgeErrorCode } from '@debrute/app-protocol';
import type { WorkbenchI18n, WorkbenchTranslationKey } from '../i18n';

const SUPPORTED_SEND_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.psd']);

const ADOBE_BRIDGE_ERROR_KEYS: Partial<Record<AdobeBridgeErrorCode, WorkbenchTranslationKey>> = {
  adobe_bridge_disabled: 'adobeBridge.error.adobe_bridge_disabled',
  adobe_discovery_unavailable: 'adobeBridge.error.adobe_discovery_unavailable',
  adobe_client_offline: 'adobeBridge.error.adobe_client_offline',
  project_offline: 'adobeBridge.error.project_offline',
  project_not_linked: 'adobeBridge.error.project_not_linked',
  target_directory_missing: 'adobeBridge.error.target_directory_missing',
  target_directory_not_visible: 'adobeBridge.error.target_directory_not_visible',
  unsupported_file_type: 'adobeBridge.error.unsupported_file_type',
  upload_too_large: 'adobeBridge.error.upload_too_large',
  invalid_transfer_payload: 'adobeBridge.error.invalid_transfer_payload',
  no_active_document: 'adobeBridge.error.no_active_document',
  photoshop_place_failed: 'adobeBridge.error.photoshop_place_failed',
  transfer_url_expired: 'adobeBridge.error.transfer_url_expired',
  transfer_timeout: 'adobeBridge.error.transfer_timeout'
};

export function adobeBridgeErrorLabel(code: AdobeBridgeErrorCode, i18n: WorkbenchI18n): string {
  const key = ADOBE_BRIDGE_ERROR_KEYS[code];
  return key ? i18n.t(key) : code;
}

export function isSupportedAdobeBridgeWorkbenchFile(projectRelativePath: string): boolean {
  if (isProjectInternalNamespacePath(projectRelativePath)) {
    return false;
  }
  const dotIndex = projectRelativePath.lastIndexOf('.');
  if (dotIndex < 0) {
    return false;
  }
  return SUPPORTED_SEND_EXTENSIONS.has(projectRelativePath.slice(dotIndex).toLowerCase());
}

function isProjectInternalNamespacePath(projectRelativePath: string): boolean {
  const firstSegment = projectRelativePath.split('/', 1)[0];
  const firstSegmentKey = firstSegment?.toLowerCase();
  return firstSegmentKey === '.git' || firstSegmentKey === '.debrute';
}
