import { assertEquals } from "jsr:@std/assert@1";
import {
  acceptsFeedbackResultCount,
  allowsMultipleFinalResults,
  feedbackResultRoleGroups,
} from "./agent-result-artifacts.ts";

Deno.test("unified Agent accepts either a final_result or one HTML primary screenshot", () => {
  assertEquals(feedbackResultRoleGroups("bowerbird-unified-agent"), [
    ["final_result"],
    ["viewport_screenshot", "full_page_screenshot"],
  ]);
});

Deno.test("dedicated HTML Skill accepts only one HTML primary screenshot", () => {
  assertEquals(feedbackResultRoleGroups("bowerbird-html-layout-render"), [
    ["viewport_screenshot", "full_page_screenshot"],
  ]);
});

Deno.test("other Skills continue to require final_result", () => {
  assertEquals(feedbackResultRoleGroups("bowerbird-controlled-image-edit"), [["final_result"]]);
});

Deno.test("unified Agent accepts every non-empty final_result set", () => {
  assertEquals(allowsMultipleFinalResults("bowerbird-unified-agent"), true);
  assertEquals(acceptsFeedbackResultCount("bowerbird-unified-agent", ["final_result"], 0), false);
  assertEquals(acceptsFeedbackResultCount("bowerbird-unified-agent", ["final_result"], 1), true);
  assertEquals(acceptsFeedbackResultCount("bowerbird-unified-agent", ["final_result"], 8), true);
});

Deno.test("legacy and HTML primary result groups remain singular", () => {
  assertEquals(allowsMultipleFinalResults("bowerbird-controlled-image-edit"), false);
  assertEquals(acceptsFeedbackResultCount("bowerbird-controlled-image-edit", ["final_result"], 2), false);
  assertEquals(acceptsFeedbackResultCount("bowerbird-unified-agent", ["full_page_screenshot"], 2), false);
});
