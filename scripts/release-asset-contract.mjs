export const updateManifestName = 'debrute-update-manifest.json';
export const updateManifestSignatureName = 'debrute-update-manifest.json.sig';

export const productReleaseTargets = Object.freeze([
  Object.freeze({ canonicalPlatform: 'macos', hostPlatform: 'darwin', arch: 'arm64', installerExtension: 'dmg' }),
  Object.freeze({ canonicalPlatform: 'macos', hostPlatform: 'darwin', arch: 'x64', installerExtension: 'dmg' }),
  Object.freeze({ canonicalPlatform: 'windows', hostPlatform: 'win32', arch: 'x64', installerExtension: 'exe' })
]);

export function resolveCanonicalProductReleaseTarget(canonicalPlatform, arch) {
  const target = productReleaseTargets.find((candidate) => (
    candidate.canonicalPlatform === canonicalPlatform && candidate.arch === arch
  ));
  if (!target) {
    throw new Error(`Unsupported canonical Product release target: ${canonicalPlatform} ${arch}`);
  }
  return target;
}

export function resolveHostProductReleaseTarget(hostPlatform, arch) {
  const target = productReleaseTargets.find((candidate) => (
    candidate.hostPlatform === hostPlatform && candidate.arch === arch
  ));
  if (!target) {
    throw new Error(`Unsupported host Product release target: ${hostPlatform} ${arch}`);
  }
  return target;
}

export function productInstallerAssetName(version, target) {
  requireProductReleaseTarget(target);
  return `debrute-installer-${version}-${target.canonicalPlatform}-${target.arch}.${target.installerExtension}`;
}

export function expectedProductInstallerAssets(version) {
  return productReleaseTargets.map((target) => productInstallerAssetName(version, target));
}

export function productReleaseAssetName(version, target) {
  requireProductReleaseTarget(target);
  return `debrute-product-${version}-${target.canonicalPlatform}-${target.arch}.zip`;
}

export function expectedProductReleaseAssets(version) {
  return productReleaseTargets.map((target) => productReleaseAssetName(version, target));
}

export function expectedReleaseAssets(version) {
  return [
    ...expectedProductInstallerAssets(version),
    ...expectedProductReleaseAssets(version),
    updateManifestName,
    updateManifestSignatureName
  ];
}

function requireProductReleaseTarget(target) {
  if (!productReleaseTargets.includes(target)) {
    throw new Error('Product release asset names require a canonical Product release target.');
  }
}
