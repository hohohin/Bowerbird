import { assertEquals } from "jsr:@std/assert@1";
import { shortRewrite, standardTextFits } from "./bcoin-text.ts";
Deno.test("short input uses UTF-8 bytes rather than character count; long rewrite keeps separate pricing", () => {
  assertEquals(standardTextFits("a".repeat(8000)),true);
  assertEquals(standardTextFits("中".repeat(2667)),false);
  assertEquals(shortRewrite({operation:"text-rewrite",rewrite:{inputText:"short"}}),true);
  assertEquals(shortRewrite({operation:"text-rewrite",rewrite:{inputText:"a".repeat(8000)}}),false);
  assertEquals(shortRewrite({operation:"video-analysis",rewrite:{inputText:"short"}}),false);
});
