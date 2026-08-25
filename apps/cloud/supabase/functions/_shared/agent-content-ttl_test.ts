import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  agentRunObjectDirectories,
  checkedAgentObjectKey,
  storageListObjectKey,
} from "./agent-content-ttl.ts";

const RUN_ID = "4d135e1b-2bc1-4483-8244-c1b3c68e7853";

Deno.test("Agent TTL paths stay within the selected Run prefix", () => {
  assertEquals(agentRunObjectDirectories(RUN_ID), [
    `runs/${RUN_ID}/inputs`,
    `runs/${RUN_ID}/checkpoints`,
    `runs/${RUN_ID}/plans`,
    `runs/${RUN_ID}/artifacts`,
    `runs/${RUN_ID}/feedback`,
    `runs/${RUN_ID}/local`,
  ]);
  assertEquals(checkedAgentObjectKey(RUN_ID, `runs/${RUN_ID}/inputs/request.json`), `runs/${RUN_ID}/inputs/request.json`);
  assertEquals(checkedAgentObjectKey(RUN_ID, "runs/other/inputs/request.json"), null);
  assertEquals(checkedAgentObjectKey(RUN_ID, `runs/${RUN_ID}/../other`), null);
  assertThrows(() => agentRunObjectDirectories("not-a-run"), Error, "agent_cleanup_run_id_invalid");
});

Deno.test("Storage listing names cannot escape their known directory", () => {
  const directory = `runs/${RUN_ID}/artifacts`;
  assertEquals(storageListObjectKey(directory, "call-id.png"), `${directory}/call-id.png`);
  assertEquals(storageListObjectKey(directory, "../request.json"), null);
  assertEquals(storageListObjectKey(directory, "nested/file.png"), null);
  assertEquals(storageListObjectKey(directory, ".emptyFolderPlaceholder"), null);
});
