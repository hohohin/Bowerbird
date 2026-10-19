import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  catalogue,
  discoveryResult,
  hasMatches,
  judgeInput,
  readJson,
} from "./protocol.ts";
import { handler } from "./index.ts";

const image = btoa(String.fromCharCode(255, 216, 255, 217));
const target = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
function input() {
  return {
    action: "judge",
    idempotency_key: "test",
    allow_discovery: true,
    images: [image],
    request: {
      model: "attacker-model",
      assets: { [target]: { type: "image", part: "image0" } },
      state: { target },
      questions: {
        labels: {
          criteria: {
            label_0: {
              name: "海报",
              description: "有层次的完整主题版式",
              positive_examples: [],
              negative_examples: [],
            },
            no_match: {},
          },
        },
      },
    },
  };
}
function response(p = 0.7) {
  return {
    answers: {
      labels: {
        type: "choice",
        confidence: 0.8,
        choice: p >= 0.5 ? "label_0" : "no_match",
        probabilities: { label_0: p, no_match: 1 - p },
      },
    },
  };
}
const labels = [{
  id: "poster",
  name: "海报",
  definition: "完整主题版式",
  enabled: true,
}];
Deno.test("Only bounded image choice requests are forwarded; model/instructions stay server-owned", () => {
  assertEquals(judgeInput(input()).request.model, "jev-latest");
  const bad = input();
  bad.request.assets[target].type = "url";
  assertThrows(() => judgeInput(bad));
  const extra = input();
  extra.images.push(image);
  assertThrows(() => judgeInput(extra));
  const negative = input();
  (negative.request.questions.labels.criteria.label_0
    .negative_examples as string[]).push(target);
  assertThrows(() => judgeInput(negative));
  assertThrows(() => catalogue([...labels, ...labels]));
});
Deno.test("Raw 30% includes exact threshold and ignores no_match winner, malformed probabilities never charge", () => {
  assertEquals(hasMatches(response(0.3), 1), true);
  assertEquals(hasMatches(response(0.299), 1), false);
  const bad = response();
  bad.answers.labels.probabilities.no_match = 0.5;
  assertThrows(() => hasMatches(bad, 1));
  const winner = response();
  winner.answers.labels.choice = "no_match";
  assertThrows(() => hasMatches(winner, 1));
});
Deno.test("Cloud fallback validates reusable IDs, one new label + boundaries; unknown doesn't count", () => {
  assertEquals(
    discoveryResult('{"status":"matched","label_ids":["poster"]}', labels)
      .success,
    true,
  );
  assertEquals(
    discoveryResult('{"status":"undetermined"}', labels).success,
    false,
  );
  assertThrows(() =>
    discoveryResult('{"status":"matched","label_ids":["fake"]}', labels)
  );
  assertThrows(() =>
    discoveryResult('{"status":"matched","label_ids":["poster"]}', [{
      ...labels[0],
      enabled: false,
    }])
  );
  const v = {
    status: "new_label",
    label: {
      name: "界面",
      definition: "导航、按钮和输入组件组成的操作页面",
      exclusion: "普通海报不算",
      reason: "海报不覆盖可操作页面的组件结构",
    },
  };
  assertEquals(discoveryResult(JSON.stringify(v), labels).success, true);
  v.label.name = "海报";
  assertThrows(() => discoveryResult(JSON.stringify(v), labels));
  v.label.name = "界面";
  v.label.exclusion = "";
  assertThrows(() => discoveryResult(JSON.stringify(v), labels));
});
Deno.test("Streaming body limit works without content-length", async () => {
  await assertRejects(() =>
    readJson(
      new Request("https://local.test", {
        method: "POST",
        body: "x".repeat(24 * 1024 * 1024 + 1),
      }),
    )
  );
});

Deno.test("Authenticated synchronous proxy uses server secret, same-image free fallback, no queue/storage; failures refund", async () => {
  const fetch = globalThis.fetch;
  const vars = {
    SUPABASE_URL: "https://cloud.test",
    SUPABASE_PUBLISHABLE_KEY: "public-test",
    SUPABASE_SECRET_KEY: "secret-test",
    JEV_API_KEY: "jev-server-secret",
    JEV_CLASSIFICATION_COST_MICROS: "100",
    BOWERBIRD_CLOUD_MOCK: "false",
    ARK_API_KEY: "ark-test",
    ARK_VISION_MODEL: "vision-test",
  };
  const previous = Object.fromEntries(
    Object.keys(vars).map((k) => [k, Deno.env.get(k)]),
  );
  Object.entries(vars).forEach(([k, v]) => Deno.env.set(k, v));
  let upstreamCalls = 0, cloudCalls = 0;
  let failed = false, matched = true;
  let row: any = { id: target, status: "judging" };
  const advances: any[] = [];
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), {
      status,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = async (resource, init) => {
    const req = new Request(resource, init), url = new URL(req.url);
    if (url.hostname === "cloud.test") {
      if (url.pathname === "/auth/v1/user") {
        return json({ id: target, email: "test@example.test" });
      }
      if (url.pathname === "/rest/v1/subscriptions") {
        return json({ tier: "pro", status: "active" });
      }
      const rpc = url.pathname.split("/").at(-1), args = await req.json();
      if (rpc === "cleanup_classification") return json(null);
      if (rpc === "ensure_daily_credits") return json([{ daily_balance: 30 }]);
      if (rpc === "begin_classification") {
        return json({ claimed: true, request: row });
      }
      if (rpc === "advance_classification") {
        advances.push(args);
        if (args.p_action === "claim_discovery") {
          return json({ claimed: true, request: row });
        }
        row = {
          ...row,
          judge_response: args.p_action === "await_discovery" ||
              args.p_action === "judge_done"
            ? args.p_response
            : row.judge_response,
          discovery_response: args.p_action === "discovery_done"
            ? args.p_response
            : row.discovery_response,
        };
        return json(row);
      }
      throw new Error(`unexpected RPC ${rpc}`);
    }
    if (url.hostname === "api.typesafe.ai") {
      upstreamCalls++;
      assertEquals(
        req.headers.get("authorization"),
        "Bearer jev-server-secret",
      );
      assertEquals(req.headers.get("typesafe-danger-zone-images"), "true");
      const form = await req.formData();
      assertEquals(form.get("image0") instanceof File, true);
      const raw = JSON.parse(await (form.get("request") as File).text());
      assertEquals(raw.model, "jev-latest");
      return failed
        ? json({ secret: "not exposed" }, 401)
        : json(response(matched ? 0.7 : 0.1));
    }
    if (url.hostname === "ark.cn-beijing.volces.com") {
      cloudCalls++;
      return json({
        choices: [{
          message: { content: '{"status":"matched","label_ids":["poster"]}' },
        }],
      });
    }
    throw new Error(`Unexpected external request ${url.hostname}`);
  };
  const call = (body: unknown, authenticated = true) =>
    handler(
      new Request("https://proxy.test", {
        method: "POST",
        headers: authenticated ? { authorization: "Bearer user-token" } : {},
        body: JSON.stringify(body),
      }),
    );
  try {
    assertEquals((await call(input(), false)).status, 401);
    assertEquals(upstreamCalls, 0);
    const result = await call(input());
    assertEquals(result.status, 200);
    assertEquals((await result.json()).classification_id, target);
    assertEquals(advances.at(-1).p_success, true);
    matched = false;
    await call(input());
    assertEquals(advances.at(-1).p_action, "await_discovery");
    const discover = await call({
      action: "discover",
      classification_id: target,
      image,
      labels,
    });
    assertEquals(discover.status, 200);
    assertEquals(advances.at(-1).p_action, "discovery_done");
    assertEquals(advances.at(-1).p_success, true);
    assertEquals(cloudCalls, 1);
    failed = true;
    const failure = await call(input());
    assertEquals(failure.status, 502);
    assertEquals(advances.at(-1).p_action, "fail");
    assertEquals((await failure.text()).includes("not exposed"), false);
    assertEquals(upstreamCalls, 3);
  } finally {
    globalThis.fetch = fetch;
    Object.entries(previous).forEach(([k, v]) =>
      v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v)
    );
  }
});
