import { globSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface CatalogModel {
  debruteModelId: string;
  listParameters: Record<string, string>;
  argumentsSchema: { properties: Record<string, unknown> };
  requestExample: {
    command: string;
    input: { arguments: Record<string, unknown>; output?: Record<string, string> };
  };
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

  it('uses the shared Model Request envelope for every bundled example', async () => {
    const catalog = JSON.parse(
      await readFile(join(root, 'assets/runtime-model-catalog.json'), 'utf8')
    ) as Record<ModelKind, CatalogModel[]>;

    for (const model of [...catalog.image, ...catalog.video, ...catalog.audio]) {
      expect(model.requestExample.command, model.debruteModelId).toBe('request.single');
      expect(model.requestExample.input.model, model.debruteModelId).toBe(model.debruteModelId);
      expect(model.requestExample.input.arguments, model.debruteModelId).toEqual(expect.any(Object));
      if (model.requestExample.input.output !== undefined) {
        const outputFields = Object.keys(model.requestExample.input.output);
        expect(outputFields.length, model.debruteModelId).toBeGreaterThan(0);
        expect(outputFields.every((field) => field === 'directory' || field === 'filename')).toBe(true);
      }
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
