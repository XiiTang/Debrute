#!/usr/bin/env node
const { execFileSync } = require('node:child_process');

async function notarizeAndStaple({
  submitPath,
  staplePath = submitPath,
  label = submitPath,
  pollSeconds = 30
}) {
  const credentials = notarizationCredentials();
  const submission = JSON.parse(runNotarytool([
    'submit',
    submitPath,
    ...credentials,
    '--output-format',
    'json'
  ]));
  const submissionId = submission.id;
  if (!submissionId) {
    throw new Error(`Notary submission for ${label} did not return an id.`);
  }

  while (true) {
    const info = await submissionInfo(submissionId, credentials, label);
    if (info?.status === 'Accepted') {
      run('xcrun', ['stapler', 'staple', staplePath]);
      run('xcrun', ['stapler', 'validate', staplePath]);
      return submissionId;
    }
    if (info?.status === 'Invalid' || info?.status === 'Rejected') {
      printNotaryLog(submissionId, credentials);
      throw new Error(`Notary submission ${submissionId} for ${label} finished with ${info.status}.`);
    }
    await sleep(pollSeconds * 1000);
  }
}

async function submissionInfo(submissionId, credentials, label) {
  try {
    return JSON.parse(runNotarytool([
      'info',
      submissionId,
      ...credentials,
      '--output-format',
      'json'
    ]));
  } catch (error) {
    console.warn(`Notary status check for ${label} failed; retrying: ${error.message}`);
    return undefined;
  }
}

function printNotaryLog(submissionId, credentials) {
  try {
    console.error(runNotarytool(['log', submissionId, ...credentials]));
  } catch (error) {
    console.error(`Failed to retrieve notary log for ${submissionId}: ${error.message}`);
  }
}

function notarizationCredentials() {
  const key = requiredEnv('APPLE_API_KEY');
  const keyId = requiredEnv('APPLE_API_KEY_ID');
  const issuer = requiredEnv('APPLE_API_ISSUER');
  return ['--key', key, '--key-id', keyId, '--issuer', issuer];
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for macOS notarization.`);
  }
  return value;
}

function runNotarytool(args) {
  return run('xcrun', ['notarytool', ...args], { capture: true });
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    }).trim();
  } catch (error) {
    const stderr = error.stderr?.toString().trim();
    const stdout = error.stdout?.toString().trim();
    throw new Error([stderr, stdout, error.message].filter(Boolean).join('\n'));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument list: ${argv.join(' ')}`);
    }
    values.set(key, value);
  }
  return values;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const submitPath = args.get('--path');
  if (!submitPath) {
    console.error('--path is required');
    process.exit(1);
  }
  notarizeAndStaple({
    submitPath,
    staplePath: args.get('--staple-path') ?? submitPath,
    label: args.get('--label') ?? submitPath,
    pollSeconds: Number(args.get('--poll-seconds') ?? '30')
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  notarizeAndStaple
};
