// multi-proxy.mjs — Agents Office multi-provider proxy.
//
// The office's API backend speaks the Anthropic Messages format (serve.mjs -> @anthropic-ai/sdk).
// This little server speaks that same format on the front and translates every call to an
// OpenAI-compatible /chat/completions endpoint on the back — NVIDIA NIM, Ollama, OpenAI, Groq,
// DeepSeek, OpenRouter, LM Studio, llama.cpp, anything OpenAI-compatible — or passes through to
// a real Anthropic-format endpoint.
//
// Routing: the office has three model slots (Sonnet / Opus / Fable). Each slot is mapped, in
// providers.config.json, to one provider + upstream model. Pick a slot per task in the bar,
// per agent in the roster ("model": "opus"), or per office in office.config.json.
//
// Start it with: npm run multi   (multi.mjs starts this proxy, then the office pointed at it).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, 'providers.config.json');

const readCfg = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { throw new Error('providers.config.json is missing or not valid JSON: ' + e.message); } };
const local = url => /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(String(url));

/** The office's model id -> its slot key (mirrors src/models.js normModel). */
function slotOf(id) {
  const t = String(id || '').toLowerCase();
  if (t.includes('sonnet')) return 'sonnet';
  if (t.includes('opus')) return 'opus';
  if (t.includes('fable')) return 'fable';
  return null;
}

/** Anthropic content (string | [{type:'text',text}]) -> plain string. */
const flat = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
  : String(c ?? '');

/** Anthropic body -> OpenAI messages (system first, then the turns). */
function toOpenAIMessages(body) {
  const msgs = [];
  const sys = flat(body.system ?? '');
  if (sys.trim()) msgs.push({ role: 'system', content: sys });
  for (const m of body.messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = flat(m.content);
    if (content.trim() || role === 'user') msgs.push({ role, content: content || ' ' });
  }
  if (!msgs.length) msgs.push({ role: 'user', content: ' ' });
  return msgs;
}

// Reasoning models sometimes leak their thinking block into the content; deliverables must not
// carry it. Built from parts so nothing in this file ever contains a raw angle-bracket tag.
const THINK_OPEN = '<' + 'think' + '>';
const THINK_CLOSE = '</' + 'think' + '>';
function stripThinking(text) {
  let t = String(text ?? '');
  for (;;) {
    const open = t.indexOf(THINK_OPEN);
    if (open < 0) break;
    const close = t.indexOf(THINK_CLOSE, open);
    t = close >= 0 ? t.slice(0, open) + t.slice(close + THINK_CLOSE.length) : t.slice(0, open);
  }
  return t.trim();
}

/** OpenAI finish_reason -> Anthropic stop_reason (the office reads 'refusal'). */
const STOP = { stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal', tool_calls: 'tool_use', function_call: 'tool_use' };

function toAnthropic(openai, wantedModel) {
  const ch = (openai.choices || [])[0] || {};
  const m = ch.message || {};
  let text = typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.map(p => (typeof p === 'string' ? p : p.text) || '').join('\n')
    : '';
  text = stripThinking(text);
  const u = openai.usage || {};
  return {
    id: 'msg_multi_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: 'message', role: 'assistant',
    model: openai.model || wantedModel,
    content: [{ type: 'text', text }],
    stop_reason: STOP[ch.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
  };
}

const errType = st => st === 400 ? 'invalid_request_error' : st === 401 || st === 403 ? 'authentication_error' : st === 404 ? 'not_found_error' : st === 429 ? 'rate_limit_error' : 'api_error';

async function callUpstream(prov, route, body, cfg) {
  if (prov.type === 'anthropic') { // pass the Anthropic shape straight through (a real Claude key as one of the slots)
    const url = prov.baseURL.replace(/\/+$/, '') + '/v1/messages';
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': prov.apiKey, 'anthropic-version': '2023-06-01', ...(prov.headers || {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutMs || 300000) });
    if (!r.ok) { const t = await r.text(); const e = new Error(`${prov.label || 'provider'} answered ${r.status}: ${t.slice(0, 400)}`); e.status = r.status; throw e; }
    return await r.json();
  }
  // OpenAI-compatible
  if (!prov.apiKey && !local(prov.baseURL)) { const e = new Error(`no API key set for provider "${route.provider}" — open providers.config.json and paste your key (see README-MULTI.md)`); e.status = 401; throw e; }
  const base = prov.baseURL.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const payload = { model: route.model, messages: toOpenAIMessages(body), max_tokens: body.max_tokens || 4000, ...(route.params || {}) };
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(prov.apiKey ? { authorization: 'Bearer ' + prov.apiKey } : {}), ...(prov.headers || {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(cfg.timeoutMs || 300000) });
    if (r.ok) return await r.json();
    const raw = await r.text();
    let msg = raw; try { const j = JSON.parse(raw); msg = j.error?.message || j.message || j.detail || raw; } catch {}
    const low = String(msg).toLowerCase();
    // one retry per unsupported parameter (OpenAI o-series: max_completion_tokens, no temperature…)
    if (attempt < 2 && low.includes('max_completion_tokens') && 'max_tokens' in payload) { payload.max_completion_tokens = payload.max_tokens; delete payload.max_tokens; continue; }
    if (attempt < 2 && (low.includes('temperature') || low.includes('top_p')) && payload.temperature !== undefined) { delete payload.temperature; continue; }
    const e = new Error(`${prov.label || route.provider} answered ${r.status}: ${String(msg).slice(0, 400)}`); e.status = r.status; throw e;
  }
}

const server = http.createServer(async (req, res) => {
  const send = (st, obj) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const sendErr = (st, message) => send(st, { type: 'error', error: { type: errType(st), message } });
  let cfg; try { cfg = readCfg(); } catch (e) { return sendErr(500, e.message); }
  if (req.method === 'GET' && req.url === '/health') { // a debugging glance, keys never included
    const providers = Object.fromEntries(Object.entries(cfg.providers || {}).map(([k, p]) => [k, { type: p.type || 'openai', baseURL: p.baseURL, hasKey: !!p.apiKey || local(p.baseURL) }]));
    return send(200, { ok: true, routes: cfg.routes || {}, providers });
  }
  if (req.method === 'POST' && (req.url === '/v1/messages' || req.url === '/v1/messages?beta=true')) {
    const chunks = []; let size = 0;
    req.on('data', d => { size += d.length; if (size > 20e6) req.destroy(); else chunks.push(d); });
    req.on('end', async () => {
      const t0 = Date.now();
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return sendErr(400, 'the request body is not valid JSON'); }
      const slot = slotOf(body.model);
      const route = slot && (cfg.routes || {})[slot];
      if (!route) return sendErr(400, `no route for model "${body.model}" — map sonnet/opus/fable in providers.config.json`);
      const prov = (cfg.providers || {})[route.provider];
      if (!prov) return sendErr(500, `route "${slot}" points at provider "${route.provider}", which is not defined in providers.config.json`);
      try {
        const out = await callUpstream(prov, route, body, cfg);
        const ans = prov.type === 'anthropic' ? out : toAnthropic(out, body.model);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[proxy] ${slot} -> ${route.provider}/${route.model} · ${ans.usage?.input_tokens || 0} in · ${ans.usage?.output_tokens || 0} out · ${secs}s`);
        return send(200, ans);
      } catch (e) {
        const msg = e.name === 'TimeoutError' ? `${prov.label || route.provider} timed out after ${(cfg.timeoutMs || 300000) / 1000 | 0}s — a bigger/faster model or a longer timeoutMs may help`
          : e.cause?.code === 'ECONNREFUSED' ? `${prov.label || route.provider} is not reachable at ${prov.baseURL} — is the service running?`
          : e.message;
        console.warn(`[proxy] ERROR ${slot} -> ${route.provider}/${route.model}: ${msg}`);
        return sendErr(e.status && e.status < 500 ? e.status : 502, msg);
      }
    });
    return;
  }
  return sendErr(404, `the proxy only speaks POST /v1/messages (got ${req.method} ${req.url})`);
});

const PORT = readCfg().port || 4530;
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const cfg0 = readCfg();
console.log(`multi-provider proxy -> http://127.0.0.1:${PORT} · the office's three slots:`);
for (const k of ['sonnet', 'opus', 'fable']) {
  const rt = (cfg0.routes || {})[k] || {};
  const p = (cfg0.providers || {})[rt.provider] || {};
  const key = p.apiKey ? 'key set' : local(p.baseURL || '') ? 'no key needed (local)' : 'NO KEY SET';
  console.log(`  ${k.padEnd(6)} -> ${rt.provider || '?'}/${rt.model || '?'}  (${key})`);
}
