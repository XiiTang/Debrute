import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export function classicUxpHtml(html: string): string {
  const entryScripts: string[] = [];
  const withoutEntry = html.replace(
    /<script\s+type=(['"])module\1([^>]*)><\/script>/g,
    (_tag, _quote: string, attributes: string) => {
      entryScripts.push(`<script${attributes}></script>`);
      return '';
    }
  );
  const cleanedHtml = withoutEntry.replace(/\s+crossorigin(?:=(['"])[^'"]*\1)?/g, '');
  const scripts = entryScripts
    .map((script) => script.replace(/\s+crossorigin(?:=(['"])[^'"]*\1)?/g, ''))
    .join('\n');
  if (!scripts) return cleanedHtml;
  if (!cleanedHtml.includes('</body>')) return `${cleanedHtml}${scripts}`;
  return cleanedHtml.replace('</body>', `${scripts}\n</body>`);
}

export default defineConfig({
  base: './',
  root: 'src',
  publicDir: '../public',
  plugins: [{
    name: 'photoshop-uxp-classic-script',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler: classicUxpHtml
    }
  }],
  build: {
    modulePreload: false,
    outDir: '../dist',
    emptyOutDir: true,
    license: true,
    rolldownOptions: {
      input: resolve(import.meta.dirname, 'src/index.html'),
      external: ['uxp'],
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});
