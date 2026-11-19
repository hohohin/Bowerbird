import postcss from 'postcss';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const desktop = fileURLToPath(new URL('..', import.meta.url));
process.chdir(desktop);
await mkdir('.tmp/text-editor-css', { recursive: true });
const result = spawnSync(process.execPath, [resolve(desktop, 'node_modules/@tailwindcss/cli/dist/index.mjs'), '-i', 'scripts/text-editor-style.css', '-o', '.tmp/text-editor-css/raw.css'], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Text editor stylesheet compilation failed');
import { readFile, writeFile } from 'node:fs/promises';
const ast = postcss.parse(await readFile('.tmp/text-editor-css/raw.css', 'utf8'));
// The host's Tailwind 3 is unlayered; keep this scoped sheet in the same cascade.
ast.walkAtRules('layer', rule => rule.nodes ? rule.replaceWith(...rule.nodes) : rule.remove());
ast.walkDecls(/^(translate|rotate|scale)$/, declaration => {
  // Tailwind 3 uses transform for these same class names. Do not apply both.
  if (!declaration.parent.nodes.some(node => node.prop === 'transform')) declaration.parent.append({ prop: 'transform', value: 'none' });
});
ast.walkRules(rule => {
  let parent = rule.parent;
  while (parent) { if (parent.type === 'atrule' && /keyframes$/.test(parent.name)) return; parent = parent.parent; }
  rule.selectors = rule.selectors.map(selector => {
    if (selector.includes('&')) return selector;
    if (selector === ':root' || selector === ':host') return '.text-plate-ui';
    const index = selector.indexOf('::');
    const position = index < 0 ? selector.length : index;
    return selector.slice(0, position) + ':is(.text-plate-ui, .text-plate-ui *)' + selector.slice(position);
  });
});
await writeFile('src/components/text-editor/plate/utilities.css', '/* Generated scoped Plate utilities. MIT; see LICENSE.md. */\n' + ast.toString());
