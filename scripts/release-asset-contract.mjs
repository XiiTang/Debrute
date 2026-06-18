export const checksumManifestName = 'debrute_SHA256SUMS';

export const desktopReleaseTargets = [
  { platform: 'macos', arch: 'arm64', extension: 'dmg', updateAsset: false },
  { platform: 'macos', arch: 'x64', extension: 'dmg', updateAsset: false },
  { platform: 'macos', arch: 'universal', extension: 'zip', updateAsset: true },
  { platform: 'macos', arch: 'universal', extension: 'zip.blockmap', updateAsset: true },
  { platform: 'windows', arch: 'x64', extension: 'exe', updateAsset: false },
  { platform: 'windows', arch: 'x64', extension: 'exe.blockmap', updateAsset: true },
  { platform: 'linux', arch: 'x64', extension: 'AppImage', updateAsset: false }
];

export const desktopUpdateMetadataAssets = [
  'latest-mac.yml',
  'latest.yml'
];

export const cliReleaseTargetPublicIds = {
  'darwin-arm64': 'macos-arm64',
  'darwin-x64': 'macos-x64',
  'linux-arm64': 'linux-arm64',
  'linux-x64': 'linux-x64',
  'windows-arm64': 'windows-arm64',
  'windows-x64': 'windows-x64'
};

export function cliReleaseAssetName(version, releaseTarget) {
  const publicId = cliReleaseTargetPublicIds[releaseTarget.id];
  if (!publicId) {
    throw new Error(`No public CLI release id for ${releaseTarget.id}.`);
  }
  return `debrute-cli-${version}-${publicId}.${releaseTarget.archiveExtension}`;
}

export function desktopReleaseAssetName(version, platform, arch, extension) {
  return `debrute-desktop-${version}-${platform}-${arch}.${extension}`;
}

export function photoshopUxpReleaseAssetName(version) {
  return `debrute-photoshop-uxp-${version}.ccx`;
}

export function expectedReleaseAssets(version) {
  return [
    ...desktopReleaseTargets.map((target) => desktopReleaseAssetName(version, target.platform, target.arch, target.extension)),
    ...desktopUpdateMetadataAssets,
    `debrute-cli-${version}-macos-arm64.tar.gz`,
    `debrute-cli-${version}-macos-x64.tar.gz`,
    `debrute-cli-${version}-linux-arm64.tar.gz`,
    `debrute-cli-${version}-linux-x64.tar.gz`,
    `debrute-cli-${version}-windows-arm64.zip`,
    `debrute-cli-${version}-windows-x64.zip`,
    photoshopUxpReleaseAssetName(version),
    checksumManifestName
  ];
}
