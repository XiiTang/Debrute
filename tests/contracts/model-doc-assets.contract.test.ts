import { globSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

interface CatalogModel {
  debruteModelId: string;
}

type ModelKind = 'image' | 'video' | 'audio';

const root = process.cwd();
const snapshotsRoot = join(root, 'assets/model-docs/snapshots');

describe('Runtime model documentation assets', () => {
  it('covers every bundled model exactly once from the stable asset tree', async () => {
    const catalog = JSON.parse(
      await readFile(join(root, 'assets/runtime-model-catalog.json'), 'utf8')
    ) as Record<ModelKind, CatalogModel[]>;

    for (const kind of ['image', 'video', 'audio'] as const) {
      const paths = globSync(`${kind}/**/*.md`, { cwd: snapshotsRoot }).sort();
      const documented = new Map<string, string>();
      expect(paths.length).toBeGreaterThan(0);

      for (const path of paths) {
        const markdown = await readFile(join(snapshotsRoot, path), 'utf8');
        const frontmatter = parseFrontmatter(markdown);
        expect(frontmatter.models.length, path).toBeGreaterThan(0);
        expect(frontmatter.sourceUrls.length, path).toBeGreaterThan(0);
        for (const sourceUrl of frontmatter.sourceUrls) {
          expect(sourceUrl, path).toMatch(/^https:\/\//);
        }
        expect(frontmatter.capturedAt, path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(markdown, path).toContain('cleanup:');
        expect(markdown, path).not.toMatch(/cookie banner|advertisement|site navigation|login prompt/i);

        for (const model of frontmatter.models) {
          expect(documented.has(model), `${model} appears in more than one snapshot`).toBe(false);
          documented.set(model, path);
        }
      }

      expect([...documented.keys()].sort()).toEqual(
        catalog[kind].map((model) => model.debruteModelId).sort()
      );
    }
  });

  it('embeds every stable snapshot in the Rust CLI model description surface', async () => {
    const source = await readFile(join(root, 'apps/runtime/src/cli/model_docs.rs'), 'utf8');
    const paths = globSync('{image,video,audio}/**/*.md', { cwd: snapshotsRoot }).sort();

    for (const path of paths) {
      const repositoryPath = relative(root, join(snapshotsRoot, path)).replaceAll('\\', '/');
      expect(source, repositoryPath).toContain(repositoryPath);
    }
  });
});

function parseFrontmatter(markdown: string): {
  models: string[];
  sourceUrls: string[];
  capturedAt: string;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    throw new Error('Model documentation snapshot is missing YAML frontmatter.');
  }
  const fields = match[1]!.split('\n');
  return {
    models: listField(fields, 'models'),
    sourceUrls: listField(fields, 'source_urls'),
    capturedAt: scalarField(fields, 'captured_at')
  };
}

function listField(lines: string[], name: string): string[] {
  const start = lines.indexOf(`${name}:`);
  if (start < 0) return [];
  return collectList(lines, start + 1);
}

function collectList(lines: string[], start: number): string[] {
  const values: string[] = [];
  for (const line of lines.slice(start)) {
    const item = line.match(/^  - (.+)$/)?.[1];
    if (!item) break;
    values.push(item);
  }
  return values;
}

function scalarField(lines: string[], name: string): string {
  return lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? '';
}
