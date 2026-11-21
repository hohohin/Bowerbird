import path from 'node:path';

const source = /\.(?:[cm]?[jt]sx?|rs|py)$/;
const js = /\.[cm]?[jt]sx?$/;
const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css'];
const fileStem = file => path.posix.basename(file).replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '');
const normalize = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const words = value => new Set(value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
  .filter(word => word.length > 2 && !['test', 'tests', 'spec', 'src', 'lib'].includes(word)));

export const coreSource = file => source.test(file);
export const testFile = file => /\/(?:tests?)\//.test(file) ||
  /(?:[._-](?:tests?|spec)[._-]|^test[_-])/.test(path.posix.basename(file));

function tokens(text, rust) {
  const result = [];
  const pattern = rust
    ? /\/\/[^\n]*|\/\*[\s\S]*?\*\/|r(#+)"[\s\S]*?"\1|r"[^"]*"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\.|[^'\\])'|[A-Za-z_$][\w$]*|[^\s]/g
    : /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    if (value.startsWith('//') || value.startsWith('/*')) continue;
    const raw = /^r(#+)?"/.exec(value);
    if (raw) { result.push({ string: true, value: value.slice(raw[0].length, -(raw[1]?.length ?? 0) - 1) }); continue; }
    const string = /^["'`]/.test(value);
    if (string && value.startsWith('`') && value.includes('${')) { result.push({ value: '', string: false }); continue; }
    result.push({ string, value: string ? value.slice(1, -1).replace(/\\([\\'"`])/g, '$1') : value });
  }
  return result;
}

// Static literals only. Never execute project code or evaluate template expressions.
export function references(file, text) {
  const found = [];
  const list = tokens(text, file.endsWith('.rs'));
  const add = (token, kind) => { if (token?.string) found.push({ specifier: token.value, kind }); };
  if (js.test(file)) {
    for (let i = 0; i < list.length; i++) {
      const token = list[i];
      if (token.string) continue;
      if (token.value === 'from') add(list[i + 1], 'module');
      if (token.value === 'import') add(list[i + 1], 'module');
      if (['import', 'require'].includes(token.value) && list[i + 1]?.value === '(') {
        if (list[i + 2]?.string && [')', ','].includes(list[i + 3]?.value)) add(list[i + 2], 'module');
        else found.push({ specifier: '', kind: 'dynamic' });
      }
    }
    return found.filter(ref => ref.kind === 'dynamic' || ref.specifier.startsWith('.') || ref.specifier.startsWith('@/'));
  }
  if (file.endsWith('.rs')) {
    let modulePath;
    for (let i = 0; i < list.length; i++) {
      const token = list[i];
      if (token.string) continue;
      if (token.value === '#' && list[i + 1]?.value === '[' && list[i + 2]?.value === 'path' &&
          list[i + 3]?.value === '=' && list[i + 4]?.string && list[i + 5]?.value === ']') modulePath = list[i + 4].value;
      if (token.value === 'mod' && list[i + 1] && list[i + 2]?.value === ';') {
        found.push({ specifier: modulePath ?? list[i + 1].value, kind: modulePath ? 'file' : 'rust-module' });
        modulePath = undefined;
      }
      if (['include_str', 'include_bytes', 'include'].includes(token.value) && list[i + 1]?.value === '!' && list[i + 2]?.value === '(') {
        if (list[i + 3]?.string) add(list[i + 3], 'file');
        else found.push({ specifier: '', kind: 'dynamic' });
      }
    }
  }
  return found;
}

export function candidates(from, reference) {
  let base = path.posix.dirname(from);
  let target = reference.specifier.split(/[?#]/)[0];
  if (target.startsWith('@/')) {
    const src = from.indexOf('/src/');
    if (src < 0) return [];
    base = from.slice(0, src + 4);
    target = target.slice(2);
  }
  if (reference.kind === 'rust-module') {
    const name = path.posix.basename(from);
    if (!['lib.rs', 'main.rs', 'mod.rs'].includes(name)) base = path.posix.join(base, name.slice(0, -3));
    const stem = path.posix.join(base, target);
    return [stem + '.rs', path.posix.join(stem, 'mod.rs')];
  }
  const resolved = path.posix.normalize(path.posix.join(base, target));
  if (reference.kind === 'file') return [resolved];
  if (path.posix.extname(resolved)) {
    return /\.jsx?$/.test(resolved) ? [resolved, resolved.replace(/\.jsx?$/, '.ts'), resolved.replace(/\.jsx?$/, '.tsx')] : [resolved];
  }
  return [resolved, ...extensions.map(extension => resolved + extension),
    ...extensions.map(extension => path.posix.join(resolved, 'index' + extension))];
}

export function relatedTest(file, text, included) {
  const name = fileStem(file);
  const normalized = normalize(name);
  const testWords = words(name);
  for (const sourceFile of included) {
    if (!coreSource(sourceFile) || testFile(sourceFile)) continue;
    const stem = fileStem(sourceFile);
    if (normalize(stem).length >= 5 && normalized.includes(normalize(stem))) return true;
    if (stem.length >= 5 && text.includes(path.posix.basename(sourceFile))) return true;
    let matches = 0;
    for (const word of words(stem)) if (testWords.has(word)) matches++;
    if (matches >= 2) return true;
  }
  return false;
}
