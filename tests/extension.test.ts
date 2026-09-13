/**
 * Behavioral tests for the SingularityAPI provider extension.
 *
 * Runs the real index.ts against a stubbed ExtensionAPI and a mocked fetch,
 * verifying: stale registration, live revalidation + merge semantics, disk
 * cache, receipt-id capture, and the /singularity-receipt command.
 *
 * Run with: bun test
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

const LIVE_MODELS_RESPONSE = {
  object: "list",
  data: [
    {
      id: "deepseek-v4-flash",
      object: "model",
      created: 1690000000,
      owned_by: "singularityapi",
      capabilities: [
        {
          endpoint: "/v1/chat/completions",
          context_window_tokens: 777777,
          maximum_output_tokens: 5555,
          default_output_tokens: 8192,
          pricing: { input_per_million_usd: "0.100000000000", output_per_million_usd: "0.200000000000" },
          // Canonical reasoning advertisement — but patch.json pins this
          // model's reasoning experimentally, and the patch is the final
          // override, so the patch map (not this one) must win.
          reasoning: { supported: true, efforts: ["none", "low", "high"] },
        },
      ],
    },
    {
      // Reasoning advertised on a now-PATCHED model: live limits still win
      // (300000 vs embedded 262144), but the patch map shadows the API's map.
      id: "kimi-k2.6",
      object: "model",
      created: 1690000000,
      owned_by: "singularityapi",
      capabilities: [
        {
          endpoint: "/v1/chat/completions",
          context_window_tokens: 300000,
          maximum_output_tokens: 32768,
          default_output_tokens: 8192,
          pricing: { input_per_million_usd: "0.581000000000", output_per_million_usd: "2.448000000000" },
          reasoning: { supported: true, efforts: ["none", "low", "medium", "high"] },
        },
      ],
    },
    {
      // Explicit negative: supported_parameters present without reasoning_effort.
      // Embedded curation says reasoning: true for gpt-5.6-luna — the API wins.
      id: "gpt-5.6-luna",
      object: "model",
      created: 1690000000,
      owned_by: "singularityapi",
      capabilities: [
        {
          endpoint: "/v1/chat/completions",
          context_window_tokens: 272000,
          maximum_output_tokens: 128000,
          default_output_tokens: 8192,
          pricing: { input_per_million_usd: "1.000000000000", output_per_million_usd: "6.000000000000" },
          supported_parameters: ["max_tokens", "stream", "tools", "temperature"],
        },
      ],
    },
    {
      // Image-only model: no chat completions capability → must be skipped,
      // never registered as a chat model.
      id: "image-gen-1",
      object: "model",
      created: 1690000002,
      owned_by: "singularityapi",
      capabilities: [
        {
          endpoint: "/v1/images/generations",
          context_window_tokens: 0,
          maximum_output_tokens: 0,
          default_output_tokens: 0,
          pricing: { input_per_million_usd: "0.000000000000", output_per_million_usd: "0.000000000000" },
        },
      ],
    },
    {
      // Unknown model with two capability entries: the chat completions one must win.
      // Split reasoning signal: bare boolean on the capability, level array on
      // the model entry — the levels must still be picked up (not defaults).
      id: "new-model-x",
      object: "model",
      created: 1690000001,
      owned_by: "singularityapi",
      reasoning_effort_values: ["none", "low", "high", "xhigh"],
      capabilities: [
        {
          endpoint: "/v1/responses",
          context_window_tokens: 100000,
          maximum_output_tokens: 4096,
          default_output_tokens: 4096,
          pricing: { input_per_million_usd: "9.000000000000", output_per_million_usd: "9.000000000000" },
        },
        {
          endpoint: "/v1/chat/completions",
          context_window_tokens: 100000,
          maximum_output_tokens: 8192,
          default_output_tokens: 8192,
          pricing: { input_per_million_usd: "1.000000000000", output_per_million_usd: "2.000000000000" },
          // Bare boolean: supported; the levels come from the model entry above.
          reasoning: true,
        },
      ],
    },
    {
      // Canonical reasoning advertisement on an UNPATCHED live-only model:
      // the API wins outright, including a genuine "minimal" effort.
      id: "new-model-y",
      object: "model",
      created: 1690000003,
      owned_by: "singularityapi",
      capabilities: [
        {
          endpoint: "/v1/chat/completions",
          context_window_tokens: 64000,
          maximum_output_tokens: 4096,
          default_output_tokens: 4096,
          pricing: { input_per_million_usd: "0.500000000000", output_per_million_usd: "1.500000000000" },
          reasoning: { supported: true, efforts: ["none", "minimal", "low", "medium", "high"] },
        },
      ],
    },
  ],
};

const RECEIPT = {
  id: "rcpt_123",
  object: "route_receipt",
  request_id: "req_1",
  requested_model: "deepseek-v4-flash",
  served_model: "deepseek-v4-flash",
  surface: "chat_completions",
  requested_contract: null,
  contract_passed: false,
  state: "settled",
  fallbacks_attempted: 0,
  attempts_count: 1,
  request_transformed: true,
  transformed_fields: ["max_tokens"],
  usage: { input_tokens: 123, output_tokens: 45, estimated: false },
  latency_ms: 812,
  total_cost_usd: "0.000123456789",
  created_at: "2026-08-03T00:00:00.000000Z",
  terminal_at: "2026-08-03T00:00:01.000000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A minimal ExtensionAPI stub capturing registrations, handlers, and commands. */
function makePiStub() {
  const registrations: { id: string; config: any }[] = [];
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  return {
    registrations,
    handlers,
    commands,
    registerProvider(id: string, config: any) {
      registrations.push({ id, config });
    },
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
  };
}

function makeCtx(apiKey: string | undefined) {
  const notifications: { message: string; type?: string }[] = [];
  return {
    notifications,
    modelRegistry: {
      getApiKeyForProvider: async (_provider: string) => apiKey,
    },
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  };
}

let agentDir: string;
let realFetch: typeof globalThis.fetch;
let extension: any;

beforeEach(async () => {
  // Isolate the pi agent dir (disk cache location) per test.
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-singularity-test-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "https://api.singularityapi.dev/v1/models") {
      const auth = init?.headers?.Authorization ?? init?.headers?.authorization;
      if (auth !== "Bearer test-key") return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse(LIVE_MODELS_RESPONSE);
    }
    if (url === "https://api.singularityapi.dev/v1/receipts/rcpt_123") {
      return jsonResponse(RECEIPT);
    }
    if (url.startsWith("https://api.singularityapi.dev/v1/receipts/")) {
      return jsonResponse({ error: { code: "receipt_not_found" } }, 404);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;

  // Import fresh per test so module state (cache paths, lastReceiptId) resets.
  const spec = `../index.ts?test=${Date.now()}-${Math.random()}`;
  extension = (await import(spec)).default;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(agentDir, { recursive: true, force: true });
});

async function flushMicrotasks(turns = 20) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe("provider registration (stale-while-revalidate)", () => {
  test("registers immediately with the embedded catalog", () => {
    const pi = makePiStub();
    extension(pi as any);

    expect(pi.registrations).toHaveLength(1);
    const reg = pi.registrations[0];
    expect(reg.id).toBe("singularity");
    expect(reg.config.baseUrl).toBe("https://api.singularityapi.dev/v1");
    expect(reg.config.apiKey).toBe("$SINGULARITY_API_KEY");
    expect(reg.config.api).toBe("openai-completions");

    const models = reg.config.models;
    expect(models).toHaveLength(8);

    const luna = models.find((m: any) => m.id === "gpt-5.6-luna");
    expect(luna).toMatchObject({
      name: "GPT-5.6 Luna",
      reasoning: true,
      contextWindow: 272000,
      maxTokens: 128000,
      cost: { input: 1.0, output: 6.0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(luna.thinkingLevelMap.off).toBe("none");
    expect(luna.thinkingLevelMap.xhigh).toBeNull();
    expect(luna.compat).toMatchObject({
      thinkingFormat: "openai",
      supportsReasoningEffort: true,
      maxTokensField: "max_completion_tokens",
      supportsDeveloperRole: false,
      supportsStore: false,
    });

    // patch.json enables reasoning experimentally for every non-GPT model:
    // "off" is deliberately absent from the map, so thinking-off requests send
    // no reasoning_effort at all; low/medium/high map to the same-named effort.
    const flash = models.find((m: any) => m.id === "deepseek-v4-flash");
    expect(flash.reasoning).toBe(true);
    expect(flash.thinkingLevelMap).toEqual({
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
    expect(flash.thinkingLevelMap.off).toBeUndefined();
    expect(flash.compat.thinkingFormat).toBe("openai");
    expect(flash.compat.supportsReasoningEffort).toBe(true);
    expect(flash.contextWindow).toBe(1000000);
    expect(flash.maxTokens).toBe(384000);

    for (const id of ["deepseek-v4-pro", "deepseek-v3.2", "kimi-k2.6", "kimi-k2.7-code"]) {
      const patched = models.find((m: any) => m.id === id);
      expect(patched.reasoning).toBe(true);
      expect(patched.thinkingLevelMap).toEqual(flash.thinkingLevelMap);
      expect(patched.thinkingLevelMap.off).toBeUndefined();
      expect(patched.compat.thinkingFormat).toBe("openai");
      expect(patched.compat.supportsReasoningEffort).toBe(true);
    }
  });

  test("revalidates on session_start: live limits/pricing win, curation kept, cache written", async () => {
    const pi = makePiStub();
    extension(pi as any);

    const ctx = makeCtx("test-key");
    await pi.handlers.get("session_start")({}, ctx);
    await flushMicrotasks();

    expect(pi.registrations).toHaveLength(2);
    const models = pi.registrations[1].config.models;

    // 8 embedded + 2 live-only models; deepseek-v4-flash merged, not duplicated
    expect(models).toHaveLength(10);
    expect(models.filter((m: any) => m.id === "deepseek-v4-flash")).toHaveLength(1);

    const flash = models.find((m: any) => m.id === "deepseek-v4-flash");
    // Live values win for the fields /v1/models is authoritative for...
    expect(flash.contextWindow).toBe(777777);
    expect(flash.maxTokens).toBe(5555);
    expect(flash.cost.input).toBeCloseTo(0.1, 10);
    expect(flash.cost.output).toBeCloseTo(0.2, 10);
    // ...but for reasoning, patch.json is the final override: the experimental
    // patch map shadows the API-advertised one (off stays absent → thinking-off
    // sends nothing; medium enabled by the patch despite the API omitting it).
    expect(flash.reasoning).toBe(true);
    expect(flash.thinkingLevelMap).toEqual({
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
    expect(flash.thinkingLevelMap.off).toBeUndefined();
    expect(flash.compat.thinkingFormat).toBe("openai");
    expect(flash.compat.supportsReasoningEffort).toBe(true);
    // ...while non-reasoning embedded curation is preserved
    expect(flash.name).toBe("DeepSeek V4 Flash");
    expect(flash.compat.maxTokensField).toBe("max_completion_tokens");

    // kimi-k2.6 is patched too: live limits still win (300000 vs embedded
    // 262144), but the patch map shadows the API-advertised one — same final
    // override semantics as flash.
    const kimi = models.find((m: any) => m.id === "kimi-k2.6");
    expect(kimi.name).toBe("Kimi K2.6");
    expect(kimi.contextWindow).toBe(300000);
    expect(kimi.reasoning).toBe(true);
    expect(kimi.thinkingLevelMap).toEqual(flash.thinkingLevelMap);
    expect(kimi.thinkingLevelMap.off).toBeUndefined();
    expect(kimi.compat.thinkingFormat).toBe("openai");
    expect(kimi.compat.supportsReasoningEffort).toBe(true);
    expect(kimi.compat.maxTokensField).toBe("max_completion_tokens");

    // On an UNPATCHED live-only model, the API's canonical reasoning
    // advertisement wins outright — including a genuine "minimal" effort,
    // which maps to itself rather than falling back to "low".
    const modelY = models.find((m: any) => m.id === "new-model-y");
    expect(modelY.reasoning).toBe(true);
    expect(modelY.contextWindow).toBe(64000);
    expect(modelY.thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
    expect(modelY.compat.thinkingFormat).toBe("openai");
    expect(modelY.compat.supportsReasoningEffort).toBe(true);

    // Explicit API negative (supported_parameters without reasoning_effort)
    // overrides embedded curation's reasoning: true
    const luna = models.find((m: any) => m.id === "gpt-5.6-luna");
    expect(luna.reasoning).toBe(false);
    expect(luna.thinkingLevelMap).toBeUndefined();
    expect(luna.compat.thinkingFormat).toBeUndefined();
    expect(luna.compat.supportsReasoningEffort).toBeUndefined();
    expect(luna.compat.maxTokensField).toBe("max_completion_tokens");

    // A live-only model gets transformed defaults, preferring the chat
    // completions capability over the responses one (8192, not 4096).
    // Bare `reasoning: true` yields the default effort set.
    const newbie = models.find((m: any) => m.id === "new-model-x");
    expect(newbie).toMatchObject({
      name: "New Model X",
      reasoning: true,
      input: ["text"],
      contextWindow: 100000,
      maxTokens: 8192,
    });
    expect(newbie.cost).toMatchObject({ input: 1.0, output: 2.0, cacheRead: 0, cacheWrite: 0 });
    // Model-level efforts win over defaults despite the cap-level bare boolean:
    // medium absent (not advertised), xhigh present (advertised).
    expect(newbie.thinkingLevelMap).toEqual({
      off: "none",
      minimal: "low",
      low: "low",
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: null,
    });
    expect(newbie.compat.thinkingFormat).toBe("openai");
    expect(newbie.compat.supportsReasoningEffort).toBe(true);

    // Image-only models are filtered out, not registered as chat models
    expect(models.find((m: any) => m.id === "image-gen-1")).toBeUndefined();

    // Disk cache written for the next cold start
    const cachePath = path.join(agentDir, "cache", "singularity-models.json");
    expect(fs.existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    expect(cached.find((m: any) => m.id === "new-model-x")).toBeTruthy();
  });

  test("serves the disk cache on the next cold start, with new embedded models merged in", async () => {
    const pi1 = makePiStub();
    extension(pi1 as any);
    await pi1.handlers.get("session_start")({}, makeCtx("test-key"));
    await flushMicrotasks();

    // Fresh module state, same agent dir: second load must pick up the cache
    const fresh = (await import(`../index.ts?test=cold-${Date.now()}`)).default;
    const pi2 = makePiStub();
    fresh(pi2 as any);

    const models = pi2.registrations[0].config.models;
    expect(models.find((m: any) => m.id === "new-model-x")).toBeTruthy();
    expect(models.find((m: any) => m.id === "deepseek-v4-flash").contextWindow).toBe(777777);
    expect(models).toHaveLength(10);
  });

  test("keeps the embedded catalog when no API key is configured", async () => {
    const pi = makePiStub();
    extension(pi as any);

    await pi.handlers.get("session_start")({}, makeCtx(undefined));
    await flushMicrotasks();

    // No key → no live fetch possible → no re-registration
    expect(pi.registrations).toHaveLength(1);
    expect(pi.registrations[0].config.models).toHaveLength(8);
  });

  test("keeps serving stale models when the live fetch fails", async () => {
    globalThis.fetch = (async () => { throw new Error("network down"); }) as any;
    const pi = makePiStub();
    extension(pi as any);

    await pi.handlers.get("session_start")({}, makeCtx("test-key"));
    await flushMicrotasks();

    expect(pi.registrations).toHaveLength(2);
    expect(pi.registrations[1].config.models).toHaveLength(8);
  });

  test("aborts a superseded revalidation on shutdown", async () => {
    const pi = makePiStub();
    extension(pi as any);
    await pi.handlers.get("session_start")({}, makeCtx("test-key"));
    await pi.handlers.get("session_shutdown")({}, makeCtx("test-key"));
    await flushMicrotasks();
    // Shutdown aborted the in-flight revalidation before it could re-register
    expect(pi.registrations).toHaveLength(1);
  });
});

describe("/singularity-receipt", () => {
  test("reports a helpful message when there is no receipt id", async () => {
    const pi = makePiStub();
    extension(pi as any);
    const ctx = makeCtx("test-key");

    await pi.commands.get("singularity-receipt").handler("", ctx);
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0].message).toContain("No receipt yet");
    expect(ctx.notifications[0].type).toBe("info");
  });

  test("captures the receipt id from response headers and fetches it by default", async () => {
    const pi = makePiStub();
    extension(pi as any);

    await pi.handlers.get("after_provider_response")({
      type: "after_provider_response",
      status: 200,
      headers: { "X-Singularity-Receipt-Id": "rcpt_123", "content-type": "text/event-stream" },
    });

    const ctx = makeCtx("test-key");
    await pi.commands.get("singularity-receipt").handler("", ctx);

    expect(ctx.notifications).toHaveLength(1);
    const text = ctx.notifications[0].message;
    expect(text).toContain("Receipt rcpt_123 — settled");
    expect(text).toContain("model: deepseek-v4-flash");
    expect(text).toContain("tokens: 123 in / 45 out");
    expect(text).toContain("cost: $0.000123456789");
    expect(text).toContain("latency: 812 ms");
    expect(text).toContain("transformed: max_tokens");
    expect(ctx.notifications[0].type).toBe("info");
  });

  test("fetches an explicitly passed receipt id", async () => {
    const pi = makePiStub();
    extension(pi as any);
    const ctx = makeCtx("test-key");

    await pi.commands.get("singularity-receipt").handler("rcpt_123", ctx);
    expect(ctx.notifications[0].message).toContain("Receipt rcpt_123 — settled");
  });

  test("handles 404 for unknown or foreign receipts", async () => {
    const pi = makePiStub();
    extension(pi as any);
    const ctx = makeCtx("test-key");

    await pi.commands.get("singularity-receipt").handler("rcpt_nope", ctx);
    expect(ctx.notifications[0].message).toContain("not found");
    expect(ctx.notifications[0].type).toBe("error");
  });

  test("errors clearly when no API key is configured", async () => {
    const pi = makePiStub();
    extension(pi as any);
    const ctx = makeCtx(undefined);

    await pi.commands.get("singularity-receipt").handler("rcpt_123", ctx);
    expect(ctx.notifications[0].message).toContain("No SingularityAPI key");
    expect(ctx.notifications[0].type).toBe("error");
  });

  test("offers the last receipt id as an argument completion", async () => {
    const pi = makePiStub();
    extension(pi as any);
    await pi.handlers.get("after_provider_response")({
      type: "after_provider_response",
      status: 200,
      headers: { "x-singularity-receipt-id": "rcpt_123" },
    });

    const completions = pi.commands.get("singularity-receipt").getArgumentCompletions("rcpt_");
    expect(completions).toHaveLength(1);
    expect(completions[0].value).toBe("rcpt_123");
    expect(pi.commands.get("singularity-receipt").getArgumentCompletions("zzz")).toBeNull();
  });
});
