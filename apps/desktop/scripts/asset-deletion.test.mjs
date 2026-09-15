import test from "node:test";
import assert from "node:assert/strict";
import { canMoveAssetOut } from "../src/lib/assetDeletion.ts";

test("browser-collected assets cannot be moved back to a temporary origin", () => {
  assert.equal(canMoveAssetOut({ source: "extension", origin_path: "D:\\Pictures\\source.png" }), false);
});

test("byte imports with cleared or legacy temporary origins cannot be moved out", () => {
  assert.equal(canMoveAssetOut({ source: "imported", origin_path: null }), false);
  assert.equal(
    canMoveAssetOut({
      source: "imported",
      origin_path: "C:\\Users\\Test\\AppData\\Local\\Temp\\bowerbird-upload-01ABC\\image.png",
    }),
    false,
  );
});

test("a local file import with a stable origin can be moved out", () => {
  assert.equal(
    canMoveAssetOut({ source: "imported", origin_path: "D:\\Pictures\\source.png" }),
    true,
  );
});

test("Mac temporary capture paths cannot be restored, while user folders remain eligible", () => {
  for (const root of ["/var/folders/ab/session/T", "/private/var/folders/ab/session/T"]) {
    for (const prefix of ["bowerbird-upload-", "bowerbird-cloud-", "bowerbird-dreamina-"]) {
      assert.equal(canMoveAssetOut({ source: "imported", origin_path: `${root}/${prefix}01ABC/image.png` }), false);
    }
  }
  assert.equal(canMoveAssetOut({ source: "imported", origin_path: "/Users/test/Pictures/T/bowerbird-upload-project/image.png" }), true);
});
