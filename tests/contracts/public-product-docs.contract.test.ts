import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('public product documentation contract', () => {
  const docsRoot = join(process.cwd(), 'docs');
  const docs = readdirSync(docsRoot)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({
      name,
      content: readFileSync(join(docsRoot, name), 'utf8')
    }));
  const combined = docs.map((doc) => `# ${doc.name}\n${doc.content}`).join('\n');

  it('describes Debrute as one Product with a Rust Runtime and Agent-facing CLI', () => {
    expect(combined).toContain('external Agent-facing `debrute` CLI');
    expect(combined).toContain('node scripts/run-cargo-with-native-raster.mjs -- build -p debrute-runtime --bin debrute');
    expect(combined).toContain('Capabilities are structured Runtime-backed operations');
    expect(combined).toContain('`directory` is absolute or relative to the CLI');
    expect(combined).toContain('Model Requests have no Project');
  });

  it('describes Canvas as a Project Tree projection with sparse state', () => {
    expect(combined).toContain('Every regular Project file and directory belongs to every Canvas');
    expect(combined).toContain('`occlusionOrder` contains only visible nodes');
  });
});
