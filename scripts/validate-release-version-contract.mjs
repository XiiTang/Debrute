import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export async function releaseVersionContract(root = process.cwd()) {
  const version = await readPackageVersion(root, 'package.json');
  const entries = [
    { label: 'root package', path: 'package.json', version },
    { label: 'Desktop package', path: 'apps/desktop/package.json', version: await readPackageVersion(root, 'apps/desktop/package.json') },
    { label: 'Debrute CLI package', path: 'apps/debrute-cli/package.json', version: await readPackageVersion(root, 'apps/debrute-cli/package.json') },
    ...await readSkillVersionEntries(root)
  ];
  return { version, entries };
}

export async function validateReleaseVersionContract(root = process.cwd()) {
  const contract = await releaseVersionContract(root);
  const mismatches = contract.entries.filter((entry) => entry.version !== contract.version);
  if (mismatches.length > 0) {
    throw new Error([
      `Release version mismatch. Expected every release surface to use ${contract.version}.`,
      ...mismatches.map((entry) => `- ${entry.label} (${entry.path}) uses ${entry.version}`)
    ].join('\n'));
  }
  return contract;
}

async function readPackageVersion(root, relativePath) {
  const parsed = JSON.parse(await readFile(join(root, relativePath), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.version !== 'string') {
    throw new Error(`${relativePath} must declare a string version.`);
  }
  return parsed.version;
}

async function readSkillVersionEntries(root) {
  const skillsRoot = join(root, 'skills');
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const debruteSkillDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('debrute-'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(debruteSkillDirs.map(async (dirName) => {
    const relativePath = `skills/${dirName}/SKILL.md`;
    return {
      label: `${dirName} Skill`,
      path: relativePath,
      version: skillDebruteVersion(await readFile(join(root, relativePath), 'utf8'), relativePath)
    };
  }));
}

function skillDebruteVersion(content, relativePath) {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) {
    throw new Error(`${relativePath} must start with YAML frontmatter.`);
  }
  const frontmatter = parseYaml(match[1] ?? '');
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error(`${relativePath} frontmatter must be a mapping.`);
  }
  const metadata = frontmatter.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || typeof metadata['debrute.version'] !== 'string') {
    throw new Error(`${relativePath} must declare metadata.debrute.version.`);
  }
  return metadata['debrute.version'];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  validateReleaseVersionContract()
    .then((contract) => {
      console.log(`Release version contract passed: ${contract.version}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
