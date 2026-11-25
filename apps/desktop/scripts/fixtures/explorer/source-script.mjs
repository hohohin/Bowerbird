import { readFile } from 'node:fs/promises';

export const sourceSiteRules = JSON.parse(await readFile(new URL('../../../src-tauri/src/commands/source_browser_site_rules.json', import.meta.url), 'utf8'));

export async function loadSourceScript(path, siteRules = sourceSiteRules) {
  return (await readFile(path, 'utf8')).replace('__BOWERBIRD_SITE_RULES__', () => JSON.stringify(siteRules));
}
