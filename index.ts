/**
 * SingularityAPI Provider Extension
 *
 * Registers SingularityAPI (api.singularityapi.dev) as a custom provider.
 * Base URL: https://api.singularityapi.dev/v1 (OpenAI-compatible)
 *
 * SingularityAPI is an OpenAI-compatible gateway serving DeepSeek, Kimi, and
 * GPT models with per-request receipts: every response carries an
 * `x-singularity-receipt-id` header that resolves to exact tokens, cost, and
 * latency via GET /v1/receipts/{id}.
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: live GET /v1/models (requires API key) →
 *      transform per-endpoint capabilities → merge with embedded curation → cache
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * The /v1/models response carries per-endpoint capabilities
 * (context_window_tokens, maximum_output_tokens, default_output_tokens) and
 * pricing as 12-decimal per-million-token strings, so live data is
 * authoritative for cost/contextWindow/maxTokens. Reasoning is dynamic: when
 * the API advertises it (see extractLiveReasoning for the recognized shapes)
 * the API wins and thinking levels are populated automatically; while the API
 * stays silent, embedded curation (models.json + patch.json) supplies
 * reasoning flags, display names, and compat settings. patch.json is always
 * the final override.
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json
 *
 * Usage:
 *   # Option 1: Store in auth.json (recommended)
 *   # Add to ~/.pi/agent/auth.json:
 *   #   "singularity": { "type": "api_key", "key": "sapi_..." }
 *
 *   # Option 2: Set as environment variable
 *   export SINGULARITY_API_KEY=sapi_...
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-singularity-provider
 *
 * Then use /model to select from available models, and /singularity-receipt
 * to inspect the exact tokens, cost, and latency of any request.
 */

import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import deprecatedData from "./deprecated-models.json" with { type: "json" };
import fs from "fs";
import os from "os";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    thinkingFormat?: "openai" | "zai" | "qwen" | "qwen-chat-template" | "chat-template";
    supportsReasoningEffort?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
    chatTemplateKwargs?: Record<string, unknown>;
  };
}

interface PatchEntry {
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

/**
 * A model transformed from the live API. Unlike embedded entries, `reasoning`
 * may be undefined: that means the API says nothing about reasoning for this
 * model, so embedded curation decides. A present boolean is authoritative.
 */
interface LiveModel extends Omit<JsonModel, "reasoning"> {
  reasoning?: boolean;
}

// ─── Patch Application ────────────────────────────────────────────────────────

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  const result = { ...model };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
  if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = { ...patch.thinkingLevelMap };

  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost.input,
      output: patch.cost.output ?? result.cost.output,
      cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
      cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
    };
  }
  if (patch.compat) {
    result.compat = { ...(result.compat || {}), ...patch.compat };
  }

  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (!result.reasoning && result.thinkingLevelMap) {
    delete result.thinkingLevelMap;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }

  return result;
}

/** Full pipeline: base models → patch → custom → result */
function buildModels(base: JsonModel[], custom: JsonModel[], patch: PatchData): JsonModel[] {
  const modelMap = new Map<string, JsonModel>();

  // Seed with the base list plus grace-period deprecated models so patch.json
  // entries apply to deprecated models exactly as while the model was live
  // (withDeprecated keeps live data on id conflicts).
  for (const model of withDeprecated(base)) {
    modelMap.set(model.id, model);
  }

  for (const [id, patchEntry] of Object.entries(patch)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }

  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patchEntry = patch[model.id];
    if (existing && patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else {
      modelMap.set(model.id, model);
    }
  }

  return Array.from(modelMap.values());
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const PROVIDER_ID = "singularity";
const BASE_URL = "https://api.singularityapi.dev/v1";
const MODELS_URL = `${BASE_URL}/models`;
const RECEIPTS_URL = `${BASE_URL}/receipts`;
// Resolve pi's agent dir locally instead of importing it from the pi package:
// a runtime value import of "@earendil-works/pi-coding-agent" only resolves when
// pi happens to be reachable from the extension's node_modules (older pi
// versions and some install layouts don't provide it — e.g. npm -g on Windows).
// Semantics mirror pi's own getAgentDir(): env override, else ~/.pi/agent.
function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.join(os.homedir(), ".pi", "agent");
}

const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

// ─── Live Reasoning Detection ────────────────────────────────────────────────
//
// The /v1/models schema does not currently advertise reasoning, but the
// extension is ready for it. When the API starts exposing it, these shapes are
// recognized (checked on the chat-completions capability entry first, then on
// the model entry itself):
//
//   "reasoning": { "supported": true, "efforts": ["none","low","medium","high"] }   (canonical)
//   "reasoning": true | false                                                       (bare boolean)
//   "reasoning_effort_values": ["none","low",...]                                   (levels imply supported)
//   "supported_parameters": [..., "reasoning_effort", ...]                          (explicit list; absence = not supported)
//
// `efforts` aliases: efforts | reasoning_effort_values | reasoning_levels |
// thinking_levels. When supported is true but no levels are given, pi's level
// map falls back to SingularityAPI's documented set (none/low/medium/high).
// Whatever the API says wins over embedded curation; while it stays silent,
// curation stands. patch.json remains the final override either way.

interface LiveReasoningInfo {
  supported: boolean;
  efforts?: string[];
}

function pickEfforts(src: any): string[] | undefined {
  const raw = src?.efforts ?? src?.reasoning_effort_values ?? src?.reasoning_levels ?? src?.thinking_levels;
  if (!Array.isArray(raw)) return undefined;
  const values = raw.filter((v: any) => typeof v === "string" && v.length > 0);
  return values.length > 0 ? values : undefined;
}

function extractLiveReasoning(apiModel: any, cap: any): LiveReasoningInfo | undefined {
  // Two independent pieces of information: whether reasoning is supported, and
  // which effort values exist. The supported decision comes from the first
  // source (capability, then model) carrying any explicit signal — but effort
  // values are gathered from BOTH sources, so a bare boolean on the capability
  // still picks up a level array sitting on the model entry.
  let supported: boolean | undefined;
  let efforts: string[] | undefined;

  for (const src of [cap, apiModel]) {
    if (!src || typeof src !== "object") continue;

    if (efforts === undefined) efforts = pickEfforts(src);
    if (supported !== undefined) continue; // decision made; only gathering efforts

    const r = src.reasoning ?? src.supports_reasoning;
    if (r !== undefined && r !== null && typeof r === "object" && !Array.isArray(r)) {
      if (typeof r.supported === "boolean") {
        supported = r.supported;
        // Efforts declared inside the reasoning object outrank source-level arrays.
        const inner = pickEfforts(r);
        if (inner) efforts = inner;
      }
    } else if (typeof r === "boolean") {
      supported = r;
    } else if (pickEfforts(src)) {
      supported = true; // a level list with no explicit flag implies supported
    } else {
      const params = src.supported_parameters ?? src.supportedParameters;
      if (Array.isArray(params)) {
        // explicit parameter list is authoritative either way
        supported = params.some((p: any) => p === "reasoning_effort" || p === "reasoning");
      }
    }
  }

  return supported === undefined ? undefined : { supported, efforts };
}

// SingularityAPI's documented reasoning_effort values (see Chat Completions docs).
const DEFAULT_EFFORTS = ["none", "low", "medium", "high"];

/** Map pi's thinking levels onto the provider's supported effort values. */
function thinkingLevelMapFromEfforts(efforts: string[] | undefined): Record<string, string | null> | undefined {
  const supported = new Set((efforts && efforts.length > 0 ? efforts : DEFAULT_EFFORTS).map((e) => e.toLowerCase()));
  const pick = (...candidates: string[]): string | null => {
    for (const c of candidates) if (supported.has(c)) return c;
    return null;
  };
  const map: Record<string, string | null> = {
    off: pick("none", "off"),
    minimal: pick("minimal", "low"),
    low: pick("low"),
    medium: pick("medium"),
    high: pick("high"),
    xhigh: pick("xhigh"),
    max: pick("max"),
  };
  // A map that supports nothing would leave pi with no usable level — treat as absent.
  return Object.values(map).some((v) => v !== null) ? map : undefined;
}

/**
 * Transform a model from the SingularityAPI /v1/models response.
 *
 * Each model carries a `capabilities` array with one entry per endpoint it
 * serves (`/v1/chat/completions`, `/v1/responses`, `/v1/images/generations`),
 * each with its own limits and 12-decimal-string pricing. pi talks chat
 * completions, so only models with that exact capability are transformed —
 * an image-only or responses-only model would otherwise be registered as a
 * chat model and fail when selected. Reasoning is populated from the API when
 * advertised (see above); names and non-reasoning compat still come from
 * embedded curation via mergeWithEmbedded.
 */
function transformApiModel(apiModel: any): LiveModel | null {
  const id = apiModel?.id;
  if (!id || typeof id !== "string") return null;

  const caps = Array.isArray(apiModel.capabilities) ? apiModel.capabilities : [];
  const cap = caps.find((c: any) => c?.endpoint === "/v1/chat/completions");
  if (!cap) return null;

  const inputPrice = Number.parseFloat(cap.pricing?.input_per_million_usd ?? "");
  const outputPrice = Number.parseFloat(cap.pricing?.output_per_million_usd ?? "");
  const cachedPrice = Number.parseFloat(cap.pricing?.cached_input_per_million_usd ?? "");

  const model: LiveModel = {
    id,
    name: generateDisplayName(id),
    input: ["text"],
    cost: {
      input: Number.isFinite(inputPrice) ? inputPrice : 0,
      output: Number.isFinite(outputPrice) ? outputPrice : 0,
      cacheRead: Number.isFinite(cachedPrice) ? cachedPrice : 0,
      cacheWrite: 0,
    },
    contextWindow: cap.context_window_tokens || 0,
    maxTokens: cap.maximum_output_tokens || 8192,
  };

  const live = extractLiveReasoning(apiModel, cap);
  if (live) {
    model.reasoning = live.supported;
    if (live.supported) {
      const map = thinkingLevelMapFromEfforts(live.efforts);
      if (map) model.thinkingLevelMap = map;
      // reasoning_effort is the only thinking control SingularityAPI documents.
      model.compat = { thinkingFormat: "openai", supportsReasoningEffort: true };
    }
  }

  return model;
}

function generateDisplayName(id: string): string {
  return id
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<LiveModel[] | null> {
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    // SingularityAPI returns { object: "list", data: [...] }; tolerate a bare array.
    const apiModels = Array.isArray(data) ? data : data.data || [];
    if (!Array.isArray(apiModels) || apiModels.length === 0) return null;
    return apiModels.map(transformApiModel).filter((m): m is LiveModel => m !== null);
  } catch {
    return null;
  }
}

function loadCachedModels(): JsonModel[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheModels(models: JsonModel[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2) + "\n");
  } catch {
    // Cache write failure is non-fatal
  }
}

function mergeWithEmbedded(liveModels: LiveModel[], embeddedModels: JsonModel[]): JsonModel[] {
  const embeddedMap = new Map(embeddedModels.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const result: JsonModel[] = [];
  for (const liveModel of liveModels) {
    const embedded = embeddedMap.get(liveModel.id);
    seen.add(liveModel.id);
    if (embedded) {
      // Live /v1/models is authoritative for the fields it reports: pricing,
      // context window, and max output (sent with cache-control: no-store) —
      // live cost falls back to embedded only when the API reports 0.
      // Reasoning: a present live boolean wins (including an explicit
      // "not supported"); when the API is silent (undefined), embedded
      // curation decides. Remaining curation (name/input/other compat) wins
      // via ...embedded.
      const reasoning = liveModel.reasoning ?? embedded.reasoning;
      const compat = { ...liveModel.compat, ...embedded.compat };
      let thinkingLevelMap = liveModel.thinkingLevelMap ?? embedded.thinkingLevelMap;
      if (!reasoning) {
        thinkingLevelMap = undefined;
        delete compat.thinkingFormat;
        delete compat.supportsReasoningEffort;
      }
      const merged: JsonModel = {
        ...liveModel,
        ...embedded,
        reasoning,
        cost: {
          input: liveModel.cost.input || embedded.cost.input,
          output: liveModel.cost.output || embedded.cost.output,
          cacheRead: liveModel.cost.cacheRead || embedded.cost.cacheRead,
          cacheWrite: liveModel.cost.cacheWrite || embedded.cost.cacheWrite,
        },
        contextWindow: liveModel.contextWindow || embedded.contextWindow,
        maxTokens: liveModel.maxTokens || embedded.maxTokens,
      };
      if (thinkingLevelMap) merged.thinkingLevelMap = thinkingLevelMap;
      else delete merged.thinkingLevelMap;
      if (Object.keys(compat).length > 0) merged.compat = compat;
      else delete merged.compat;
      result.push(merged);
    } else {
      // Live-only model: default reasoning off when the API is silent.
      result.push({ ...liveModel, reasoning: liveModel.reasoning ?? false } as JsonModel);
    }
  }
  // Append any embedded models that the live API didn't return
  for (const em of embeddedModels) {
    if (!seen.has(em.id)) {
      result.push(em);
    }
  }
  return result;
}

// Grace period for delisted models. When the provider API stops listing a
// model, update-models.js moves its last-known definition into
// deprecated-models.json (stamped with deprecatedAt) instead of dropping it.
// For 14 days the model keeps working here so in-flight sessions and saved
// model settings do not break; afterwards it is evicted permanently.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Grace-period deprecated models with deprecation metadata stripped.
function activeDeprecatedModels(): JsonModel[] {
  const now = Date.now();
  const result: JsonModel[] = [];
  for (const entry of Object.values(deprecatedData as Record<string, JsonModel & { deprecatedAt?: string }>)) {
    if (!entry?.id) continue;
    const removedAt = Date.parse(entry.deprecatedAt ?? "");
    if (Number.isNaN(removedAt) || now - removedAt > DEPRECATED_MODEL_TTL_MS) continue;
    const model = { ...entry } as JsonModel & { deprecatedAt?: string };
    delete model.deprecatedAt;
    result.push(model);
  }
  return result;
}

// Append grace-period deprecated models the list does not already have (live data wins).
function withDeprecated(models: JsonModel[]): JsonModel[] {
  const seen = new Set(models.map((m) => m.id));
  const extras = activeDeprecatedModels().filter((m) => !seen.has(m.id));
  return extras.length > 0 ? [...models, ...extras] : models;
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (!cached || cached.length === 0) return embeddedModels;

  // Merge embedded models that are missing from cache (newly added models)
  const cachedMap = new Map(cached.map((m) => [m.id, m]));
  for (const em of embeddedModels) {
    if (!cachedMap.has(em.id)) {
      cached.push(em);
    }
  }
  return cached;
}

async function revalidateModels(apiKey: string | undefined, embeddedModels: JsonModel[], signal?: AbortSignal): Promise<JsonModel[] | null> {
  if (!apiKey) return null; // /v1/models requires auth; nothing to revalidate without a key

  const liveModels = await fetchLiveModels(apiKey, signal);
  const base = liveModels && liveModels.length > 0 ? mergeWithEmbedded(liveModels, embeddedModels) : embeddedModels;

  cacheModels(base);
  return base;
}

// ─── API Key Resolution (via ModelRegistry) ────────────────────────────────────

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = (await modelRegistry.getApiKeyForProvider(PROVIDER_ID)) ?? undefined;
}

// ─── Receipts ─────────────────────────────────────────────────────────────────
//
// Every SingularityAPI response carries x-singularity-request-id and
// x-singularity-receipt-id headers. Capture the latest receipt id from
// after_provider_response so /singularity-receipt works without arguments.
// The header is Singularity-specific, so its presence identifies our
// provider's responses among all after_provider_response events.

let lastReceiptId: string | undefined;

function receiptIdFromHeaders(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "x-singularity-receipt-id" && value) return value;
  }
  return undefined;
}

function formatReceipt(r: any, fallbackId: string): string {
  const lines: string[] = [];
  const state = r.state ?? "unknown";
  lines.push(`Receipt ${r.id ?? fallbackId} — ${state}`);

  const served = r.served_model ?? "?";
  const requested = r.requested_model;
  lines.push(`model: ${served}${requested && requested !== served ? ` (requested: ${requested})` : ""}`);

  // usage and total_cost_usd are null until the receipt reaches a terminal state
  const pending = r.usage == null && r.total_cost_usd == null;
  if (r.usage) {
    lines.push(
      `tokens: ${r.usage.input_tokens} in / ${r.usage.output_tokens} out${r.usage.estimated ? " (estimated)" : ""}`,
    );
  } else {
    lines.push("tokens: pending");
  }
  lines.push(`cost: ${r.total_cost_usd != null ? `$${r.total_cost_usd}` : "pending"}`);
  lines.push(`latency: ${r.latency_ms != null ? `${r.latency_ms} ms` : "pending"}`);

  if (r.request_transformed && Array.isArray(r.transformed_fields) && r.transformed_fields.length > 0) {
    lines.push(`transformed: ${r.transformed_fields.join(", ")}`);
  }
  if (pending) {
    lines.push("(receipt not terminal yet — retry shortly)");
  }
  return lines.join("\n");
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // SWR: Serve stale immediately (cache → embedded) — zero-latency registration
  const embeddedModels = modelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchData as PatchData;

  const staleBase = loadStaleModels(embeddedModels);
  const staleModels = buildModels(staleBase, customModels, patches);

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: BASE_URL,
    apiKey: "$SINGULARITY_API_KEY",
    api: "openai-completions",
    models: staleModels,
  });

  // Revalidate in background: fetch live /v1/models → merge → cache → hot-swap.
  // The models endpoint requires the API key; without one the embedded catalog
  // (and any disk cache) keeps serving as-is.
  pi.on("session_start", async (_event, ctx) => {
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();
    const signal = revalidateAbort.signal;
    resolveApiKey(ctx.modelRegistry).then(() => {
      revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
        if (freshBase && !signal.aborted) {
          pi.registerProvider(PROVIDER_ID, {
            baseUrl: BASE_URL,
            apiKey: "$SINGULARITY_API_KEY",
            api: "openai-completions",
            models: buildModels(freshBase, customModels, patches),
          });
        }
      });
    });
  });

  pi.on("session_shutdown", () => {
    revalidateAbort?.abort();
  });

  // Capture the receipt id of every SingularityAPI response for /singularity-receipt.
  pi.on("after_provider_response", (event) => {
    const id = receiptIdFromHeaders(event.headers);
    if (id) lastReceiptId = id;
  });

  // /singularity-receipt [receipt_id] — exact tokens, cost, and latency for a
  // request. Defaults to the most recent request's receipt.
  pi.registerCommand("singularity-receipt", {
    description: "Show a SingularityAPI receipt (exact tokens, cost, latency). Usage: /singularity-receipt [receipt_id] — defaults to the last request",
    getArgumentCompletions: (prefix) =>
      lastReceiptId && lastReceiptId.startsWith(prefix)
        ? [{ value: lastReceiptId, label: lastReceiptId, description: "last request's receipt" }]
        : null,
    handler: async (args, ctx) => {
      const id = args.trim() || lastReceiptId;
      if (!id) {
        ctx.ui.notify("No receipt yet — send a request on the singularity provider first, or pass a receipt id: /singularity-receipt rcpt_...", "info");
        return;
      }

      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
      if (!apiKey) {
        ctx.ui.notify("No SingularityAPI key resolved. Add a \"singularity\" credential to auth.json or set SINGULARITY_API_KEY.", "error");
        return;
      }

      let response: Response;
      try {
        response = await fetch(`${RECEIPTS_URL}/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        });
      } catch (error) {
        ctx.ui.notify(`Failed to fetch receipt ${id}: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      if (response.status === 404) {
        ctx.ui.notify(`Receipt ${id} not found — receipts only resolve for your own account.`, "error");
        return;
      }
      if (!response.ok) {
        ctx.ui.notify(`SingularityAPI error ${response.status} fetching receipt ${id}.`, "error");
        return;
      }

      try {
        const receipt = await response.json();
        ctx.ui.notify(formatReceipt(receipt, id), "info");
      } catch {
        ctx.ui.notify(`Receipt ${id}: could not parse response.`, "error");
      }
    },
  });
}
