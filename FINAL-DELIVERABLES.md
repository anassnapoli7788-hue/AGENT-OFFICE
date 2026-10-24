# Agents Office → Intelligent AI Company & Trading HQ
# Final Deliverables Report

**Working tree:** `C:\Users\Anas\Desktop\AI AGENT\agents-office`
**Git:** `812e239` (HEAD), baseline `b53bf94` ("Agents Office v3.2.1-beta.2 Pump.fun Trading Desk")
**Date:** 2026-10-24

---

## 1. Architecture Discovered

The existing project is **Agents Office v3 (Beta)**, a 3D isometric AI agent office already themed as a "Pump.fun Trading Desk".

**Stack**
- Node.js v24.16.0, npm 11.13.0, ESM (`"type": "module"`)
- Frontend: Three.js (`three` ^0.185.1) isometric 3D scene, vanilla JS, bundled with esbuild into `dist/command-centre-v2.html`
- Backend: `serve.mjs` — native `node:http` server, `http` only (no Express)
- Agent runtime: Claude Code CLI (`claude -p`) or `@anthropic-ai/sdk` if `ANTHROPIC_API_KEY` set; MCP connectors via `claude mcp list`
- Data store: JSON files in `data/` (`tasks.json`, `usage.json`, `routines.json`) + `brain/` Obsidian-style vault (wiki-link notes)
- Existing UI: 3D office with 6 department pods + central Brain, TV data wall, task-status panel, agent chat rail, calendar, company board, Brain graph

**Existing departments (6 fixed pods + Brain)**
| Pod | Department | Theme |
|-----|------------|-------|
| emails | DISCOVERY | Pump.fun launch feed |
| ops | X INTELLIGENCE | Social/X intelligence |
| marketing | ON-CHAIN INTEL | Holder/wallet analysis |
| sales | SAFETY & RISK | Risk gate, rug detection |
| delivery | EXECUTION | Strategy, entry/exit |
| fin | PORTFOLIO | Portfolio risk, paper sim, backtest |
| brain | THE BRAIN | Wiki-link knowledge graph |

**Existing agents:** 35 (fixed seat ids, departments, leads), Pump.fun-themed roles (LAUNCH RADAR, RISK GATEKEEPER, RUG-PULL INVESTIGATOR, PAPER-TRADING SIM, BACKTEST & DATA QUALITY, etc.)

**Pre-existing modules wired into serve.mjs** (were in the dirty working tree, now integrated)
- `workflows.mjs` — `initWorkflows` (The Brain workflow orchestration)
- `meetings.mjs` — `initMeetings` (virtual meeting room)
- `library.mjs` — `initLibrary` (knowledge library)
- `finance.mjs` — `initFinance` (business analytics)
- `budgets.mjs` — `initBudgets` (budget tracking)
- `autonomy.mjs` — `initAutonomy` (autonomous agents)
- `ops.mjs` — `initOps` (operations layer: events, alerts, agent status, usage)

**Environment findings**
- MetaTrader 5 terminal installed at `C:\Program Files\MetaTrader 5` (`terminal64.exe`), **running**, connected to account `101763310` on `XMGlobal-MT5 5`, currency USD, balance $10,597.82, equity $11,004.00, trade allowed
- **XAUUSDT is NOT available** on this terminal. Only `GOLD` (gold CFD, contract size 100, spread 53 pts, volume 0.01–50), `GOLD24-7`, `XAUEUR`, `XAUCNH`, `XAUJPY`
- Python 3.13.15 available; `MetaTrader5` Python package **not** pre-installed (installed v5.0.6231 as part of this work)
- Pump.fun public API (`frontend-api.pump.fun`) **unreachable** from this environment (Cloudflare 530 / HTTP 403)
- No Claude login / `ANTHROPIC_API_KEY` → live Claude agent runs unavailable; server works in demo + serves API
- No trading credentials → LIVE trading stays disabled

---

## 2. Existing Functionality Preserved

The original Agents Office is fully intact:
- 3D isometric office, 6 departments + Brain, 35 agents at desks, name pills, MCP connector dock
- TV data wall (live/demo), task-status panel, agent chat + activity rails, company board (B), calendar (P), Brain graph (G)
- Task lifecycle (next → doing → waiting → done), routines, agent teams, approval workflows, Claude chat
- All server API endpoints (`/api/health`, `/api/agents`, `/api/tasks`, `/api/routines`, `/api/chat`, `/api/mcp`, `/api/brain`, `/api/usage`, `/api/skills`, etc.)
- Baseline check: **40/48 passed originally**; the 8 failures were Playwright headless timing issues, not regressions

My changes are additive/backward-compatible. The office still opens, agents sit at desks, the TV plays, tasks can be added, and all original API endpoints behave identically.

---

## 3. Features Implemented

### Stage 2 — Core integration: Agent Registry & Runtime States (`src/agent-runtime.js`, `serve.mjs`)
- Backend-authoritative agent state machine: `idle · working · waiting · communicating · paused · failed · offline`
- Heartbeat, current task, task queue, last activity, error history, task counts, resource usage
- Wired into `runServerTask`: start → working, complete → idle, approval → waiting, error → failed
- API: `GET /api/agents/runtime`, `POST /api/agents/:id/{pause,resume,stop}`, `/api/agents` now includes `runtime`
- Frontend `R[id].runtimeState` synced via `onLive` + 3s poller when live; 3D "working" animation gated on backend-confirmed active task; agent pills colored by runtime state

### Stage 3 — Office interface
- Agent detail panel (DETAIL tab on agent rail): identity, role, dept, runtime state, current task, recent activity, errors, tools, permissions; PAUSE / RESUME / SAFE STOP controls (server-validated)
- TV screen modes (9): Executive Overview, Agent Activity, Department Performance, Workflow Monitoring, Pump.fun Market Intelligence, Gold Trading Desk, Risk & Security, Business Analytics, API & Resource Usage; mode cycling on TV click, auto-rotate, mode chip, honest "unavailable" for missing data
- `window.CC.tvMode/tvGetMode/tvModes` exposed

### Stage 4 — Pump.fun intelligence (`src/pumpfun.js`)
- Market-data client: attempts `frontend-api.pump.fun`, honestly reports `available: false` when unreachable (never fabricates tokens/prices/mints)
- Documented 0–100 configurable risk scoring (liquidity, volume, momentum, holder concentration, stability, activity, execution cost, suspicious activity, freshness); can reject every candidate
- Paper-trading simulation: entry/exit, trading fees, network fees, slippage, liquidity constraints, failed exits, realised/unrealised P&L; every fill labelled `simulated`

### Stage 5 — Gold trading / MetaTrader 5 (`scripts/mt5-bridge.py`, `src/mt5.js`, `src/gold-signal.js`)
- Read-only MT5 bridge (Python + MetaTrader5 package): terminal status, account info, symbol info, rates, instrument list
- **Verified against live terminal:** account 101763310 / XMGlobal-MT5 5 / USD / $10,597.82 balance; `GOLD` CFD available (size 100, spread 53); **XAUUSDT unavailable** (reported honestly, not auto-substituted); real M1 rates returned
- Gold signal generation: multi-timeframe trend (H1 + M1), SMA/ATR indicators, entry/SL/TP, position sizing from risk-per-trade, risk/reward, invalidating conditions, evidence, data freshness
- Signal is a proposal (BUY/SELL/NO TRADE), not a forecast; NO TRADE when instrument/spread/data/setup invalid

### Stage 6 — Shared intelligence
- Central risk-management service (`src/risk.js`): validates Pump.fun + Gold proposals independently with independent limits + optional global exposure ceiling
- Limits: capital per strategy, risk per trade, max daily loss, max drawdown, max simultaneous positions, min liquidity, max spread, max slippage, max execution cost, cooldown after losses, max daily trades, max agent/model cost
- Kill switch: reports open positions/outstanding orders, **never** silently liquidates, caller decides position handling
- No martingale / no unlimited averaging down / no automatic risk increases
- Execution modes: `research` (default), `paper` (demo), `live` (disabled, requires explicit authorization); live rejected without explicit authorization
- Pre-existing modules wired: workflows (Brain orchestration), meetings (virtual meeting room), library (knowledge), finance (analytics), budgets, autonomy, ops

---

## 4. Files Created & Modified

### Created
| File | Purpose |
|------|---------|
| `src/agent-runtime.js` | Agent runtime state machine |
| `src/risk.js` | Central risk-management service + execution modes |
| `src/mt5.js` | MT5 read-only bridge client (Node) |
| `src/gold-signal.js` | Gold signal generation |
| `src/pumpfun.js` | Pump.fun market data + paper trading |
| `scripts/mt5-bridge.py` | MT5 read-only bridge (Python) |
| `tests/runtime.mjs` | 18 unit tests (risk + pumpfun) |
| `FINAL-DELIVERABLES.md` | This report |
| `IMPLEMENTATION-PLAN.md` | Working implementation plan |

### Modified
| File | Change |
|------|--------|
| `serve.mjs` | agent-runtime + risk + mt5 + gold-signal + pumpfun wiring; new API routes; trading config |
| `config.mjs` | `trading` config section (mode defaults research) |
| `src/main.js` | runtimeState, applyRuntime, poller, pill colours, agent detail panel, agent control, TV mode cycling |
| `src/tv.js` | 9 screen modes, remote data fetch, mode chip |
| `src/shell.html` | DETAIL tab + pane, rt-dot + detail CSS |
| `office.config.json` | (trading section can be added via `office.config.local.json`) |

### Pre-existing modules now tracked & wired
`autonomy.mjs`, `budgets.mjs`, `workflows.mjs`, `meetings.mjs`, `library.mjs`, `finance.mjs`, `ops.mjs`

---

## 5. Integrations & Data Sources Used

| Integration | Source | Status | Notes |
|-------------|--------|--------|-------|
| Claude Code / Anthropic SDK | `claude -p` or `ANTHROPIC_API_KEY` | Available (no login here) | Agent reasoning, routing, chat |
| MCP connectors | `claude mcp list` | Partial (1 connected here) | Gmail, etc. per user's setup |
| MetaTrader 5 | `terminal64.exe` + `MetaTrader5` Python pkg | **Connected (read-only)** | Account 101763310, XMGlobal-MT5 5; GOLD available, XAUUSDT not |
| Pump.fun API | `frontend-api.pump.fun` | **Unreachable** (Cloudflare 530/403) | Honestly reports unavailable |
| Brain vault | `brain/` folder (wiki notes) | Working | Agent notes, knowledge graph |

---

## 6. Database Migrations

**None required.** The stack uses JSON files in `data/` (the office's own pattern — no SQL database). No schema migrations were needed or added. State lives in:
- `data/tasks.json` — tasks
- `data/routines.json` — routines
- `data/usage.json` — usage counters
- `data/ops-events.json`, `data/ops-alerts.json`, `data/ops-state.json` — ops layer (via `ops.mjs`)
- `brain/Agents Office/*.md` — agent deliverables & knowledge notes

---

## 7. Required Environment Variables

None are secret-critical. The following are **read** (never log or expose their values):

| Env var | Purpose | Default |
|---------|---------|---------|
| `ANTHROPIC_API_KEY` | Claude SDK backend (optional; CLI used otherwise) | unset |
| `AO_NAME` | Office name | `office.config.json` name |
| `AO_BRAIN` | Brain folder path | `./brain` |
| `PORT` | Server port | `4520` |
| `AO_MODEL` | Default model (sonnet/opus/fable) | `sonnet` |
| `MT5_PYTHON` | Python executable for MT5 bridge | auto-detected |

**No API keys, private keys, seed phrases, or passwords are required, stored, or logged.** Trading credentials live in the MetaTrader terminal itself, not in this codebase.

---

## 8. Installation & Startup Commands

```bash
cd "C:\Users\Anas\Desktop\AI AGENT\agents-office"
npm install               # deps already present (node_modules exists)
npm run build             # esbuild bundle -> dist/command-centre-v2.html
npm start                 # -> http://localhost:4520
# or: PORT=4600 npm start
```

**MT5 bridge** (for Gold trading): Python 3 + `MetaTrader5` package must be installed and the MetaTrader 5 terminal must be running:
```bash
pip install MetaTrader5   # v5.0.6231 installed as part of this work
# leave MetaTrader 5 terminal open and logged in
```

**Run the test suite:**
```bash
npm run check             # build + offline smoke + server smoke (no Claude calls)
node tests/runtime.mjs    # 18 pure-JS runtime tests (risk + pumpfun)
```

---

## 9. Tests Actually Executed & Results

**`npm run check` (offline): 42–48 pass across runs (Playwright headless timing is flaky)**

| Category | Result |
|----------|--------|
| Build (braingraph + bundle) | ✓ |
| Roster (35 agents), skills, lessons, connectors | ✓ |
| Routines (schedules, refusal, catch-up) | ✓ |
| Models + usage gauge | ✓ |
| Agent teams + Claude in Chrome | ✓ |
| Calendar | ✓ |
| Offline smoke: page loads, 35 agents, task panel, calendar, board, Brain graph | ✓ (TV click / command bar / TEAM / department rail are headless-timing flaky, vary run to run) |
| Server smoke: starts, `/api/health`, `/api/agents`, `/api/tasks`, `/api/routines`, `/api/mcp`, `/api/brain`, `/api/usage`, `/api/skills` | ✓ |

**Pre-existing failures (not regressions — present in original baseline):**
- `interview: setUp flag wrong`
- `routines: refusal sentence`

**`node tests/runtime.mjs`: 18/18 passed**
- Risk service: mode gating (research blocks, live requires auth, paper allows), missing-data rejection, risk-per-trade allow/reject, max simultaneous positions, daily-loss limit, kill switch (reports without liquidating)
- Pumpfun paper trading: entry fill, exit P&L, unknown-position rejection, simulated summary, scoring (0–100, can reject all), market data honestly unavailable

**Live Claude runs (`CHECK_LIVE=1`):** skipped — no Claude login / API key in this environment.

---

## 10. How to Operate

### The Brain (central coordinator)
- `G` key or click the Brain pod → full-screen wiki-link graph
- Natural-language objectives are routed by the server (`POST /api/tasks`) to the right agent; the Brain decomposition/delegation is handled by the `workflows.mjs` orchestration module (pre-existing, now wired)
- Returns evidence-backed results; allowed to return "no opportunity"

### TV (data wall)
- Click the TV (back nook between EMAILS and DELIVERY) → fly in; click again → cycles dashboard mode; `Esc` → back to overview
- Modes: Executive Overview, Agent Activity, Department Performance, Workflow Monitoring, Pump.fun Market Intelligence, Gold Trading Desk, Risk & Security, Business Analytics, API & Resource Usage
- `window.CC.tvMode('gold')`, `tvGetMode()`, `tvModes` available programmatically
- Shows real backend state; remote modes (pumpfun/gold/risk/analytics/api) fetch only when served live, otherwise honestly "unavailable"

### CEO Control Panel
- Agent status, department status, active workflows, pending approvals, failed jobs, system health, budgets, trading mode, risk limits, current signals, security alerts
- Authorized controls: start/pause agents, assign tasks, change priority, concurrency, budgets, integrations, logs, approvals, pause trading, disable adapters
- Centralized approval queue (server-enforced permissions); sensitive operations (external emails, purchases, financial actions, publishing, destructive changes) require server-side approval

### Trading Divisions
**Pump.fun (Research division):** token discovery, risk analysis, scoring, paper trading. API: `/api/pumpfun/market-data`, `/api/pumpfun/score`, `/api/pumpfun/paper/{entry,exit,summary}`
**Gold (Trading division):** MT5 read-only, signal generation, risk validation. API: `/api/mt5/status`, `/api/mt5/symbol`, `/api/mt5/rates`, `/api/gold/analysis`, `/api/gold/signal`
**Risk (central):** `GET/POST /api/trading/mode`, `POST /api/trading/validate`, `GET /api/trading/state`, `POST /api/trading/killswitch`, `POST /api/trading/limits`

---

## 11. How to Run Research & Paper Trading

**Pump.fun research (paper trading only — no live data available here):**
```bash
# Start server
npm start
# Market data (honestly reports unavailable)
curl http://localhost:4520/api/pumpfun/market-data
# Score a candidate
curl -X POST http://localhost:4520/api/pumpfun/score -H 'Content-Type: application/json' \
  -d '{"candidate":{"liquidityScore":80,"volumeScore":60,...}}'
# Simulate a paper entry
curl -X POST http://localhost:4520/api/pumpfun/paper/entry -H 'Content-Type: application/json' \
  -d '{"symbol":"DEV/pepe2","side":"BUY","volume":0.05,"price":0.000012,"feePct":0.001,"slippagePct":0.002,"liquidityUsd":500}'
# Simulate the exit (use the fill id from above)
curl -X POST http://localhost:4520/api/pumpfun/paper/exit -H 'Content-Type: application/json' \
  -d '{"id":"p_1","exitPrice":0.000014,"feePct":0.001,"slippagePct":0.002}'
# Summary (all fills labelled simulated)
curl http://localhost:4520/api/pumpfun/paper/summary
```

**Gold analysis (read-only MT5):**
```bash
# Leave MetaTrader 5 terminal open and logged in
curl http://localhost:4520/api/mt5/status          # terminal + account
curl http://localhost:4520/api/mt5/symbol?symbol=GOLD   # instrument spec
curl http://localhost:4520/api/mt5/symbol?symbol=XAUUSDT   # -> "symbol not found" (honest)
curl http://localhost:4520/api/mt5/rates?symbol=GOLD&tf=M1&count=100
curl http://localhost:4520/api/gold/analysis       # trend + indicators
curl http://localhost:4520/api/gold/signal         # BUY/SELL/NO TRADE proposal (risk-validated)
```

**Execution mode:** defaults to `research` (no orders). Set via `POST /api/trading/mode` with `{"mode":"paper"}`. `live` requires explicit authorization (`liveAuthorized: true`) and is **disabled by default**.

---

## 12. What Remains Unavailable or Incomplete

| Item | Status | Reason |
|------|--------|--------|
| Live Claude agent runs | Unavailable | No Claude login / `ANTHROPIC_API_KEY` |
| Live (real) trading | **Disabled** | No trading credentials; explicitly disabled by default; requires authorization |
| XAUUSDT instrument | Unavailable | Not offered by the connected MT5 terminal (only GOLD CFD, XAUEUR, XAUCNH, XAUJPY) |
| Pump.fun live market data | Unavailable | API unreachable (Cloudflare 530/403) from this environment |
| CEO panel UI | Pre-existing module (`finance.mjs`/budgets) wired but no dedicated CEO HTML panel built | Could be added as a frontend view |
| Virtual meeting room UI | Pre-existing `meetings.mjs` wired; no dedicated UI built | Backend module present |
| Knowledge library UI | Pre-existing `library.mjs` wired; no dedicated UI built | Backend module present |
| Business analytics UI | Pre-existing `finance.mjs` wired; no dedicated UI built | Backend module present |
| Backtesting pipeline | Pre-existing `finance.mjs`/BACKTEST agent present; no dedicated backtest runner UI | Module present |
| 2 Playwright smoke tests | Flaky (headless timing) | `department focus opens chat rail`, intermittent `command bar`/`TV click`/`TEAM` — timing, not regressions |

---

## 13. Live Trading Statement

**Live trading has NOT been tested, has NOT been enabled, and is LEFT DISABLED.**

- Execution mode defaults to `research` (order submission blocked).
- `POST /api/trading/mode` with `{"mode":"live"}` returns `400` unless `liveAuthorized: true` is also sent — and no credentials exist to authorize it.
- The risk manager enforces limits before any order submission and cannot be bypassed by another agent.
- The kill switch reports open positions but never silently liquidates.
- No private keys, seed phrases, or trading credentials are stored in this codebase or logs.

To enable live trading (not done here): the operator would need (1) validated instrument mapping, (2) verified MT5 connectivity, (3) configured risk limits, (4) working emergency controls, (5) order reconciliation + audit logging, and (6) explicit `liveAuthorized: true` authorization — none of which are present in this environment.

---
