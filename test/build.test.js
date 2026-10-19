import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPage } from '../build.mjs';

test('build produces one self-contained html file', async () => {
  const { path, bytes } = await buildPage();
  const html = await readFile(path, 'utf8');
  assert.ok(path.endsWith('lru-cache.html'));
  assert.ok(bytes > 300_000, 'three.js should be bundled in');
  assert.doesNotMatch(html, /<script[^>]+src=/i, 'no external scripts');
  assert.doesNotMatch(html, /<link[^>]+href=/i, 'no external stylesheets');
  assert.doesNotMatch(html, /__CSS__|__JS__/, 'placeholders are filled');
  assert.match(html, /id="stage"/, 'the canvas is in the page');
  assert.match(html, /id="fatal"/, 'the error banner is in the page');
  assert.equal(html.match(/<\/script>/gi).length, 1, 'bundle cannot close the script tag early');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/i, 'no remote css');
});
