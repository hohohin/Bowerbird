import path from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_RELEASES = Object.freeze({
  "@deepseek-ai/dsh": "0.1.1-rc.2",
  "@deepseek-ai/dsh-acp": "0.1.1-rc.2",
  "@deepseek-ai/dsh-llm-deepseek": "0.1.1-rc.2",
});

export function assessReleaseState(packageName, metadata) {
  const pinned = PINNED_RELEASES[packageName];
  if (!pinned) throw new Error(`No pinned release for ${packageName}`);
  const tags = metadata?.["dist-tags"] ?? {};
  const candidate = tags.next ?? tags.latest ?? null;
  return {
    package: packageName,
    pinned,
    latest: tags.latest ?? null,
    next: tags.next ?? null,
    candidate,
    readyForRetest: candidate !== null && candidate !== pinned,
  };
}

async function registryMetadata(packageName) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status} for ${packageName}`);
  return response.json();
}

export async function checkPublishedReleases() {
  const results = await Promise.all(
    Object.keys(PINNED_RELEASES).map(async (packageName) =>
      assessReleaseState(packageName, await registryMetadata(packageName)),
    ),
  );
  return {
    checkedAt: new Date().toISOString(),
    readyForRetest: results.some((result) => result.readyForRetest),
    packages: results,
    note: "A new version triggers the pinned compatibility suite again; it does not itself prove ACP lifecycle compatibility or authorize production rollout.",
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const report = await checkPublishedReleases();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
