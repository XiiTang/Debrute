const DEFAULT_STAGES = [
  { name: 'doctor', script: 'doctor' },
  { name: 'generate:control-protocol', script: 'generate:control-protocol' },
  { name: 'check:typescript', script: 'check:typescript' },
  { name: 'check:rust', script: 'check:rust' },
  { name: 'test', script: 'test' },
  { name: 'test:rust', script: 'test:rust' },
  { name: 'lint:arch', script: 'lint:arch' },
  { name: 'build:artifacts', script: 'build:artifacts' }
];

export function parseVerificationArguments(arguments_) {
  if (arguments_.length === 0) return { allRustTargets: false };
  if (arguments_.length === 1 && arguments_[0] === '--all-rust-targets') {
    return { allRustTargets: true };
  }
  const unknown = arguments_.find((argument) => argument !== '--all-rust-targets')
    ?? arguments_[1]
    ?? arguments_[0];
  throw new Error(`Unknown verify argument: ${unknown}`);
}

export function verificationStages({ allRustTargets = false } = {}) {
  return DEFAULT_STAGES.map((stage) => stage.script === 'check:rust' && allRustTargets
    ? { name: 'check:rust:all', script: 'check:rust:all' }
    : { ...stage });
}

export async function runVerification({
  allRustTargets = false,
  runScript,
  now = () => performance.now(),
  write = (value) => process.stdout.write(value)
}) {
  if (typeof runScript !== 'function') {
    throw new TypeError('runVerification requires a runScript function.');
  }

  const results = [];
  for (const stage of verificationStages({ allRustTargets })) {
    write(`[verify] ${stage.name}\n`);
    const startedAt = now();
    try {
      await runScript(stage.script);
      results.push({
        name: stage.name,
        status: 'passed',
        durationMs: now() - startedAt
      });
    } catch (error) {
      results.push({
        name: stage.name,
        status: 'failed',
        durationMs: now() - startedAt
      });
      writeSummary(results, write);
      throw error;
    }
  }
  writeSummary(results, write);
}

function writeSummary(results, write) {
  const labelWidth = Math.max('total'.length, ...results.map(({ name }) => name.length));
  write('\nVerification summary\n');
  for (const result of results) {
    const failure = result.status === 'failed' ? ' failed' : '';
    write(`  ${result.name.padEnd(labelWidth)}${failure} ${formatDuration(result.durationMs)}\n`);
  }
  const totalMs = results.reduce((sum, { durationMs }) => sum + durationMs, 0);
  write(`  ${'total'.padEnd(labelWidth)} ${formatDuration(totalMs)}\n`);
}

function formatDuration(durationMs) {
  return `${(durationMs / 1_000).toFixed(2)}s`;
}
