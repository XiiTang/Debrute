import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRoot = resolve(repositoryRoot, 'apps/web/node_modules/@phosphor-icons/core');
const { icons } = await import(pathToFileURL(resolve(coreRoot, 'dist/index.mjs')).href);
const orderedIcons = [...icons].sort((left, right) => left.name.localeCompare(right.name, 'en'));
const unresolvedFeedbackIconName = 'question';
if (!orderedIcons.some(({ name }) => name === unresolvedFeedbackIconName)) {
  throw new Error(`Missing unresolved Feedback icon: ${unresolvedFeedbackIconName}`);
}
const configurableIcons = orderedIcons.filter(({ name }) => name !== unresolvedFeedbackIconName);

const manifestPath = resolve(
  repositoryRoot,
  'apps/web/src/workbench/feedback/generatedFeedbackIconManifest.ts'
);
const namesPath = resolve(
  repositoryRoot,
  'apps/web/src/workbench/feedback/generatedFeedbackIconNames.ts'
);
const spritePath = resolve(repositoryRoot, 'apps/web/src/workbench/feedback/phosphor-fill.svg');
const runtimeNamesPath = resolve(
  repositoryRoot,
  'apps/runtime/src/global/feedback_icon_names.txt'
);
const licensePath = resolve(
  repositoryRoot,
  'apps/web/public/licenses/phosphor-icons-MIT.txt'
);
await Promise.all([
  mkdir(dirname(manifestPath), { recursive: true }),
  mkdir(dirname(runtimeNamesPath), { recursive: true }),
  mkdir(dirname(licensePath), { recursive: true })
]);

const manifest = configurableIcons.map((icon) => ({
  name: icon.name,
  categories: icon.categories,
  tags: icon.tags.filter((tag) => tag !== '*new*')
}));
await writeFile(
  manifestPath,
  `// Generated from @phosphor-icons/core@2.1.1 by scripts/generate-feedback-icons.mjs.\n`
    + `export const FEEDBACK_ICON_MANIFEST = ${JSON.stringify(manifest)} as const;\n`,
  'utf8'
);
await writeFile(
  namesPath,
  `// Generated from @phosphor-icons/core@2.1.1 by scripts/generate-feedback-icons.mjs.\n`
    + `export const UNRESOLVED_FEEDBACK_ICON_NAME = ${JSON.stringify(unresolvedFeedbackIconName)};\n`
    + `export const FEEDBACK_ICON_NAMES = ${JSON.stringify(orderedIcons.map(({ name }) => name))} as const;\n`,
  'utf8'
);

const symbols = await Promise.all(orderedIcons.map(async ({ name }) => {
  const source = await readFile(resolve(coreRoot, `assets/fill/${name}-fill.svg`), 'utf8');
  const body = source
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '');
  return `<symbol id="phosphor-fill-${name}" viewBox="0 0 256 256">${body}</symbol>`;
}));
await writeFile(
  spritePath,
  `<svg xmlns="http://www.w3.org/2000/svg"><defs>${symbols.join('')}</defs></svg>\n`,
  'utf8'
);
await writeFile(
  runtimeNamesPath,
  `${configurableIcons.map(({ name }) => name).join('\n')}\n`,
  'utf8'
);
await writeFile(
  licensePath,
  (await readFile(resolve(coreRoot, 'LICENSE'), 'utf8')).replaceAll('\r\n', '\n'),
  'utf8'
);
