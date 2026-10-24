# Implementation Plan — Agents Office → Intelligent AI Company & Trading HQ

## Baseline (verified)
- `npm run check`: 40/48 pass (8 failures are Playwright headless timing issues, not regressions)
- Server starts on http://localhost:4520, "Pump.fun Trading Desk", 35 agents, 6 depts + Brain
- MetaTrader 5 terminal installed at `C:\Program Files\MetaTrader 5` (terminal64.exe)
- Python 3.13.15 available; MetaTrader5 Python package NOT installed
- No Claude login / API key → live Claude runs unavailable; server works in demo + serves API
- No trading credentials → LIVE trading stays disabled by default

## Checklist (incremental, each stage runnable + tested)

### Stage 2 — Core integration (agent registry + runtime states)
- [ ] Create `src/agent-runtime.js`: per-agent runtime state machine (Idle, Working, Waiting, Communicating, Paused, Failed, Offline), heartbeat, current task, task queue, last activity, error history, perf stats
- [ ] Wire runtime into serve.mjs task lifecycle (start → Working, complete → Idle, approval → Waiting, error → Failed)
- [ ] Expose `/api/agents/runtime` (GET) and agent control (POST pause/resume/safe-stop)
- [ ] Frontend `main.js` `R` states synced from backend polling; reflect real state (not hardcoded 'working')
- [ ] Agent detail panel: identity, status, current task, recent tasks, performance, errors, tools, permissions, pause/resume/safe-stop (server-validated)

### Stage 3 — Office interface
- [ ] 3D: improve materials/lighting/department separation/agent labels/TV/brain (polished, keep existing style)
- [ ] Navigation: pan/zoom/orbit/reset/focus dept/focus agent/return to Brain/fullscreen/agent search/camera presets
- [ ] Interactions: click agent→detail, dept→dashboard, Brain→orchestration, connection→history, TV→command center, alert→incident, task→details
- [ ] TV screen modes: Executive Overview, Agent Activity, Dept Performance, Workflow Monitoring, Business Analytics, Pump.fun Intel, Gold Desk, Risk & Security, API Usage
- [ ] Task board: search, filters, assignment, priority, retry, safe cancellation, activity feed
- [ ] CEO control panel: agent/dept status, workflows, approvals, risk limits, trading mode, security alerts (server-enforced permissions)

### Stage 4 — Pump.fun research
- [ ] Pump.fun market-data client (public endpoints, source+timestamp, no fabricated metrics)
- [ ] Token discovery + candidate collection (verified fields, risk indicators)
- [ ] Risk analysis (concentration, liquidity, suspicious activity, stale data; facts vs heuristics)
- [ ] Configurable scoring system (documented, can reject all candidates)
- [ ] Paper trading (fees, slippage, liquidity, failed exits, P&L, labelled simulated)
- [ ] Pump.fun agents wired to existing framework

### Stage 5 — Gold trading (MetaTrader 5)
- [ ] Install MetaTrader5 Python package; verify import
- [ ] Read-only MT5 connectivity: terminal version, account, permissions, gold symbols
- [ ] XAUUSDT instrument verification (symbol spec, contract size, tick, volume limits, spread, margin, hours, quote currency, order types)
- [ ] Market-data retrieval + multi-timeframe analysis
- [ ] Signal generation (instrument, ts, source, strategy, direction, entry, SL, TP, size, costs, R/R, invalidation, evidence, freshness, status; NO TRADE when invalid)
- [ ] Risk validation (capital per strategy, risk per trade, daily loss, drawdown, exposure, positions, spread, slippage, cooldown)
- [ ] Demo/paper execution + order reconciliation (submitted ≠ filled)

### Stage 6 — Shared intelligence
- [ ] Central risk-management service (validates both divisions; independent limits + optional global)
- [ ] Execution modes: RESEARCH (default), PAPER/DEMO, LIVE (disabled, explicit auth)
- [ ] Communication visualization (actual events, correlation IDs, no secrets)
- [ ] Knowledge library (strategy docs, rules, reports, trades, backtests, procedures; verified status)
- [ ] Bounded virtual meeting room (rounds/time/token/cost limits, separate research vs execution)
- [ ] Business analytics (verified revenue/expenses/P&L, separate paper vs real)
- [ ] Security: auth, RBAC, input validation, secrets, rate limiting, audit logs, health checks, timeouts, bounded retries, graceful shutdown

### Stage 7 — Validation
- [ ] Tests: agent state transitions, task lifecycle, workflow delegation, events, permissions, risk validation, invalid market data, stale data, unknown symbols, invalid position sizes, spread/slippage filters, rejected orders, duplicate events, timeouts, uncertain outcomes, emergency stop, paper calcs, analytics calcs, persistence
- [ ] End-to-end: office → research task → delegate → real status → TV → communications → report → persist → safe failure
- [ ] Run `npm run check`, lint, type checks, production build; fix regressions
- [ ] Verify disconnected/error states handled honestly
- [ ] Document setup, limitations, what is unavailable

## Non-negotiables observed
- No real trading automatically; LIVE disabled until explicit authorization
- Never expose secrets; never fabricate data; show "unavailable" honestly
- Preserve existing functionality; incremental, reversible changes
- Backend authoritative for state; frontend displays real backend state
