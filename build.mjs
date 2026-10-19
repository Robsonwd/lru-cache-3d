import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const at = (relative) => fileURLToPath(new URL(relative, import.meta.url));

export async function buildPage() {
  const result = await build({
    entryPoints: [at('src/main.js')],
    bundle: true,
    format: 'iife',
    minify: true,
    target: 'es2022',
    legalComments: 'none',
    write: false,
  });
  // A literal "</script" inside the bundle would end the inline script tag.
  const js = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
  const css = await readFile(at('src/styles.css'), 'utf8');
  const template = await readFile(at('src/index.html'), 'utf8');
  // Function replacers: a string replacement would interpret "$&" and "$1" inside the bundle.
  const html = template
    .replace('/*__CSS__*/', () => css)
    .replace('/*__JS__*/', () => js);
  const path = at('lru-cache.html');
  await writeFile(path, html);
  return { path, bytes: Buffer.byteLength(html) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { path, bytes } = await buildPage();
  console.log(`built ${path} (${Math.round(bytes / 1024)} KB)`);
}
