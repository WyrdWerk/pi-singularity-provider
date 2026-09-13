<div align="center">

# π pi-singularity-provider

**DeepSeek, Kimi, and GPT models via [SingularityAPI](https://www.singularityapi.dev/)**

_Live catalog metadata — context windows, output limits, exact pricing — plus per-request receipts for [pi](https://github.com/earendil-works/pi-coding-agent)._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## Features

- **Curated catalog** — DeepSeek V4, Kimi K2.6/K2.7, and GPT-5.6 (Sol/Terra/Luna) through one OpenAI-compatible endpoint
- **Live metadata sync** — models, context windows, max output tokens, and exact per-token pricing refreshed from `GET /v1/models` on session start (stale-while-revalidate; zero-latency startup from embedded snapshot + disk cache)
- **Reasoning models** — GPT-5.6 family with `reasoning_effort` thinking levels (always sent explicitly, so tool use works); DeepSeek and Kimi verified at low/medium/high via `patch.json` — see [Thinking Mode](#thinking-mode)
- **Receipts** — every response carries an `x-singularity-receipt-id` header; `/singularity-receipt` shows the exact tokens, cost, and latency for any request

## Installation

`pi install <source>` downloads the package into pi's agent directory, reads the `"pi": {"extensions": ["./index.ts"]}` manifest in its `package.json`, and adds the source to your pi settings — so the extension loads automatically on every start, no `-e` flag needed. Manage it later with `pi update pi-singularity-provider`, `pi remove pi-singularity-provider`, and `pi list`. Add `-l` to any install to record it project-locally (`.pi/settings.json`) instead of user-wide.

### Option 1: npm (recommended)

```bash
pi install npm:pi-singularity-provider
```

### Option 2: GitHub

```bash
pi install https://github.com/wyrdwerk/pi-singularity-provider
```

(`git:github.com/wyrdwerk/pi-singularity-provider` and SSH forms work too.)

### Option 3: Local clone

```bash
git clone https://github.com/wyrdwerk/pi-singularity-provider.git
pi install ./pi-singularity-provider     # persistent, same as above
```

or load it one-off without touching settings:

```bash
pi -e /path/to/pi-singularity-provider
```

### Then set your API key

```bash
# Recommended: add to auth.json (see Authentication below)
# Or set as environment variable
export SINGULARITY_API_KEY=sapi_...

pi
```

Get your API key at [app.singularityapi.dev](https://app.singularityapi.dev) (API keys → Create; the `sapi_...` key is shown once).

## Available Models

| Model | Context | Reasoning | Input | Max Output | Input $/M | Output $/M |
|-------|---------|-----------|-------|------------|-----------|------------|
| DeepSeek V3.2 | 128K | ❌ | Text | 128K | $0.186 | $0.28 |
| DeepSeek V4 Flash | 1M | ❌ | Text | 384K | $0.081 | $0.162 |
| DeepSeek V4 Pro | 1M | ❌ | Text | 384K | $0.392 | $0.783 |
| GPT-5.6 Luna | 272K | ✅ | Text | 128K | $1.00 | $6.00 |
| GPT-5.6 Sol | 272K | ✅ | Text | 128K | $5.00 | $30.00 |
| GPT-5.6 Terra | 272K | ✅ | Text | 128K | $2.50 | $15.00 |
| Kimi K2.6 | 262K | ❌ | Text | 262K | $0.581 | $2.45 |
| Kimi K2.7 Code | 262K | ❌ | Text | 262K | $0.639 | $3.15 |

*Pricing and limits refresh live from [`GET /v1/models`](https://docs.singularityapi.dev/api/models-receipts) on session start (the endpoint is served `cache-control: no-store`, so what you see is always current). Table above mirrors the catalog as of 2026-08-03.*

## Usage

After loading the extension, use the `/model` command in pi to select your preferred model:

```
/model singularity deepseek-v4-flash
```

Or start pi directly with a SingularityAPI model:

```bash
pi --provider singularity --model deepseek-v4-flash
```

### Thinking Mode

The GPT-5.6 models (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`) are reasoning models using the `openai` thinking format (`reasoning_effort`). The extension always sends an explicit `reasoning_effort` for these models — including `"none"` when thinking is off — because SingularityAPI's upstream rejects tool calls that omit it ("Function tools with reasoning_effort are not supported…"). Level mapping: off→none, minimal/low→low, medium→medium, high→high.

All DeepSeek and Kimi models have reasoning **enabled via [`patch.json`](patch.json), verified against the gateway** (2026-09-13 probe): every one of them accepts `reasoning_effort` at **low/medium/high** and returns a `reasoning_content` thinking channel; **xhigh/max are rejected with a 400** on all of them and are therefore hidden from the level cycle, as is minimal (no distinct upstream level). Thinking **off sends no `reasoning_effort` at all**, so requests stay byte-identical to a non-reasoning model. One quirk: `deepseek-v3.2` at `low` accepts the level but may not produce thinking on trivial prompts (medium/high think reliably). To revert everywhere, restore `patch.json` to `{}`; to disable for one model, delete just its entry.

**Reasoning is populated dynamically.** The extension reads reasoning capability straight from `GET /v1/models` whenever the API exposes it — no extension update needed. On the chat-completions capability entry (or the model itself), any of these shapes is recognized:

```jsonc
// canonical
"reasoning": { "supported": true, "efforts": ["none", "low", "medium", "high"] }
// also accepted
"reasoning": true
"reasoning_effort_values": ["none", "low", "medium", "high"]
"supported_parameters": ["max_tokens", "reasoning_effort", "stream"]
```

When the API speaks, it wins over the embedded curation — including an explicit "not supported". Levels map onto pi's thinking levels (off→none, minimal→low, others same-named; unsupported levels are hidden). While the API stays silent for a model, the curated entry stands, and `patch.json` remains the final override either way (see [Patch Overrides](#patch-overrides)).

### Receipts

Every SingularityAPI response — including errors after admission and streams — carries `x-singularity-request-id` and `x-singularity-receipt-id` headers. The extension captures the latest receipt id automatically; to inspect exact tokens, cost, and latency:

```
/singularity-receipt            # last request's receipt
/singularity-receipt rcpt_...   # a specific receipt
```

`usage` and `total_cost_usd` are `null` until the receipt reaches a terminal state (`settled`); if they're pending, wait a moment and run the command again. Receipts only resolve for your own account.

## Authentication

The SingularityAPI key can be configured in multiple ways (resolved in this order):

1. **`auth.json`** (recommended) — Add to `~/.pi/agent/auth.json`:
   ```json
   { "singularity": { "type": "api_key", "key": "sapi_..." } }
   ```
   The `key` field supports literal values, env var names, and shell commands (prefix with `!`). See [pi's auth file docs](https://github.com/badlogic/pi-mono) for details.
2. **Runtime override** — Use the `--api-key` CLI flag
3. **Environment variable** — Set `SINGULARITY_API_KEY`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SINGULARITY_API_KEY` | No | Your SingularityAPI key (`sapi_...`; fallback if not in auth.json) |

## Configuration

Add to your pi configuration for automatic loading:

```json
{
  "extensions": [
    "/path/to/pi-singularity-provider"
  ]
}
```

### Compat Settings

SingularityAPI speaks the OpenAI chat completions wire format, with one behavioral difference that shapes the compat config: **unsupported or reserved parameters are rejected with a 400, never silently dropped**.

- **`maxTokensField: "max_completion_tokens"`** — `max_tokens` and `max_completion_tokens` are interchangeable on every chat model (sending both is a 400)
- **`supportsDeveloperRole: false`** — all models use the `system` role, not `developer`
- **`supportsStore: false`** — the `store` parameter is not supported

### Patch Overrides

The `patch.json` file contains overrides that are applied on top of `models.json` data at runtime. This is useful for:

- Marking a model as reasoning-capable when the API doesn't advertise it
- Adding compat settings the API doesn't provide
- Overriding pricing/context windows before the next sync

## Updating Models

Run the update script to fetch the latest catalog from SingularityAPI:

```bash
export SINGULARITY_API_KEY=sapi_...
node scripts/update-models.js
```

This will:

1. Fetch models from `https://api.singularityapi.dev/v1/models`
2. Refresh pricing, context windows, and max output tokens from the live capabilities data
3. Preserve curated metadata (reasoning, names, compat) for known models
4. Move delisted models to `deprecated-models.json` (14-day grace period)
5. Update `models.json` and the README model table

Note: the runtime already revalidates live on every session start, so this script is for refreshing the committed snapshot — not required for day-to-day freshness.

## Using SingularityAPI with Other Agents and Tools

This extension is pi-specific, but SingularityAPI is not: any coding agent that can point at a custom OpenAI-compatible endpoint can use it with just the base URL and an API key. [INTEGRATING.md](INTEGRATING.md) is the complete, agent-agnostic integration guide — the `/v1/models` metadata format, request-parameter policy, reasoning levels, receipts, and cost accounting — so other agents (or their humans) can replicate everything this extension does for pi.

## License

MIT
