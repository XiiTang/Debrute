import type { AdobeBridgeErrorCode } from '@debrute/app-protocol';

const messages: Record<AdobeBridgeErrorCode, string> = {
  adobe_bridge_disabled: 'Adobe Bridge is disabled.',
  adobe_discovery_unavailable: 'Adobe Bridge discovery is unavailable.',
  adobe_client_offline: 'Photoshop is offline.',
  project_offline: 'Debrute project is offline.',
  project_not_linked: 'Photoshop is not linked to this Debrute project.',
  target_directory_missing: 'The target directory does not exist.',
  target_directory_not_visible: 'The target directory is not visible in the project tree.',
  unsupported_file_type: 'This file type is not supported by Adobe Bridge.',
  upload_too_large: 'The uploaded Photoshop file is too large.',
  invalid_transfer_payload: 'The Adobe Bridge transfer payload is invalid.',
  no_active_document: 'Photoshop has no active document.',
  photoshop_place_failed: 'Photoshop failed to place the file as a Smart Object.',
  transfer_url_expired: 'The Adobe Bridge transfer URL expired.',
  transfer_timeout: 'The Adobe Bridge transfer timed out.'
};

export class AdobeBridgeError extends Error {
  constructor(
    readonly code: AdobeBridgeErrorCode,
    message: string = messages[code],
    readonly fields: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export function createAdobeBridgeError(
  code: AdobeBridgeErrorCode,
  fields: Record<string, unknown> = {}
): AdobeBridgeError {
  return new AdobeBridgeError(code, messages[code], fields);
}

export function adobeBridgeHttpStatus(code: AdobeBridgeErrorCode): number {
  if (code === 'adobe_bridge_disabled' || code === 'adobe_discovery_unavailable') return 503;
  if (code === 'adobe_client_offline' || code === 'project_offline' || code === 'target_directory_missing') return 404;
  if (code === 'project_not_linked') return 403;
  if (code === 'upload_too_large') return 413;
  if (code === 'transfer_timeout') return 504;
  return 400;
}
