const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { notarizeAndStaple } = require('../../../scripts/notarize-macos-artifact.cjs');

exports.default = async function notarizeMacosApp(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);
  const tempDir = mkdtempSync(join(tmpdir(), 'debrute-notarize-app-'));
  const zipPath = join(tempDir, `${appName}.zip`);
  try {
    execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, zipPath], { stdio: 'inherit' });
    await notarizeAndStaple({
      submitPath: zipPath,
      staplePath: appPath,
      label: appName
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};
