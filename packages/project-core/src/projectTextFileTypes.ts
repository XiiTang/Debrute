export type ProjectTextLanguageId =
  | 'plaintext'
  | 'markdown'
  | 'json'
  | 'jsonc'
  | 'jsonl'
  | 'yaml'
  | 'shell'
  | 'dotenv'
  | 'ini'
  | 'properties'
  | 'log'
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
  | 'ruby'
  | 'php'
  | 'sql'
  | 'powershell'
  | 'bat'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'lua'
  | 'perl'
  | 'r'
  | 'dockerfile'
  | 'makefile'
  | 'diff'
  | 'csv'
  | 'tsv';

export interface ProjectTextFileType {
  id: ProjectTextLanguageId;
  monacoLanguage: string;
  mimeType: string;
  extensions?: readonly string[];
  filenames?: readonly string[];
  filenamePatterns?: readonly string[];
  firstLine?: RegExp;
}

const projectTextFileTypes: readonly ProjectTextFileType[] = [
  type('markdown', 'markdown', 'text/markdown', {
    extensions: ['.md', '.markdown', '.mkd', '.mkdn', '.mdwn', '.mdown', '.markdn', '.mdtxt', '.mdtext', '.mdc', '.prompt.md', '.instructions.md', '.agent.md', '.chatmode.md'],
    filenames: ['SKILL.md', 'copilot-instructions.md']
  }),
  type('jsonl', 'json', 'application/jsonl', { extensions: ['.jsonl', '.ndjson'] }),
  type('jsonc', 'json', 'application/jsonc', {
    extensions: ['.jsonc', '.code-workspace', '.code-profile', '.eslintrc', '.eslintrc.json', '.jsfmtrc', '.jshintrc', '.swcrc', '.hintrc', '.babelrc', '.toolset.jsonc'],
    filenames: ['tsconfig.json', 'jsconfig.json', 'settings.json', 'launch.json', 'tasks.json', 'mcp.json', 'keybindings.json', 'extensions.json', 'argv.json', 'profiles.json', 'devcontainer.json', '.devcontainer.json', 'babel.config.json', 'bun.lock', '.babelrc.json', '.ember-cli', 'typedoc.json'],
    filenamePatterns: ['tsconfig.*.json', 'jsconfig.*.json', 'tsconfig-*.json', 'jsconfig-*.json', '**/.github/hooks/*.json']
  }),
  type('json', 'json', 'application/json', {
    extensions: ['.json', '.bowerrc', '.jscsrc', '.webmanifest', '.js.map', '.css.map', '.ts.map', '.har', '.jslintrc', '.jsonld', '.geojson', '.ipynb', '.vuerc', '.tsbuildinfo', '.code-snippets'],
    filenames: ['package.json', 'composer.lock', '.watchmanconfig'],
    filenamePatterns: ['**/snippets*.json']
  }),
  type('yaml', 'yaml', 'application/yaml', {
    extensions: ['.yaml', '.yml', '.eyaml', '.eyml', '.cff', '.yaml-tmlanguage', '.yaml-tmpreferences', '.yaml-tmtheme', '.winget'],
    filenamePatterns: ['compose.yml', 'compose.yaml', 'compose.*.yml', 'compose.*.yaml', '*docker*compose*.yml', '*docker*compose*.yaml'],
    firstLine: /^#cloud-config\b/
  }),
  type('shell', 'shell', 'text/x-shellscript', {
    extensions: ['.sh', '.bash', '.bashrc', '.bash_aliases', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zsh', '.zshrc', '.zprofile', '.zlogin', '.zlogout', '.zshenv', '.zsh-theme', '.fish', '.ksh', '.csh', '.cshrc', '.tcshrc', '.yashrc', '.yash_profile', '.xprofile', '.xsession', '.xsessionrc'],
    filenames: ['APKBUILD', 'PKGBUILD', '.envrc', '.hushlogin', 'zshrc', 'zshenv', 'zlogin', 'zprofile', 'zlogout', 'bashrc_Apple_Terminal', 'zshrc_Apple_Terminal'],
    firstLine: /^#!.*\b(?:bash|fish|zsh|sh|ksh|dtksh|pdksh|mksh|ash|dash|yash|csh|jcsh|tcsh|itcsh)\b/
  }),
  type('dotenv', 'plaintext', 'text/plain', { extensions: ['.env'], filenames: ['.env', '.flaskenv', 'user-dirs.dirs'], filenamePatterns: ['.env.*'] }),
  type('ini', 'ini', 'text/plain', { extensions: ['.ini'] }),
  type('properties', 'ini', 'text/plain', {
    extensions: ['.conf', '.properties', '.cfg', '.directory', '.gitattributes', '.gitconfig', '.gitmodules', '.editorconfig', '.repo'],
    filenames: ['gitconfig', '.npmrc'],
    filenamePatterns: ['**/.config/git/config', '**/.git/config']
  }),
  type('log', 'plaintext', 'text/plain', { extensions: ['.log'], filenamePatterns: ['*.log.?'] }),
  type('html', 'html', 'text/html', { extensions: ['.html', '.htm', '.shtml', '.xhtml', '.xht', '.mdoc', '.jsp', '.asp', '.aspx', '.jshtm', '.volt', '.ejs', '.rhtml'] }),
  type('scss', 'scss', 'text/css', { extensions: ['.scss'] }),
  type('less', 'less', 'text/css', { extensions: ['.less'] }),
  type('css', 'css', 'text/css', { extensions: ['.css'] }),
  type('xml', 'xml', 'application/xml', {
    extensions: ['.xml', '.xsd', '.atom', '.axml', '.axaml', '.bpmn', '.csl', '.csproj', '.dita', '.ditamap', '.dtd', '.fxml', '.iml', '.jmx', '.launch', '.mxml', '.nuspec', '.opml', '.proj', '.props', '.pubxml', '.targets', '.tmx', '.wixproj', '.wxi', '.wxl', '.wxs', '.xaml', '.xib', '.xlf', '.xliff', '.xsl', '.xslt'],
    firstLine: /^<\?xml\b/i
  }),
  type('javascriptreact', 'javascript', 'text/javascript', { extensions: ['.jsx'] }),
  type('javascript', 'javascript', 'text/javascript', { extensions: ['.js', '.mjs', '.cjs', '.es6', '.pac'], filenames: ['jakefile'], firstLine: /^#!.*\bnode\b/ }),
  type('typescriptreact', 'typescript', 'text/typescript', { extensions: ['.tsx'] }),
  type('typescript', 'typescript', 'text/typescript', { extensions: ['.ts', '.cts', '.mts'], firstLine: /^#!.*\b(?:deno|bun|ts-node)\b/ }),
  type('python', 'python', 'text/x-python', { extensions: ['.py', '.pyw', '.pyi', '.gyp', '.gypi', '.rpy', '.cpy', '.ipy', '.pyt'], filenames: ['SConstruct', 'SConscript'], firstLine: /^#!\s*\/?.*\bpython[0-9.-]*\b/ }),
  type('ruby', 'ruby', 'text/x-ruby', { extensions: ['.rb', '.rbx', '.rjs', '.gemspec', '.rake', '.ru', '.erb', '.podspec', '.rbi'], filenames: ['rakefile', 'gemfile', 'guardfile', 'podfile', 'capfile', 'vagrantfile', 'brewfile', 'fastfile', 'appfile'], firstLine: /^#!\s*\/.*\bruby\b/ }),
  type('php', 'php', 'application/x-httpd-php', { extensions: ['.php', '.php4', '.php5', '.phtml', '.ctp'], firstLine: /^#!\s*\/.*\bphp\b/ }),
  type('sql', 'sql', 'application/sql', { extensions: ['.sql', '.dsql'] }),
  type('powershell', 'powershell', 'text/plain', { extensions: ['.ps1', '.psm1', '.psd1', '.pssc', '.psrc'], firstLine: /^#!\s*\/.*\bpwsh\b/ }),
  type('bat', 'bat', 'text/plain', { extensions: ['.bat', '.cmd'] }),
  type('go', 'go', 'text/x-go', { extensions: ['.go'] }),
  type('rust', 'rust', 'text/x-rustsrc', { extensions: ['.rs'] }),
  type('java', 'java', 'text/x-java-source', { extensions: ['.java', '.jav'] }),
  type('cpp', 'cpp', 'text/x-c++src', { extensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.ipp', '.inl', '.tpp', '.txx'] }),
  type('c', 'c', 'text/x-csrc', { extensions: ['.c', '.h', '.i'] }),
  type('lua', 'lua', 'text/x-lua', { extensions: ['.lua'] }),
  type('perl', 'perl', 'text/x-perl', { extensions: ['.pl', '.pm', '.pod', '.t'] }),
  type('r', 'r', 'text/x-r-source', { extensions: ['.R', '.Rprofile', '.Rhistory', '.rt'] }),
  type('dockerfile', 'dockerfile', 'text/plain', { extensions: ['.dockerfile', '.containerfile'], filenames: ['Dockerfile', 'Containerfile'], filenamePatterns: ['Dockerfile.*', 'Containerfile.*'] }),
  type('makefile', 'makefile', 'text/plain', { extensions: ['.mk', '.mak'], filenames: ['Makefile', 'makefile', 'GNUmakefile', 'OCamlMakefile'], firstLine: /^#!\s*\/usr\/bin\/make\b/ }),
  type('diff', 'diff', 'text/plain', { extensions: ['.diff', '.patch', '.rej'] }),
  type('csv', 'plaintext', 'text/csv', { extensions: ['.csv'] }),
  type('tsv', 'plaintext', 'text/tab-separated-values', { extensions: ['.tsv'] }),
  type('plaintext', 'plaintext', 'text/plain', { extensions: ['.txt'], filenames: ['LICENSE', '.gitignore'] })
] as const;

export function projectTextFileTypeForPath(
  projectRelativePath: string,
  firstLine?: string
): ProjectTextFileType | undefined {
  const normalizedPath = projectRelativePath.replaceAll('\\', '/');
  const basename = normalizedPath.split('/').pop() ?? normalizedPath;
  return exactFilenameMatch(basename)
    ?? filenamePatternMatch(normalizedPath)
    ?? extensionMatch(normalizedPath)
    ?? firstLineMatch(firstLine);
}

export function isKnownProjectTextFilePath(projectRelativePath: string, firstLine?: string): boolean {
  return projectTextFileTypeForPath(projectRelativePath, firstLine) !== undefined;
}

export function projectTextLanguageFromPath(projectRelativePath: string, firstLine?: string): ProjectTextLanguageId {
  return projectTextFileTypeForPath(projectRelativePath, firstLine)?.id ?? 'plaintext';
}

export function projectTextMimeTypeFromPath(projectRelativePath: string, firstLine?: string): string {
  return projectTextFileTypeForPath(projectRelativePath, firstLine)?.mimeType ?? 'text/plain';
}

export function monacoLanguageFromProjectTextLanguage(language: string): string {
  const entry = projectTextFileTypes.find((item) => item.id === language);
  return entry?.monacoLanguage ?? 'plaintext';
}

function type(
  id: ProjectTextLanguageId,
  monacoLanguage: string,
  mimeType: string,
  rest: Omit<ProjectTextFileType, 'id' | 'monacoLanguage' | 'mimeType'>
): ProjectTextFileType {
  return { id, monacoLanguage, mimeType, ...rest };
}

function exactFilenameMatch(basename: string): ProjectTextFileType | undefined {
  const lowerBasename = basename.toLowerCase();
  return projectTextFileTypes.find((entry) => (
    entry.filenames?.some((filename) => filename.toLowerCase() === lowerBasename)
  ));
}

function filenamePatternMatch(projectRelativePath: string): ProjectTextFileType | undefined {
  const normalizedPath = projectRelativePath.replaceAll('\\', '/');
  const basename = normalizedPath.split('/').pop() ?? normalizedPath;
  return projectTextFileTypes.find((entry) => (
    entry.filenamePatterns?.some((pattern) => {
      const candidate = pattern.includes('/') ? normalizedPath : basename;
      return patternToRegExp(pattern).test(candidate);
    })
  ));
}

function extensionMatch(projectRelativePath: string): ProjectTextFileType | undefined {
  const lowerPath = projectRelativePath.toLowerCase();
  return projectTextFileTypes.find((entry) => (
    entry.extensions?.some((extension) => lowerPath.endsWith(extension.toLowerCase()))
  ));
}

function firstLineMatch(firstLine: string | undefined): ProjectTextFileType | undefined {
  if (!firstLine) {
    return undefined;
  }
  return projectTextFileTypes.find((entry) => entry.firstLine?.test(firstLine));
}

function patternToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    const nextCharacter = pattern[index + 1];
    const nextNextCharacter = pattern[index + 2];
    if (character === '*' && nextCharacter === '*') {
      if (nextNextCharacter === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
}
