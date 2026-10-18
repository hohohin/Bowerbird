import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MasonryGrid } from "../../src/components/MasonryGrid";
import type { Asset } from "../../src/lib/types";

export function mountReferenceLibrary(assets: Asset[]) {
  const host = document.createElement("div");
  host.id = "library-check";
  host.style.cssText = "position:fixed;inset:0;background:white;z-index:1000";
  document.body.append(host);
  createRoot(host).render(createElement(MasonryGrid, { assetsOverride: assets, totalOverride: assets.length }));
}
