import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('Rust Debrute CLI packaging boundary', () => {
  it('builds the agent CLI from the Runtime Cargo package', () => {
    const cargo = source('apps/runtime/Cargo.toml');
    const binary = source('apps/runtime/src/bin/debrute.rs');

    expect(cargo).toContain('name = "debrute-runtime"');
    expect(binary).toContain('fn main() -> ExitCode');
    expect(binary).toContain('parse_cli_args');
    expect(binary).toContain('CreateCliAuthorization');
  });
});
