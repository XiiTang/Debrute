export const checksumManifestName = 'debrute_SHA256SUMS';

export const desktopReleaseTargets = [
  { platform: 'macos', arch: 'arm64', extension: 'dmg' },
  { platform: 'macos', arch: 'x64', extension: 'dmg' },
  { platform: 'windows', arch: 'x64', extension: 'exe' },
  { platform: 'linux', arch: 'x64', extension: 'AppImage' }
];

export function desktopReleaseAssetName(version, platform, arch, extension) {
  return `debrute-desktop-${version}-${platform}-${arch}.${extension}`;
}

export function expectedReleaseAssets(version) {
  return [
    ...desktopReleaseTargets.map((target) => desktopReleaseAssetName(version, target.platform, target.arch, target.extension)),
    checksumManifestName
  ];
}
