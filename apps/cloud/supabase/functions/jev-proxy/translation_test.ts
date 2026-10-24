import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { discoveryResult, judgeInput } from "./protocol.ts";
import { parseTranslations, translationBatches } from "./translation.ts";
import { discoveryPrompt } from "./prompt.ts";
import { handler } from "./index.ts";

const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const image = btoa(String.fromCharCode(255, 216, 255, 217));
const source = { key: "label_0", name: "海报", description: "有完整主题的版式。排除：普通照片。" };
const english = { key: "label_0", name: "Poster", description: "A layout with a complete theme. Exclude ordinary photographs." };
function input() {
  return {
    action: "judge", idempotency_key: "english-test", allow_discovery: true,
    matching_version: 8, prompt_language: "en", translate_keys: ["label_0"], images: [image],
    request: { assets: { [id]: { type: "image", part: "image0" } }, state: { target: id },
      questions: { labels: { criteria: { label_0: { name: source.name, description: source.description,
        positive_examples: [], negative_examples: [] }, no_match: {} } } } },
  };
}
Deno.test("English criteria retain example identities, reject untranslated cache, validate exact translation keys", () => {
  const value = input();
  const parsed = judgeInput(value);
  assertEquals(parsed.translations, [source]);
  assertEquals((parsed.request.questions.labels.criteria.no_match as any).name, "No clear match");
  assertEquals(/[\u4e00-\u9fff]/.test(JSON.stringify(parsed.request.questions.labels.instructions)), false);
  for (const translate_keys of [["label_1"], ["no_match"], ["label_0", "label_0"], "label_0"]) {
    assertThrows(() => judgeInput({ ...value, translate_keys }));
  }
  assertThrows(() => judgeInput({ ...value, prompt_language: "zh" }));
  assertThrows(() => judgeInput({ ...value, prompt_language: undefined }));
  assertThrows(() => judgeInput({ ...value, translate_keys: [] }));
  value.request.questions.labels.criteria.label_0 = { ...value.request.questions.labels.criteria.label_0, ...english };
  value.translate_keys = [];
  assertEquals(judgeInput(value).translations, []);
});
Deno.test("Translation parsing requires all keys once, English and complete descriptions; batches are bounded", () => {
  const parse = (translations: unknown) => parseTranslations(JSON.stringify({ translations }), [source]);
  assertEquals(parse([english]), [english]);
  for (const translations of [[], [english, english], [{ ...english, key: "wrong" }],
    [{ ...english, name: "海报" }], [{ ...english, description: "" }], [{ ...english, description: "中文" }],
    [{ ...english, name: "P".repeat(161) }], [{ ...english, description: "A".repeat(4001) }]]) {
    assertThrows(() => parse(translations));
  }
  assertThrows(() => parseTranslations("not JSON", [source]));
  assertThrows(() => parseTranslations(JSON.stringify({ translations: [english] }), [{ ...source, description: "" }]));
  const labels = Array.from({ length: 254 }, (_, i) => ({ ...source, key: `label_${i}`, description: "中".repeat(1200) }));
  const batches = translationBatches(labels);
  assertEquals(batches.flat().length, 254);
  assertEquals(batches.every((batch) => batch.length <= 4 && new TextEncoder().encode(JSON.stringify(batch)).length <= 8000), true);
});
Deno.test("Cloud discovery returns bilingual new labels only for opted-in clients", () => {
  const label = { name: "界面", definition: "包含导航按钮的页面", exclusion: "普通海报不算", reason: "没有覆盖交互组件的类别" };
  const translated = { ...label, english: { name: "Interface", description: "A page with navigation buttons. Exclude ordinary posters." } };
  const wrap = (label: unknown) => JSON.stringify({ status: "new_label", label });
  assertEquals(discoveryResult(wrap(label), [], false).success, true);
  assertThrows(() => discoveryResult(wrap(label), [], true));
  assertThrows(() => discoveryResult(wrap(translated), [], false));
  assertEquals(discoveryResult(wrap(translated), [], true).value.label.english, translated.english);
  assertThrows(() => discoveryResult(wrap({ ...translated, english: { ...translated.english, description: "中文" } }), [], true));
  assertEquals(discoveryResult('{"status":"undetermined"}', [], true).success, false);
  assertEquals(discoveryPrompt(true).includes('"english":{"name"'), true);
  assertEquals(discoveryPrompt(false).includes('"english"'), false);
});

Deno.test("Claimed English judge translates before Jev, meters separately, replays, and refunds without Chinese fallback", async () => {
  const originalFetch = globalThis.fetch;
  const vars = { SUPABASE_URL: "https://cloud.test", SUPABASE_PUBLISHABLE_KEY: "public-test",
    SUPABASE_SECRET_KEY: "secret-test", JEV_API_KEY: "jev-test", JEV_CLASSIFICATION_COST_MICROS: "100",
    BOWERBIRD_CLOUD_MOCK: "false", ARK_API_KEY: "ark-test", ARK_VISION_MODEL: "vision-test" };
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(vars)) Deno.env.set(key, value);
  let row: any = { id, status: "judging" }, replay = false, failUsage = false, failStart = false;
  let preparationPhase = "translate";
  let loseCacheAcknowledgement = false;
  let translatedText = JSON.stringify({ translations: [english] });
  let jevCalls = 0, translationCalls = 0, usages = 0, budget = 0;
  let discoveryCalls = 0, discoveryUsages = 0;
  const discovered = { status: "new_label", label: { name: "界面", definition: "包含导航按钮的页面",
    exclusion: "普通海报不算", reason: "没有覆盖交互组件的类别",
    english: { name: "Interface", description: "A page with navigation buttons. Exclude ordinary posters." } } };
  const actions: string[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (resource, init) => {
    const req = new Request(resource, init), url = new URL(req.url);
    if (url.hostname === "cloud.test") {
      if (url.pathname === "/auth/v1/user") return json({ id });
      const rpc = url.pathname.split("/").at(-1), args = await req.json();
      if (rpc === "cleanup_classification") return json(null);
      if (rpc === "ensure_daily_credits") return json([{ topup_balance: 10 }]);
      if (rpc === "begin_classification") { budget = args.p_cost_micros; return json({ claimed: !replay, request: row }); }
      if (rpc === "claim_classification_preparation") {
        assertEquals(args.p_batch_count, 1); assertEquals(args.p_provider, "ark");
        return failStart ? json({ message: "offline" }, 500) : json({ phase: preparationPhase, batch: 0,
          translations: preparationPhase === "translate" ? [] : [english] });
      }
      if (rpc === "finish_classification_preparation") {
        assertEquals(args.p_translations, [english]); preparationPhase = "judge";
        return loseCacheAcknowledgement ? json({ message: "lost acknowledgement" }, 500) : json([english]);
      }
      if (rpc === "record_classification_translation_usage") {
        if (failUsage) return json({ message: "offline" }, 500);
        assertEquals(args.p_usage.total_tokens, 150); usages++; return json(null);
      }
      if (rpc === "start_classification_usage") return json(true);
      if (rpc === "record_classification_usage") { discoveryUsages++; return json(null); }
      if (rpc === "advance_classification") {
        actions.push(args.p_action);
        if (args.p_action === "claim_discovery") return json({ claimed: true, request: row });
        if (args.p_action === "discovery_done") { row.discovery_response = args.p_response; return json(row); }
        row = { ...row, judge_response: args.p_response ?? row.judge_response };
        if (args.p_action === "judge_done") row.status = "succeeded";
        return json(row);
      }
      throw new Error(`Unexpected RPC: ${rpc}`);
    }
    if (url.hostname === "ark.cn-beijing.volces.com") {
      const body = await req.json();
      assertEquals(body.max_tokens, 6000);
      if (body.messages[0].content.length === 2) {
        discoveryCalls++;
        assertEquals(body.messages[0].content[1].text.includes('"english":{"name"'), true);
        return json({ id: "discovery-test", model: "vision-test", usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
          choices: [{ message: { content: JSON.stringify(discovered) } }] });
      }
      translationCalls++;
      assertEquals(body.messages[0].content.length, 1); // Text only: no extra image upload.
      assertEquals(body.messages[0].content[0].text.includes(source.description), true);
      return json({ id: "translate-test", model: "vision-test", usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        choices: [{ message: { content: translatedText } }] });
    }
    if (url.hostname === "api.typesafe.ai") {
      jevCalls++;
      const form = await req.formData(), request = JSON.parse(await (form.get("request") as File).text());
      assertEquals(request.questions.labels.criteria.label_0.name, english.name);
      assertEquals(request.questions.labels.criteria.label_0.description, english.description);
      assertEquals(/[\u4e00-\u9fff]/.test(JSON.stringify(request)), false);
      return json({ answers: { labels: { type: "choice", confidence: 0.8, choice: "label_0", probabilities: { label_0: 0.8, no_match: 0.2 } } } });
    }
    throw new Error(`Unexpected host: ${url.hostname}`);
  };
  const call = (body = input()) => handler(new Request("https://proxy.test", { method: "POST", headers: { authorization: "Bearer test" }, body: JSON.stringify(body) }));
  try {
    const preparation = await (await call()).json();
    assertEquals(preparation.preparing, true); assertEquals(preparation.retry_after_ms, 0);
    assertEquals(preparation.label_translations, [english]); assertEquals(jevCalls, 0);
    const result = await call();
    assertEquals(result.status, 200);
    const payload = await result.json();
    assertEquals(payload.prompt_language, "en"); assertEquals(payload.label_translations, [english]);
    assertEquals(budget, 200); assertEquals(usages, 1); assertEquals(jevCalls, 1);
    replay = true;
    assertEquals(await (await call()).json(), payload);
    assertEquals(translationCalls, 1); assertEquals(usages, 1);
    replay = false;
    const cached = input(); cached.translate_keys = [];
    cached.request.questions.labels.criteria.label_0 = { ...cached.request.questions.labels.criteria.label_0, ...english };
    assertEquals((await (await call(cached)).json()).label_translations, []);
    assertEquals(translationCalls, 1); assertEquals(budget, 100);
    const discover = await handler(new Request("https://proxy.test", { method: "POST", headers: { authorization: "Bearer test" },
      body: JSON.stringify({ action: "discover", classification_id: id, image, labels: [], prompt_language: "en" }) }));
    assertEquals(discover.status, 200); assertEquals(await discover.json(), discovered);
    assertEquals(discoveryCalls, 1); assertEquals(discoveryUsages, 1); assertEquals(usages, 1);
    // A concurrent request that did not claim the supplier cannot fail/refund it.
    row.status = "judging"; preparationPhase = "busy"; replay = true;
    const actionCount = actions.length;
    const pending = await (await call()).json();
    assertEquals(pending.preparing, true); assertEquals(pending.retry_after_ms, 1000);
    assertEquals(actions.length, actionCount); assertEquals(translationCalls, 1); assertEquals(jevCalls, 2);
    replay = false; preparationPhase = "translate";
    translatedText = "invalid";
    assertEquals((await call()).status, 502);
    assertEquals(actions.at(-1), "fail"); assertEquals(jevCalls, 2); assertEquals(usages, 2);
    failUsage = true;
    assertEquals((await call()).status, 500);
    assertEquals(translationCalls, 3); assertEquals(usages, 2); assertEquals(jevCalls, 2);
    failUsage = false; failStart = true;
    const beforeUnownedFailure = actions.length;
    assertEquals((await call()).status, 500);
    assertEquals(translationCalls, 3); assertEquals(actions.length, beforeUnownedFailure);
    failStart = false; loseCacheAcknowledgement = true; translatedText = JSON.stringify({ translations: [english] });
    const beforeLostSave = actions.length;
    assertEquals((await call()).status, 500);
    assertEquals(actions.length, beforeLostSave); assertEquals(translationCalls, 4);
    loseCacheAcknowledgement = false;
    const recovered = await (await call()).json();
    assertEquals(recovered.label_translations, [english]); assertEquals(recovered.preparing, undefined);
    assertEquals(translationCalls, 4); // Recover the committed cache, never call the translator twice.
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
  }
});
