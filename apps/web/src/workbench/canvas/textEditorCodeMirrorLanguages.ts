import type { ProjectTextLanguageId } from '@debrute/project-core';
import type { Extension } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { sass } from '@codemirror/lang-sass';
import { less } from '@codemirror/lang-less';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { php } from '@codemirror/lang-php';
import { sql } from '@codemirror/lang-sql';
import { go } from '@codemirror/lang-go';
import { rust } from '@codemirror/lang-rust';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { xml } from '@codemirror/lang-xml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { r } from '@codemirror/legacy-modes/mode/r';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { textile } from '@codemirror/legacy-modes/mode/textile';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';

export type CodeMirrorLanguageKind =
  | 'plain'
  | 'markdown'
  | 'json'
  | 'yaml'
  | 'html'
  | 'css'
  | 'scss'
  | 'less'
  | 'xml'
  | 'javascript'
  | 'javascriptreact'
  | 'typescript'
  | 'typescriptreact'
  | 'python'
  | 'php'
  | 'sql'
  | 'go'
  | 'rust'
  | 'java'
  | 'cpp'
  | 'shell'
  | 'dockerfile'
  | 'diff'
  | 'ruby'
  | 'lua'
  | 'perl'
  | 'r'
  | 'powershell'
  | 'properties'
  | 'toml'
  | 'tex'
  | 'textile'
  | 'protobuf';

const codeMirrorLanguageKinds = {
  plaintext: 'plain',
  markdown: 'markdown',
  json: 'json',
  jsonc: 'json',
  jsonl: 'json',
  yaml: 'yaml',
  shell: 'shell',
  dotenv: 'plain',
  ini: 'plain',
  properties: 'properties',
  log: 'plain',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  xml: 'xml',
  javascript: 'javascript',
  javascriptreact: 'javascriptreact',
  typescript: 'typescript',
  typescriptreact: 'typescriptreact',
  python: 'python',
  ruby: 'ruby',
  php: 'php',
  sql: 'sql',
  powershell: 'powershell',
  bat: 'plain',
  go: 'go',
  rust: 'rust',
  java: 'java',
  c: 'cpp',
  cpp: 'cpp',
  lua: 'lua',
  perl: 'perl',
  r: 'r',
  dockerfile: 'dockerfile',
  makefile: 'plain',
  diff: 'diff',
  csv: 'plain',
  tsv: 'plain',
  subtitle: 'plain',
  webvtt: 'plain',
  toml: 'toml',
  tex: 'tex',
  textile: 'textile',
  protobuf: 'protobuf',
  restructuredtext: 'plain',
  asciidoc: 'plain',
  org: 'plain'
} satisfies Record<ProjectTextLanguageId, CodeMirrorLanguageKind>;

export function codeMirrorLanguageKindForProjectTextLanguage(
  language: ProjectTextLanguageId
): CodeMirrorLanguageKind {
  return codeMirrorLanguageKinds[language];
}

export function codeMirrorLanguageExtensionForProjectTextLanguage(
  language: ProjectTextLanguageId
): Extension {
  switch (codeMirrorLanguageKindForProjectTextLanguage(language)) {
    case 'markdown':
      return markdown();
    case 'json':
      return json();
    case 'yaml':
      return yaml();
    case 'html':
      return html();
    case 'css':
      return css();
    case 'scss':
      return sass();
    case 'less':
      return less();
    case 'xml':
      return xml();
    case 'javascript':
      return javascript();
    case 'javascriptreact':
      return javascript({ jsx: true });
    case 'typescript':
      return javascript({ typescript: true });
    case 'typescriptreact':
      return javascript({ jsx: true, typescript: true });
    case 'python':
      return python();
    case 'php':
      return php();
    case 'sql':
      return sql();
    case 'go':
      return go();
    case 'rust':
      return rust();
    case 'java':
      return java();
    case 'cpp':
      return cpp();
    case 'shell':
      return StreamLanguage.define(shell);
    case 'dockerfile':
      return StreamLanguage.define(dockerFile);
    case 'diff':
      return StreamLanguage.define(diff);
    case 'ruby':
      return StreamLanguage.define(ruby);
    case 'lua':
      return StreamLanguage.define(lua);
    case 'perl':
      return StreamLanguage.define(perl);
    case 'r':
      return StreamLanguage.define(r);
    case 'powershell':
      return StreamLanguage.define(powerShell);
    case 'properties':
      return StreamLanguage.define(properties);
    case 'toml':
      return StreamLanguage.define(toml);
    case 'tex':
      return StreamLanguage.define(stex);
    case 'textile':
      return StreamLanguage.define(textile);
    case 'protobuf':
      return StreamLanguage.define(protobuf);
    case 'plain':
      return [];
  }
}
