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
    expect(combined).toContain('Project, Canvas Map, and Model Request commands are Runtime-backed');
  });

  it('describes Canvas node ordering as stack order', () => {
    expect(combined).toContain('node layout, stack order, annotations, and preferences');
  });
});
