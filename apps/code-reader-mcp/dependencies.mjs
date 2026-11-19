import { posix as path } from 'node:path';

const scriptExt = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const sourceExt = /\.(?:[cm]?[jt]s|[jt]sx|rs|py)$/;
const testExt = /(?:[._-](?:test|spec)|_tests?)\.(?:[cm]?[jt]s|[jt]sx|rs|py)$/;
const activeSource = /^(?:apps\/[^/]+\/(?:src\/|src-tauri\/src\/|supabase\/functions\/)|website\/)/;
const testRoot = /^(?:apps\/[^/]+\/|website\/)(?:[^/]+\/)*(?:scripts|tests?)\//;
const scriptSuffixes = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.cts', '.json'];

function relative(file, value) {
  if (!value || value.startsWith('/') || /[\\:%\x00-\x1f]/.test(value)) return null;
  const resolved = path.normalize(path.join(path.dirname(file), value));
  return resolved.startsWith('../') || resolved === '..' ? null : resolved;
}

function scriptCandidates(base) {
  if (/\.[cm]?js$/.test(base)) {
    const ext = path.extname(base);
    const stem = base.slice(0, -ext.length);
    const mapped = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
    return [base, ...(mapped[ext] ?? []).map(suffix => stem + suffix)];
  }
  if (path.extname(base)) return [base];
  return [base, ...scriptSuffixes.map(ext => base + ext), ...scriptSuffixes.map(ext => base + '/index' + ext)];
}

// Deliberately only literal local references. Do not follow computed imports, aliases,
// external packages, or arbitrary source text that merely mentions a path.
export function localReferences(file, content) {
  const references = [];
  if (scriptExt.test(file)) {
    const declarations = /^[ \t]*(?:import[ \t]*|(?:import|export)[ \t]+(?:(?!;|^\S).|\r?\n)*?\bfrom\s*)["'](\.[^"'\r\n]+)["']/gm;
    for (const match of content.matchAll(declarations)) {
      const base = relative(file, match[1]);
      if (base) references.push(scriptCandidates(base));
    }
  } else if (file.endsWith('.rs')) {
    const declarations = /^[ \t]*(?:#\[path\s*=\s*"([^"\r\n]+)"\]\s*)?(?:#\[(?!path\b)[^\r\n]+\]\s*)*(?:pub(?:\([^\r\n)]+\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm;
    const stem = path.basename(file, '.rs');
    const parent = ['lib', 'main', 'mod'].includes(stem) ? path.dirname(file) : path.join(path.dirname(file), stem);
    for (const match of content.matchAll(declarations)) {
      const candidate = match[1] ? relative(file, match[1]) : path.join(parent, match[2]);
      if (candidate) references.push(match[1] ? [candidate] : [candidate + '.rs', candidate + '/mod.rs']);
    }
    const includes = /\binclude(?:_str|_bytes)?!\(\s*"([^"\r\n]+)"\s*\)/g;
    for (const [, value] of content.matchAll(includes)) {
      const candidate = relative(file, value);
      if (candidate) references.push([candidate]);
    }
  }
  return references;
}

export function isCoreSource(file) {
  return activeSource.test(file) && sourceExt.test(file) && !testExt.test(file);
}

const testStem = file => path.basename(file).replace(/\.[^.]+$/, '').toLowerCase()
  .replace(/(?:[._-](?:test|spec)|_tests?)$/, '').replaceAll('_', '-');
export function relatedTests(files, untracked) {
  const scopes = new Map();
  const scope = file => /^(?:apps\/[^/]+|website)\//.exec(file)?.[0];
  for (const file of files) {
    const root = scope(file);
    if (!root || !isCoreSource(file)) continue;
    if (!scopes.has(root)) scopes.set(root, new Set());
    scopes.get(root).add(testStem(file));
  }
  return untracked.filter(file => testRoot.test(file) && testExt.test(file) && scopes.get(scope(file))?.has(testStem(file)));
}
