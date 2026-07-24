const { execFileSync } = require('node:child_process');
const { cpSync, rmSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function verifyLocalMacosApp(context) {
  if (context.electronPlatformName !== 'darwin') {
    throw new Error('Local Desktop packaging supports only macOS.');
  }
  const { verifyLocalMacosApplication } = await import('../../../scripts/local-macos-application.mjs');
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const application = join(context.appOutDir, appName);
  const productSeed = join(application, 'Contents/Resources/product-seed');
  rmSync(productSeed, { recursive: true, force: true });
  cpSync(
    join(context.packager.projectDir, 'dist-electron/product-seed'),
    productSeed,
    { recursive: true, dereference: false }
  );
  execFileSync('/usr/bin/codesign', [
    '--force',
    '--options',
    'runtime',
    '--entitlements',
    join(context.packager.projectDir, 'build/entitlements.mac.plist'),
    '--sign',
    '-',
    application
  ], { stdio: 'inherit' });
  await verifyLocalMacosApplication(application, context.packager.appInfo.version);
};
