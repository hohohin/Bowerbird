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
