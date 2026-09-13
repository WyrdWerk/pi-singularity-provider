# Integrating SingularityAPI with Any Coding Agent

This guide is for **agents and tools other than pi** (and for humans wiring one up by hand). SingularityAPI is OpenAI-compatible, so any coding agent that can talk to a custom OpenAI-style endpoint can use it: you need only the base URL and an API key. Everything beyond step 1 is optional polish — live model metadata, reasoning levels, and per-request cost receipts — which this document specifies fully so any agent can replicate what this repository implements for pi.

> Reference implementation: [`index.ts`](index.ts) in this repository (the pi extension). It realizes every pattern described below and is intentionally readable.

## 1. Minimum viable setup (2 minutes)

- **Base URL:** `https://api.singularityapi.dev/v1`
- **Auth:** `Authorization: Bearer sapi_...` (keys are issued from the SingularityAPI dashboard)
- **Chat endpoint:** `POST /v1/chat/completions` — standard OpenAI request/response shape, SSE streaming supported.

Any agent with a "custom OpenAI provider" setting (env vars like `OPENAI_BASE_URL`/`OPENAI_API_KEY`, or a provider config block) works at this level immediately:

```bash
curl https://api.singularityapi.dev/v1/chat/completions \
  -H "Authorization: Bearer $SINGULARITY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "hello"}],
    "max_completion_tokens": 1024
  }'
```

### Request-parameter policy (read this — it bites)

SingularityAPI **rejects unsupported parameters with a 400** instead of ignoring them. Be conservative:

- Use `max_completion_tokens` (not `max_tokens` — the gateway transforms it, but send the modern field).
- Do **not** send `store`, `developer`-role messages, or provider-specific extras unless the model advertises support.
- If you get a 400 naming a parameter, drop it and retry — that is the intended discovery loop.

## 2. Live model metadata — `GET /v1/models`

Fetch the catalog instead of hardcoding models; it is the source of truth for limits and pricing. Requires the same Bearer auth.

```jsonc
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-flash",
      "object": "model",
      "capabilities": [
        {
          "endpoint": "/v1/chat/completions",       // one capability entry per surface
          "context_window_tokens": 1000000,
          "maximum_output_tokens": 384000,
          "default_output_tokens": 8192,
          "pricing": {
            "input_per_million_usd": "0.140000000000",   // strings, 12 decimals,
            "output_per_million_usd": "0.280000000000"   // USD per million tokens
          }
        }
      ]
    }
  ]
}
```

Rules for interpreting it:

- **Filter on `endpoint == "/v1/chat/completions"` exactly.** A model may also serve `/v1/responses` or `/v1/images/generations`; entries without a chat-completions capability (e.g. image-only models) are not chat models — do not register them as such.
- **Pricing strings parse to floats** (USD per million tokens). Running cost estimate = `(input_tokens / 1_000_000 × input_rate) + (output_tokens / 1_000_000 × output_rate)`; see §5 for the authoritative figure.
- **Refresh strategy** (what the pi extension does): ship/embed a snapshot so startup is instant, refresh from the API asynchronously on session start, cache the result on disk, and let live values win for `context_window`, `maximum_output_tokens`, and pricing while keeping your own display names and compatibility flags. Merge by model `id`; never duplicate.

## 3. Reasoning (thinking levels)

Reasoning is controlled with the OpenAI-style `reasoning_effort` parameter.

**GPT-5.6 models** (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`) are reasoning models, and their upstream **rejects tool calls that omit `reasoning_effort`** ("Function tools with reasoning_effort are not supported…"). So always send it explicitly for them — including `"none"` when thinking is off. Levels: `none`, `low`, `medium`, `high`.

**Other models:** check `/v1/models` for reasoning metadata. When the API exposes it, any of these shapes may appear on the chat-completions capability entry or the model entry itself:

```jsonc
"reasoning": { "supported": true, "efforts": ["none", "low", "medium", "high"] }  // canonical
"reasoning": true                                                                // supported, levels unknown
"reasoning_effort_values": ["none", "low", "high"]                               // level array, alt name
"supported_parameters": ["max_tokens", "reasoning_effort", "stream"]             // param allowlist
```

Map them onto your agent's thinking levels (off→`none`, minimal→`minimal`/`low`, others same-named; hide levels the API doesn't advertise). If the API is silent and you choose to offer reasoning anyway: **send nothing when thinking is off** (so unsupported models behave exactly as non-reasoning), and send the same-named effort for on levels — a non-supporting upstream answers with a visible 400, never silent misbehavior.

**Verified data point (2026-09-13 probe):** all DeepSeek (V3.2, V4-pro, V4-flash) and Kimi (K2.6, K2.7-code) models accept `low`/`medium`/`high` and return a `reasoning_content` channel; `xhigh`/`max` are rejected with a 400 on all of them. The gateway does not populate `completion_tokens_details.reasoning_tokens` — detect thinking via the `reasoning_content` message key instead.

## 4. Receipts — exact per-request cost

Every response — including streams and post-admission errors — carries two headers:

```
x-singularity-request-id: req_...
x-singularity-receipt-id: rcpt_...
```

Fetch the receipt for authoritative usage, cost, and latency:

```bash
curl https://api.singularityapi.dev/v1/receipts/rcpt_... \
  -H "Authorization: Bearer $SINGULARITY_API_KEY"
```

```jsonc
{
  "id": "rcpt_...",
  "state": "settled",                     // usage/cost are null until a terminal state
  "served_model": "deepseek-v4-flash",
  "usage": { "input_tokens": 123, "output_tokens": 45, "estimated": false },
  "latency_ms": 812,
  "total_cost_usd": "0.000123456789",
  "request_transformed": true,
  "transformed_fields": ["max_tokens"]    // what the gateway rewrote — useful for debugging 400s
}
```

Receipts resolve only for the owning account (404 otherwise). Poll briefly if `usage`/`total_cost_usd` are still `null`.

## 5. Cost accounting in an agent session

Two complementary mechanisms:

- **Running estimate:** accumulate each response's `usage` priced at the catalog rates from §2 — `(input_tokens / 1_000_000 × input_rate) + (output_tokens / 1_000_000 × output_rate)`. This is what a UI footer should show live.
- **Authoritative:** the receipt's `total_cost_usd` (§4) — settled, gateway-computed, and the number to trust for reporting. It also captures gateway-side adjustments a local estimate can't see.

## 6. Checklist for agent implementers

1. Custom OpenAI provider: base URL `https://api.singularityapi.dev/v1`, Bearer key, chat completions.
2. Conservative params: `max_completion_tokens`; nothing the model didn't advertise (§1).
3. Model list from `GET /v1/models`, filtered to the chat-completions capability, refreshed async over an embedded snapshot (§2).
4. `reasoning_effort` explicit (`"none"` included) for GPT-5.6; metadata-driven elsewhere (§3).
5. Capture `x-singularity-receipt-id` per response; expose a "show receipt" affordance (§4).
6. Running cost from catalog rates; settled cost from receipts (§5).

Questions about the API itself: <https://docs.singularityapi.dev>. For the pi-specific wiring (hot-swap registration, disk cache, thinking-level maps), read [`index.ts`](index.ts) — it is the executable specification of this document.
