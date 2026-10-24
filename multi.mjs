#!/usr/bin/env node
// multi.mjs — start the office on your own mix of model providers.
//
//   npm run multi
//
// What it does:
//   1. points the Anthropic SDK (the office's API backend) at the local translation proxy,
//   2. starts the proxy (multi-proxy.mjs, port 4530 by default),
//   3. starts the office (serve.mjs, port 4520 by default).
//
// The office's three model slots are then whatever providers.config.json says:
//   Sonnet -> one provider (e.g. NVIDIA), Opus -> another (e.g. OpenAI), Fable -> another (e.g. Ollama).
// Keys, models and routes live in providers.config.json (git-ignored). See README-MULTI.md.

process.env.ANTHROPIC_BASE_URL ||= 'http://127.0.0.1:4530';
process.env.ANTHROPIC_API_KEY ||= 'multi-provider-proxy'; // any non-empty value; the proxy ignores it

await import('./multi-proxy.mjs');
await import('./serve.mjs');
