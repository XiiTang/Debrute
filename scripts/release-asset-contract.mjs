import { FFMPEG_SOURCE_ARCHIVE_NAME } from './canvas-video-tools-payload.mjs';

export const updateManifestName = 'debrute-update-manifest.json';
export const updateManifestSignatureName = 'debrute-update-manifest.json.sig';
export const ffmpegSourceReleaseAssetName = FFMPEG_SOURCE_ARCHIVE_NAME;

export const productInstallerTargets = [
  { platform: 'macos', arch: 'arm64', extension: 'dmg' },
  { platform: 'macos', arch: 'x64', extension: 'dmg' },
  { platform: 'windows', arch: 'x64', extension: 'exe' }
];

export const productReleaseTargets = productInstallerTargets;

export function productInstallerAssetName(version, platform, arch, extension) {
  return `debrute-installer-${version}-${platform}-${arch}.${extension}`;
}

export function expectedProductInstallerAssets(version) {
  return productInstallerTargets.map((target) => productInstallerAssetName(
    version,
    target.platform,
    target.arch,
    target.extension
  ));
}

export function productReleaseAssetName(version, platform, arch) {
  return `debrute-product-${version}-${platform}-${arch}.zip`;
}

export function expectedProductReleaseAssets(version) {
  return productReleaseTargets.map((target) => productReleaseAssetName(
    version,
    target.platform,
    target.arch
  ));
}

export function expectedReleaseAssets(version) {
  return [
    ...expectedProductInstallerAssets(version),
    ...expectedProductReleaseAssets(version),
    ffmpegSourceReleaseAssetName,
    updateManifestName,
    updateManifestSignatureName
  ];
}
