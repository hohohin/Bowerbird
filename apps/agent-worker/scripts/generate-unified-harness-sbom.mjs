import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const EXPECTED_DSH_VERSION = "0.1.1-rc.2";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function licenseOf(manifest) {
  if (typeof manifest.license === "string" && manifest.license.trim()) return manifest.license.trim();
  if (manifest.license && typeof manifest.license.type === "string") return manifest.license.type.trim();
  if (Array.isArray(manifest.licenses)) {
    const values = manifest.licenses.flatMap((item) => typeof item === "string"
      ? [item]
      : typeof item?.type === "string" ? [item.type] : []).filter(Boolean);
    if (values.length) return values.join(" OR ");
  }
  return "NOASSERTION";
}

function packageDirectories(nodeModules) {
  const store = join(nodeModules, ".pnpm");
  if (!statSync(store).isDirectory()) throw new Error("unified_harness_pnpm_store_missing");
  const directories = [];
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = join(store, entry.name, "node_modules");
    try {
      for (const child of readdirSync(nested, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        if (child.name.startsWith("@")) {
          const scope = join(nested, child.name);
          for (const scoped of readdirSync(scope, { withFileTypes: true })) {
            if (scoped.isDirectory()) directories.push(join(scope, scoped.name));
          }
        } else {
          directories.push(join(nested, child.name));
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return directories;
}

function spdxId(name, version) {
  return `SPDXRef-Package-${sha256(`${name}@${version}`).slice(0, 20)}`;
}

function npmPurl(name, version) {
  if (name.startsWith("@") && name.includes("/")) {
    const slash = name.indexOf("/");
    return `pkg:npm/${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

export function buildUnifiedHarnessSbom(profileDir) {
  const root = resolve(profileDir);
  const profileBytes = readFileSync(join(root, "package.json"));
  const lockBytes = readFileSync(join(root, "pnpm-lock.yaml"));
  const profile = JSON.parse(profileBytes.toString("utf8"));
  const direct = Object.entries(profile.dependencies ?? {});
  if (!profile.name || !profile.version || !direct.length || direct.some(([, version]) => !EXACT_VERSION.test(version))) {
    throw new Error("unified_harness_direct_dependencies_not_exact");
  }

  const manifests = new Map();
  for (const directory of packageDirectories(join(root, "node_modules"))) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string" || !manifest.name || !manifest.version) continue;
      manifests.set(`${manifest.name}@${manifest.version}`, {
        name: manifest.name,
        version: manifest.version,
        license: licenseOf(manifest),
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const [name, version] of direct) {
    if (!manifests.has(`${name}@${version}`)) throw new Error(`unified_harness_direct_package_missing:${name}`);
  }
  const packages = [...manifests.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  const dshPackages = packages.filter((item) => item.name.startsWith("@deepseek-ai/dsh"));
  if (!dshPackages.length || dshPackages.some((item) =>
    item.version !== EXPECTED_DSH_VERSION || !/(^|\s|\()MIT($|\s|\))/i.test(item.license))) {
    throw new Error("unified_harness_dsh_identity_or_license_invalid");
  }
  const missingLicenses = packages.filter((item) => item.license === "NOASSERTION").map((item) => `${item.name}@${item.version}`);
  const lockSha256 = sha256(lockBytes);
  const profileId = spdxId(profile.name, profile.version);
  const spdxPackages = [{
    SPDXID: profileId,
    name: profile.name,
    versionInfo: profile.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: typeof profile.license === "string" ? profile.license : "NOASSERTION",
    copyrightText: "NOASSERTION",
  }, ...packages.map((item) => ({
    SPDXID: spdxId(item.name, item.version),
    name: item.name,
    versionInfo: item.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: item.license,
    copyrightText: "NOASSERTION",
    externalRefs: [{
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: npmPurl(item.name, item.version),
    }],
  }))];
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `bowerbird-unified-harness-${lockSha256.slice(0, 12)}`,
    documentNamespace: `https://bowerbird.local/spdx/unified-harness/${lockSha256}`,
    creationInfo: {
      created: new Date(Number(process.env.SOURCE_DATE_EPOCH ?? 0) * 1_000).toISOString(),
      creators: ["Tool: Bowerbird unified harness SBOM generator v1"],
    },
    documentDescribes: [profileId],
    packages: spdxPackages,
    relationships: packages.map((item) => ({
      spdxElementId: profileId,
      relationshipType: "CONTAINS",
      relatedSpdxElement: spdxId(item.name, item.version),
    })),
    annotations: [{
      annotationDate: new Date(Number(process.env.SOURCE_DATE_EPOCH ?? 0) * 1_000).toISOString(),
      annotationType: "OTHER",
      annotator: "Tool: Bowerbird unified harness SBOM generator v1",
      comment: `pnpm-lock.yaml sha256=${lockSha256}; installed package inventory, not a reconstructed dependency graph`,
    }],
    bowerbirdAudit: {
      schemaVersion: 1,
      profilePackageJsonSha256: sha256(profileBytes),
      pnpmLockSha256: lockSha256,
      installedPackages: packages.length,
      directDependencies: direct.length,
      deepseekHarnessPackages: dshPackages.length,
      deepseekHarnessVersion: EXPECTED_DSH_VERSION,
      missingLicenseDeclarations: missingLicenses,
    },
  };
}

function main() {
  const [, , profileDir, outputPath] = process.argv;
  if (!profileDir || !outputPath) throw new Error("usage: generate-unified-harness-sbom <profile-dir> <output.spdx.json>");
  const sbom = buildUnifiedHarnessSbom(profileDir);
  writeFileSync(resolve(outputPath), `${JSON.stringify(sbom, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    output: resolve(outputPath),
    lockSha256: sbom.bowerbirdAudit.pnpmLockSha256,
    packages: sbom.bowerbirdAudit.installedPackages,
    dshPackages: sbom.bowerbirdAudit.deepseekHarnessPackages,
    missingLicenses: sbom.bowerbirdAudit.missingLicenseDeclarations.length,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
