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

  it('describes Debrute as one Desktop product with runtime-managed CLI and Skills', () => {
    expect(combined).toContain('runtime materializes the matching `debrute` CLI and official Skills');
    expect(combined).toContain('pnpm package:runtime-cli');
    expect(combined).toContain('Project, Canvas Map, and generation commands are runtime-backed');
  });

  it('describes Canvas node ordering as stack order, not layers', () => {
    expect(combined).toContain('node layout, stack order, annotations, and preferences');
    expect(combined).not.toContain('node layout, z-order, annotations, and preferences');
  });
});
