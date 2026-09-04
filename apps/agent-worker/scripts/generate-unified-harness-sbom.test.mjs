import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildUnifiedHarnessSbom } from "./generate-unified-harness-sbom.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bowerbird-sbom-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture-profile",
    version: "1.0.0",
    dependencies: { "@deepseek-ai/dsh": "0.1.1-rc.2", fixture: "2.0.0" },
  }));
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const dsh = join(root, "node_modules", ".pnpm", "dsh", "node_modules", "@deepseek-ai", "dsh");
  const fixturePackage = join(root, "node_modules", ".pnpm", "fixture", "node_modules", "fixture");
  mkdirSync(dsh, { recursive: true });
  mkdirSync(fixturePackage, { recursive: true });
  writeFileSync(join(dsh, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.1-rc.2", license: "MIT" }));
  writeFileSync(join(fixturePackage, "package.json"), JSON.stringify({ name: "fixture", version: "2.0.0", license: "Apache-2.0" }));
  return root;
}

test("unified harness SBOM binds the exact lock, installed inventory and DSH license", () => {
  const root = fixture();
  try {
    const sbom = buildUnifiedHarnessSbom(root);
    assert.equal(sbom.spdxVersion, "SPDX-2.3");
    assert.equal(sbom.bowerbirdAudit.installedPackages, 2);
    assert.equal(sbom.bowerbirdAudit.deepseekHarnessPackages, 1);
    assert.deepEqual(sbom.bowerbirdAudit.missingLicenseDeclarations, []);
    assert.ok(sbom.packages.some((item) => item.name === "@deepseek-ai/dsh" && item.licenseDeclared === "MIT"));
    assert.ok(sbom.packages.some((item) => item.name === "@deepseek-ai/dsh" &&
      item.externalRefs[0].referenceLocator === "pkg:npm/%40deepseek-ai/dsh@0.1.1-rc.2"));
    assert.ok(sbom.annotations[0].comment.includes(sbom.bowerbirdAudit.pnpmLockSha256));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unified harness SBOM rejects floating direct dependencies and DSH drift", () => {
  const root = fixture();
  try {
    const manifestPath = join(root, "package.json");
    writeFileSync(manifestPath, JSON.stringify({
      name: "fixture-profile", version: "1.0.0", dependencies: { "@deepseek-ai/dsh": "^0.1.1" },
    }));
    assert.throws(() => buildUnifiedHarnessSbom(root), /direct_dependencies_not_exact/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
