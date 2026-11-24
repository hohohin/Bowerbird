import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createLocalFileMode, libraryShortcutMode } from "../src/lib/localFileMode.ts";
import { connectedSubtreeRows } from "../src/lib/folderConnections.ts";

let saved;
beforeEach(() => {
  saved = new Map();
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
});

const all = { kind: "all" };
const project = projectId => ({ kind: "projects", projectId });
const folder = folderId => ({ kind: "folders", folderId });
const state = mode => {
  const { sidebarMode, sidebarCollapsed, hierarchyTarget, media } = mode.getState();
  return { sidebarMode, sidebarCollapsed, hierarchyTarget, media };
};

test("old view and source/lens records migrate to a global tag mode and a remembered hierarchy target", () => {
  saved.set("bowerbird.libraryProject.p", "browse");
  for (const [legacy, target, sidebarMode] of [
    [{ view: "global" }, all, "hierarchy"],
    [{ view: "project" }, project("browse"), "hierarchy"],
    [{ view: "collections" }, folder(null), "hierarchy"],
    [{ view: "tags", tagSource: "project" }, project("browse"), "tags"],
    [{ source: "global", lens: "tags" }, all, "tags"],
    [{ source: "folders", lens: "flow" }, folder(null), "hierarchy"],
  ]) {
    saved.set("bowerbird.libraryView.main.p", JSON.stringify({ ...legacy, media: "videos" }));
    const mode = createLocalFileMode();
    mode.getState().setProjectContext("p");
    assert.deepEqual(state(mode), { sidebarMode, sidebarCollapsed: false, hierarchyTarget: target, media: "videos" });
    mode.getState().setSidebarCollapsed(true);
    assert.deepEqual(JSON.parse(saved.get("bowerbird.libraryView.main.p")), { ...state(mode), sidebarCollapsed: true });
  }
});

test("project and pane contexts remember independent collapse, target, mode and media", () => {
  const left = createLocalFileMode("left");
  left.getState().selectHierarchy(folder("subtree"));
  left.getState().setSidebarCollapsed(true);
  left.getState().setProjectContext("p");
  assert.deepEqual(left.getState().hierarchyTarget, project("p"));
  assert.equal(left.getState().sidebarCollapsed, false);
  left.getState().setSidebarMode("tags");
  left.getState().setMedia("texts");
  left.getState().setProjectContext(null);
  assert.deepEqual(state(left), { sidebarMode: "hierarchy", sidebarCollapsed: true, hierarchyTarget: folder("subtree"), media: "images" });
  assert.deepEqual(state(createLocalFileMode("right")), { sidebarMode: "hierarchy", sidebarCollapsed: false, hierarchyTarget: all, media: "images" });
  const reopened = createLocalFileMode("left");
  reopened.getState().setGeneratedFilter("source:generated");
  reopened.getState().setProjectContext("p");
  assert.deepEqual(state(reopened), { sidebarMode: "tags", sidebarCollapsed: false, hierarchyTarget: project("p"), media: "texts" });
  assert.equal(reopened.getState().generatedFilter, null);
});

test("Q and E leave the last hierarchy target intact and do not bind Tab or F", () => {
  const pane = createLocalFileMode();
  pane.getState().selectHierarchy(folder("child"));
  pane.getState().setSidebarMode(libraryShortcutMode("E"));
  assert.equal(pane.getState().sidebarMode, "tags");
  pane.getState().setSidebarMode(libraryShortcutMode("q"));
  assert.deepEqual(pane.getState().hierarchyTarget, folder("child"));
  assert.equal(pane.getState().sidebarMode, "hierarchy");
  for (const key of ["Tab", "F", "Escape"]) assert.equal(libraryShortcutMode(key), undefined);
});

test("invalid stored targets fall back and blocked storage preserves the session", () => {
  saved.set("bowerbird.libraryView.main.home", JSON.stringify({ hierarchyTarget: { kind: "folders", folderId: 3 }, media: "unknown" }));
  const pane = createLocalFileMode();
  assert.deepEqual(pane.getState().hierarchyTarget, all);
  localStorage.setItem = () => { throw new Error("unavailable"); };
  pane.getState().selectHierarchy(folder("child"));
  pane.getState().setProjectContext("p");
  pane.getState().setProjectContext(null);
  assert.deepEqual(pane.getState().hierarchyTarget, folder("child"));
});

test("subtree sections preserve depth and exclude ancestors, siblings and other roots", () => {
  const folders = [["root",null], ["child","root"], ["sibling","root"], ["nested","child"], ["second",null]].map(([id, parent_id]) => ({ id, parent_id }));
  assert.deepEqual(connectedSubtreeRows(folders, "child").map(({ item, depth }) => [item.id, depth]), [["child",0],["nested",1]]);
  assert.deepEqual(connectedSubtreeRows(folders, "missing"), []);
});
