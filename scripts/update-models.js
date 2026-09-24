#!/usr/bin/env node
/**
 * Update SingularityAPI models from the API
 *
 * Fetches models from https://api.singularityapi.dev/v1/models, then updates:
 * - models.json: Provider model definitions (live limits + pricing, curated metadata)
 * - README.md: Model table in the Available Models section
 *
 * GET /v1/models returns every catalog model with a `capabilities` array (one
 * entry per served endpoint) carrying context_window_tokens,
 * maximum_output_tokens, default_output_tokens, and pricing as 12-decimal
 * per-million-token strings. Live data is authoritative for
 * cost/contextWindow/maxTokens; reasoning flags, display names, and compat
 * settings are curated here (preserved from the existing models.json).
 *
 * patch.json and custom-models.json are applied at runtime by the provider.
 * They are NOT baked into models.json, but ARE used to generate the README table.
 *
 * API key: the stored `singularity` credential in ~/.pi/agent/auth.json wins,
 * then the SINGULARITY_API_KEY environment variable. The script refuses to run
 * without one.
 */

import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// pi's agent directory: PI_CODING_AGENT_DIR (with ~ expansion) or ~/.pi/agent.
function piAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    return envDir.startsWith('~/') || envDir === '~'
      ? path.join(os.homedir(), envDir.slice(1))
      : envDir;
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

const AUTH_JSON_PATH = path.join(piAgentDir(), 'auth.json');

/**
 * Resolve a configured value using pi's semantics (resolve-config-value.ts in
 * pi-mono): "!command" runs via the shell (10s timeout) and uses trimmed
 * stdout; "$VAR" / "${VAR}" interpolate environment variables ("$$" escapes a
 * literal "$", "$!" a literal "!"); anything else is a literal. Returns
 * undefined when a referenced env var is unset or a command fails.
 */
function resolveConfigValue(config, env) {
  if (typeof config !== 'string' || config.length === 0) return undefined;
  if (config.startsWith('!')) {
    try {
      const out = execSync(config.slice(1), {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  let resolved = '';
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf('$', index);
    if (dollar < 0) {
      resolved += config.slice(index);
      break;
    }
    resolved += config.slice(index, dollar);
    const next = config[dollar + 1];
    let name;
    if (next === '$' || next === '!') {
      resolved += next;
      index = dollar + 2;
      continue;
    } else if (next === '{') {
      const end = config.indexOf('}', dollar + 2);
      if (end < 0) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      const inner = config.slice(dollar + 2, end);
      if (!ENV_NAME_RE.test(inner)) {
        resolved += config.slice(dollar, end + 1);
        index = end + 1;
        continue;
      }
      name = inner;
      index = end + 1;
    } else {
      const match = config.slice(dollar + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!match) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      name = match[0];
      index = dollar + 1 + name.length;
    }
    const value = (env && env[name]) || process.env[name] || undefined;
    if (value === undefined) return undefined;
    resolved += value;
  }
  return resolved;
}

/**
 * The API key, resolved the way pi itself resolves it for this provider: the
 * stored `singularity` credential in ~/.pi/agent/auth.json wins, then the
 * SINGULARITY_API_KEY environment variable.
 */
function resolveApiKey() {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_JSON_PATH, 'utf8'));
    const credential = auth?.singularity;
    if (credential && credential.type === 'api_key' && typeof credential.key === 'string') {
      const key = resolveConfigValue(credential.key, credential.env);
      if (key) return key;
    }
  } catch {
    // Missing or unparseable auth.json: fall through to the env var.
  }
  return process.env.SINGULARITY_API_KEY || undefined;
}

const MODELS_API_URL = 'https://api.singularityapi.dev/v1/models';
const MODELS_JSON_PATH = path.join(__dirname, '..', 'models.json');
const PATCH_JSON_PATH = path.join(__dirname, '..', 'patch.json');
const CUSTOM_MODELS_JSON_PATH = path.join(__dirname, '..', 'custom-models.json');
const README_PATH = path.join(__dirname, '..', 'README.md');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ Saved ${path.basename(filePath)}`);
}

// ─── API fetch ───────────────────────────────────────────────────────────────

async function fetchModels() {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error('No API key found: no `singularity` credential resolved from ' + AUTH_JSON_PATH + ' and SINGULARITY_API_KEY is not set');
  }

  console.log(`Fetching models from ${MODELS_API_URL}...`);
  const response = await fetch(MODELS_API_URL, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const models = Array.isArray(payload) ? payload : (payload.data || []);
  console.log(`✓ Fetched ${models.length} models from API`);
  return models;
}

// ─── Transform API model → models.json entry ────────────────────────────────

/**
 * Pick the capability entry pi uses. Exact /v1/chat/completions match only:
 * image-generation or responses-only models must not be registered as chat
 * models (they would fail when selected).
 */
function chatCapability(apiModel) {
  const caps = Array.isArray(apiModel.capabilities) ? apiModel.capabilities : [];
  return caps.find((c) => c && c.endpoint === '/v1/chat/completions') || null;
}

function parsePrice(value) {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

// ─── Live reasoning detection (mirrors index.ts) ────────────────────────────
//
// Recognized shapes on the chat-completions capability (then the model entry):
//   "reasoning": { "supported": true, "efforts": ["none","low","medium","high"] }
//   "reasoning": true | false
//   "reasoning_effort_values" | "reasoning_levels" | "thinking_levels": [...]
//   "supported_parameters": [..., "reasoning_effort", ...]  (absence = unsupported)
// When the API speaks, it wins over preserved curation; while silent, curation
// stands. patch.json remains the final override at runtime.

function pickEfforts(src) {
  const raw = src?.efforts ?? src?.reasoning_effort_values ?? src?.reasoning_levels ?? src?.thinking_levels;
  if (!Array.isArray(raw)) return undefined;
  const values = raw.filter((v) => typeof v === 'string' && v.length > 0);
  return values.length > 0 ? values : undefined;
}

function extractLiveReasoning(apiModel, cap) {
  // The supported decision comes from the first source (capability, then
  // model) carrying any explicit signal — but effort values are gathered from
  // BOTH sources, so a bare boolean on the capability still picks up a level
  // array sitting on the model entry.
  let supported;
  let efforts;

  for (const src of [cap, apiModel]) {
    if (!src || typeof src !== 'object') continue;

    if (efforts === undefined) efforts = pickEfforts(src);
    if (supported !== undefined) continue; // decision made; only gathering efforts

    const r = src.reasoning ?? src.supports_reasoning;
    if (r !== undefined && r !== null && typeof r === 'object' && !Array.isArray(r)) {
      if (typeof r.supported === 'boolean') {
        supported = r.supported;
        // Efforts declared inside the reasoning object outrank source-level arrays.
        const inner = pickEfforts(r);
        if (inner) efforts = inner;
      }
    } else if (typeof r === 'boolean') {
      supported = r;
    } else if (pickEfforts(src)) {
      supported = true; // a level list with no explicit flag implies supported
    } else {
      const params = src.supported_parameters ?? src.supportedParameters;
      if (Array.isArray(params)) {
        supported = params.some((p) => p === 'reasoning_effort' || p === 'reasoning');
      }
    }
  }

  return supported === undefined ? undefined : { supported, efforts };
}

// SingularityAPI's documented reasoning_effort values.
const DEFAULT_EFFORTS = ['none', 'low', 'medium', 'high'];

function thinkingLevelMapFromEfforts(efforts) {
  const supported = new Set((efforts && efforts.length > 0 ? efforts : DEFAULT_EFFORTS).map((e) => e.toLowerCase()));
  const pick = (...candidates) => {
    for (const c of candidates) if (supported.has(c)) return c;
    return null;
  };
  const map = {
    off: pick('none', 'off'),
    minimal: pick('minimal', 'low'),
    low: pick('low'),
    medium: pick('medium'),
    high: pick('high'),
    xhigh: pick('xhigh'),
    max: pick('max'),
  };
  return Object.values(map).some((v) => v !== null) ? map : undefined;
}

/** Apply live reasoning info to a models.json entry (API wins when it speaks). */
function applyLiveReasoning(entry, live) {
  if (!live) return entry;
  entry.reasoning = live.supported;
  entry.compat = { ...(entry.compat || {}) };
  if (live.supported) {
    const map = thinkingLevelMapFromEfforts(live.efforts);
    if (map) entry.thinkingLevelMap = map;
    // reasoning_effort is the only thinking control SingularityAPI documents.
    entry.compat.thinkingFormat = 'openai';
    entry.compat.supportsReasoningEffort = true;
  } else {
    delete entry.thinkingLevelMap;
    delete entry.compat.thinkingFormat;
    delete entry.compat.supportsReasoningEffort;
    if (Object.keys(entry.compat).length === 0) delete entry.compat;
  }
  return entry;
}

function transformApiModel(apiModel, existingModelsMap) {
  const id = apiModel && apiModel.id;
  if (!id || typeof id !== 'string') return null;

  const cap = chatCapability(apiModel);
  if (!cap) return null;

  const liveCost = {
    input: parsePrice(cap.pricing?.input_per_million_usd),
    output: parsePrice(cap.pricing?.output_per_million_usd),
    cacheRead: parsePrice(cap.pricing?.cached_input_per_million_usd),
    cacheWrite: 0,
  };
  const liveContext = cap.context_window_tokens || 0;
  const liveMaxOutput = cap.maximum_output_tokens || 0;

  // Known model: preserve curated data (reasoning, name, input, compat,
  // thinkingLevelMap) and refresh the fields the API is authoritative for.
  // Reasoning: when the API advertises it, the API wins over the preserved
  // curation; while the API stays silent, curation stands.
  if (existingModelsMap[id]) {
    const existing = { ...existingModelsMap[id] };
    existing.cost = {
      input: liveCost.input || existing.cost.input,
      output: liveCost.output || existing.cost.output,
      cacheRead: liveCost.cacheRead || (existing.cost.cacheRead ?? 0),
      cacheWrite: existing.cost.cacheWrite ?? 0,
    };
    if (liveContext) existing.contextWindow = liveContext;
    if (liveMaxOutput) existing.maxTokens = liveMaxOutput;
    return applyLiveReasoning(existing, extractLiveReasoning(apiModel, cap));
  }

  // New model — live limits/pricing + conservative defaults. Reasoning comes
  // from the API when advertised; curate in patch.json otherwise (never edit
  // models.json).
  const fresh = {
    id,
    name: generateDisplayName(id),
    reasoning: false,
    input: ['text'],
    cost: liveCost,
    contextWindow: liveContext || 131_072,
    maxTokens: liveMaxOutput || 8_192,
    compat: {
      maxTokensField: 'max_completion_tokens',
      supportsDeveloperRole: false,
      supportsStore: false,
    },
  };
  return applyLiveReasoning(fresh, extractLiveReasoning(apiModel, cap));
}

function generateDisplayName(id) {
  return id
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Patch & Custom Models ──────────────────────────────────────────────────

function applyPatch(model, patch) {
  const result = { ...model };
  if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = { ...patch.thinkingLevelMap };
  if (patch.name !== undefined) result.name = patch.name;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
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

function buildModels(baseModels, customModels, patchData) {
  const modelMap = new Map();
  for (const model of baseModels) {
    modelMap.set(model.id, model);
  }
  for (const [id, patchEntry] of Object.entries(patchData)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }
  for (const model of customModels) {
    const existing = modelMap.get(model.id);
    const patchEntry = patchData[model.id];
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

// ─── README generation ──────────────────────────────────────────────────────

function formatContext(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return n.toString();
}

function formatCost(cost) {
  if (cost === 0 || cost === null || cost === undefined) return '—';
  // SingularityAPI prices carry up to 3 significant decimals ($0.081, $0.392).
  return '$' + cost.toFixed(3).replace(/(\.\d\d)0$/, '$1');
}

function generateReadmeTable(models) {
  const lines = [
    '| Model | Context | Reasoning | Input | Max Output | Input $/M | Cached $/M | Output $/M |',
    '|-------|---------|-----------|-------|------------|-----------|------------|-------------|',
  ];

  for (const model of models) {
    const context = formatContext(model.contextWindow);
    const reasoning = model.reasoning ? '✅' : '❌';
    const input = model.input.includes('image') ? 'Text + Image' : 'Text';
    const maxOutput = formatContext(model.maxTokens);
    const inputCost = formatCost(model.cost.input);
    const cachedCost = formatCost(model.cost.cacheRead);
    const outputCost = formatCost(model.cost.output);

    lines.push(`| ${model.name} | ${context} | ${reasoning} | ${input} | ${maxOutput} | ${inputCost} | ${cachedCost} | ${outputCost} |`);
  }

  return lines.join('\n');
}

function updateReadme(models) {
  let readme = fs.readFileSync(README_PATH, 'utf8');
  const newTable = generateReadmeTable(models);

  const tableRegex = /(## Available Models\n\n)\| Model \| Context \| Reasoning[^\n]+\|\n\|[-| ]+\|(\n\|[^\n]+\|)*\n*/;

  if (tableRegex.test(readme)) {
    readme = readme.replace(tableRegex, (match, header) => `${header}${newTable}\n\n`);
  } else {
    console.warn('⚠ Could not find model table in "## Available Models" section');
  }

  const countRegex = /(- \*\*Curated catalog\*\* — )\d+( chat models )/;
  if (countRegex.test(readme)) {
    readme = readme.replace(countRegex, `$1${models.length}$2`);
  } else {
    console.warn('⚠ Could not find curated catalog count in README features');
  }

  fs.writeFileSync(README_PATH, readme);
  console.log(`✓ Updated README.md (${models.length} models)`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

// Grace period for delisted models: update-models.js moves models the API no
// longer lists into deprecated-models.json (stamped with deprecatedAt) instead
// of dropping them; the runtime appends them back so sessions and saved model
// settings keep working, and after 14 days they are evicted permanently.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Reconcile deprecated-models.json against the freshly fetched model list.
 * - in old models.json but not the API: moved into the deprecated file
 *   (deprecatedAt = now; preserved on repeat runs so the grace clock is not reset)
 * - back in the API: resurrected (dropped from the deprecated file)
 * - deprecatedAt older than 14 days: evicted permanently
 * Must run BEFORE the new models.json is written; it reads the old file itself.
 */
function updateDeprecatedModels(modelsJsonPath, newModels) {
  const deprecatedPath = path.join(path.dirname(modelsJsonPath), 'deprecated-models.json');

  let oldModels = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'));
    if (Array.isArray(parsed)) oldModels = parsed;
  } catch { /* first run: no previous models.json */ }

  let deprecated = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(deprecatedPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deprecated = parsed;
  } catch { /* no graveyard yet */ }

  const currentIds = new Set(newModels.map((m) => m.id));
  const now = new Date().toISOString();
  const added = [];
  const resurrected = [];
  const evicted = [];

  for (const old of oldModels) {
    if (old && old.id && !currentIds.has(old.id) && !deprecated[old.id]) {
      deprecated[old.id] = { ...old, deprecatedAt: now };
      added.push(old.id);
    }
  }

  for (const [id, entry] of Object.entries(deprecated)) {
    if (currentIds.has(id)) {
      delete deprecated[id];
      resurrected.push(id);
      continue;
    }
    const removedAt = Date.parse(entry && entry.deprecatedAt ? entry.deprecatedAt : '');
    if (Number.isNaN(removedAt) || Date.now() - removedAt > DEPRECATED_MODEL_TTL_MS) {
      delete deprecated[id];
      evicted.push(id);
    }
  }

  if (added.length > 0 || resurrected.length > 0 || evicted.length > 0) {
    fs.writeFileSync(deprecatedPath, JSON.stringify(deprecated, null, 2) + '\n');
    console.log('Updated deprecated-models.json ' + JSON.stringify({ added, resurrected, evicted }));
  }
}

/**
 * Grace-period deprecated models (deprecatedAt within TTL) with metadata stripped.
 * Keeps the README table serving models that are delisted but still within their
 * 14-day grace window.
 */
function withDeprecatedForReadme(models) {
  const deprecatedPath = path.join(path.dirname(MODELS_JSON_PATH), 'deprecated-models.json');
  let deprecated = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(deprecatedPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deprecated = parsed;
  } catch { /* no graveyard yet */ }
  const now = Date.now();
  const seen = new Set(models.map((m) => m.id));
  const extras = [];
  for (const entry of Object.values(deprecated)) {
    if (!entry || !entry.id || seen.has(entry.id)) continue;
    const removedAt = Date.parse(entry.deprecatedAt || '');
    if (Number.isNaN(removedAt) || now - removedAt > DEPRECATED_MODEL_TTL_MS) continue;
    const m = { ...entry };
    delete m.deprecatedAt;
    extras.push(m);
  }
  return extras.length > 0 ? [...models, ...extras] : models;
}

async function main() {
  try {
    const apiModels = await fetchModels();

    // Load existing models.json for curation preservation
    const existingModels = loadJson(MODELS_JSON_PATH);
    const existingModelsMap = {};
    for (const m of (Array.isArray(existingModels) ? existingModels : [])) {
      existingModelsMap[m.id] = m;
    }

    // Transform API models, preserving existing curated data where available
    let models = apiModels
      .map((m) => transformApiModel(m, existingModelsMap))
      .filter((m) => m !== null);

    // Live API is authoritative — models absent from API are removed
    // (moved to deprecated-models.json below for the grace period)

    // Sort: reasoning models first, then by context window (descending), then name
    models.sort((a, b) => {
      if (a.reasoning !== b.reasoning) return b.reasoning - a.reasoning;
      if (b.contextWindow !== a.contextWindow) return b.contextWindow - a.contextWindow;
      return a.name.localeCompare(b.name);
    });

    // Save models.json (pure API output + preserved curation, no patch/custom baked in)
    // Move delisted models to deprecated-models.json BEFORE models.json is overwritten
    updateDeprecatedModels(MODELS_JSON_PATH, models);
    saveJson(MODELS_JSON_PATH, models);

    // Build full model list for README: base → patch → custom (+ grace-period deprecated)
    const patchData = loadJson(PATCH_JSON_PATH);
    const customModels = loadJson(CUSTOM_MODELS_JSON_PATH);
    const readmeModels = withDeprecatedForReadme(
      buildModels(models, Array.isArray(customModels) ? customModels : [], patchData),
    );
    readmeModels.sort((a, b) => a.name.localeCompare(b.name));

    // Update README
    updateReadme(readmeModels);

    // Summary
    const newIds = new Set(models.map((m) => m.id));
    const oldIds = new Set(Object.keys(existingModelsMap));
    const added = [...newIds].filter((id) => !oldIds.has(id));
    const removed = [...oldIds].filter((id) => !newIds.has(id));

    console.log('\n--- Summary ---');
    console.log(`Total models: ${models.length}`);
    console.log(`Reasoning models: ${models.filter((m) => m.reasoning).length}`);
    console.log(`Vision models: ${models.filter((m) => m.input.includes('image')).length}`);
    if (added.length > 0) console.log(`New models: ${added.join(', ')}`);
    if (removed.length > 0) console.log(`Removed models: ${removed.join(', ')}`);

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
