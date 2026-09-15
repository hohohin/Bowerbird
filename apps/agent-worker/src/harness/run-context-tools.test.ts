import { deepEqual, equal, throws } from "node:assert/strict";
import { test } from "node:test";
import { RunContextTools } from "./run-context-tools.ts";

test("context catalog does not read resources; reads are isolated to the selected resource", () => {
  let profileReads = 0;
  const context = new RunContextTools([
    { id: "profile", description: "Brand", read() { profileReads++; return { must: ["navy"] }; } },
    { id: "html", description: "Render", read() { throw new Error("unselected resource was read"); } },
  ]);
  deepEqual(context.catalog(), [{ id: "profile", description: "Brand" }, { id: "html", description: "Render" }]);
  equal(profileReads, 0);
  deepEqual(context.dispatch({ toolName: "read_context", arguments: { id: "profile" } })?.value,
    { id: "profile", content: { must: ["navy"] } });
  equal(profileReads, 1);
});

test("context reads reject paths, unregistered ids, extra fields and another run's resources", () => {
  const context = new RunContextTools([{ id: "profile", description: "Brand", read: () => "private" }]);
  for (const args of [null, [], {}, { id: "../../profile" }, { id: "https://example.com" },
    { id: "profile", runId: "other" }, { id: "other-run-profile" }]) {
    equal((context.dispatch({ toolName: "read_context", arguments: args })?.value as { status: string }).status,
      "retry_required");
  }
  equal(context.dispatch({ toolName: "generate_image", arguments: {} }), undefined);
  throws(() => new RunContextTools([
    { id: "same", description: "one", read: () => 1 },
    { id: "same", description: "two", read: () => 2 },
  ]), /duplicate_id/);
});
