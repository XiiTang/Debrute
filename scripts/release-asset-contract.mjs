export const updateManifestName = 'debrute-update-manifest.json';
export const updateManifestSignatureName = 'debrute-update-manifest.json.sig';

export const desktopReleaseTargets = [
  { platform: 'macos', arch: 'arm64', extension: 'dmg' },
  { platform: 'macos', arch: 'x64', extension: 'dmg' },
  { platform: 'windows', arch: 'x64', extension: 'exe' }
];

export const productReleaseTargets = desktopReleaseTargets;

export function desktopReleaseAssetName(version, platform, arch, extension) {
  return `debrute-desktop-${version}-${platform}-${arch}.${extension}`;
}

export function expectedDesktopReleaseAssets(version) {
  return desktopReleaseTargets.map((target) => desktopReleaseAssetName(
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
    ...expectedDesktopReleaseAssets(version),
    ...expectedProductReleaseAssets(version),
    updateManifestName,
    updateManifestSignatureName
  ];
}
