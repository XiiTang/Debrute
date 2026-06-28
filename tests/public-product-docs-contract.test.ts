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

  it('does not keep standalone CLI release, old updater metadata, or manual Skills sync instructions', () => {
    for (const removed of [
      'Debrute CLI archives',
      'debrute-cli-X.Y.Z',
      'latest.yml',
      '.blockmap',
      'pnpm package:cli',
      'pnpm package:cli:all',
      'release/debrute-cli',
      'Settings under **Debrute CLI**',
      'debrute skills sync',
      'skills sync --force',
      'One-shot project, Canvas Map, and generation commands do not require the Workbench daemon.'
    ]) {
      expect(combined).not.toContain(removed);
    }
  });
});
