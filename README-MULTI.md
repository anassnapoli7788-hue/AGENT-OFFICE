# Multi-provider mode — run the office on NVIDIA, Ollama, OpenAI, and friends

The office normally runs on your Claude Code login. This mode (`npm run multi`) runs it instead on
**your own mix of API providers** — one provider per model slot, mixed however you like.

The office has exactly three model slots: **Sonnet**, **Opus**, **Fable**. In multi-provider mode each
slot is a wire to a different provider:

| Slot (what the UI calls it) | Provider (example) | Upstream model |
|---|---|---|
| Sonnet | Ollama (until you paste a key) | `qwen2.5:3b` |
| Opus | OpenAI | `gpt-4o` |
| Fable | Ollama (your machine) | `qwen2.5:3b` |

The office thinks it is talking to Claude; a small local proxy (`multi-proxy.mjs`) translates every
call to whichever provider the slot points at. Every feature that runs a model — tasks, routing,
chat, teams, routines, the set-up interview, learning from `revise:` — goes through it.

## Start

```bash
npm run multi        # starts the proxy (port 4530) + the office (port 4520)
```

Open http://localhost:4520. Every run is logged in the terminal with the slot, provider and tokens:

```
[proxy] fable -> ollama/qwen3.8:27b · 2412 in · 380 out · 18.4s
```

## Where the keys go

`providers.config.json` (this folder, git-ignored — your secrets never leave the machine):

```json
{
  "port": 4530,
  "timeoutMs": 300000,
  "providers": {
    "nvidia": { "type": "openai", "label": "NVIDIA NIM", "baseURL": "https://integrate.api.nvidia.com/v1", "apiKey": "PASTE_nvapi-KEY_HERE" },
    "openai": { "type": "openai", "label": "OpenAI",   "baseURL": "https://api.openai.com/v1",            "apiKey": "PASTE_sk-KEY_HERE" },
    "ollama": { "type": "openai", "label": "Ollama",   "baseURL": "http://127.0.0.1:11434/v1",            "apiKey": "ollama" }
  },
  "routes": {
    "sonnet": { "provider": "nvidia", "model": "meta/llama-3.3-70b-instruct" },
    "opus":   { "provider": "openai", "model": "gpt-4o" },
    "fable":  { "provider": "ollama", "model": "qwen3.8:27b" }
  }
}
```

- **Where to get keys**: NVIDIA — https://build.nvidia.com (sign in → Get API Key, starts `nvapi-`).
  OpenAI — https://platform.openai.com/api-keys (starts `sk-`). Ollama needs no key.
- Edits apply on the next call — no restart needed.
- `routes` says which provider and upstream model each slot runs. `"model"` must be a name the
  provider knows (`ollama list` for Ollama; the model id on build.nvidia.com; `gpt-4o`, `o4-mini`… for OpenAI).
- Add as many providers as you like (Groq, DeepSeek, OpenRouter, Gemini-compatible, LM Studio,
  llama.cpp — anything OpenAI-compatible), then point any slot at any of them.
- A slot can also point at a real Anthropic key: `"type": "anthropic"` passes the request through
  untranslated (`"baseURL": "https://api.anthropic.com"`).
- Optional `"params"` per route are merged into the upstream request, e.g.
  `"params": { "temperature": 0.7 }`.
- Reasoning `<think>`-style blocks are stripped from deliverables automatically.

## Choosing who runs on what

Same precedence as always — the task beats the routine beats the agent beats the office:

- **Per task**: the model menu in the bar (Sonnet = slot 1, Opus = slot 2, Fable = slot 3).
- **Per agent**: a `"model"` field in `office.agents.local.json`, e.g. the whole Finance team on NVIDIA:
  `{ "agents": [ { "id": "alead", "model": "sonnet" }, { "id": "invo", "model": "sonnet" } ] }`
- **Office default**: `"model"` in `office.config.json` (shipped as `"fable"` = your local Ollama,
  so the office works out of the box before any keys are pasted; switch to `"sonnet"` once your
  NVIDIA key is in).

## What does not work in this mode

These are Claude-Code-login features; on API providers they are off in the office itself:

- **Connectors** (Gmail, Slack, Notion, …) — the agents work from your Brain notes only.
- **Claude in Chrome** and **web search** — no browsing.
- **The Claude usage gauge** — the top bar shows the office's own token count instead.
- **The effort menu** — inert on the API backend (the office only applies effort via the Claude CLI).

## Files added by this mode

| File | What |
|---|---|
| `multi-proxy.mjs` | The translation proxy (Anthropic in → OpenAI-compatible out) |
| `multi.mjs` | `npm run multi` — proxy + office in one command |
| `providers.config.json` | Your keys, models and routes (git-ignored) |
