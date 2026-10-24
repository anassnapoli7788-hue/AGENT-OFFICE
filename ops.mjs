// ops.mjs — the office's operations layer (V3.9): real event records, alerts, agent status,
// global controls, usage attribution and the dashboard payload behind the Command Center TV,
// the Brain control panel, the communication network and the security tower.
//
// Everything here is DERIVED from what actually happens in serve.mjs: task lifecycle hooks,
// model usage reports, MCP discovery and owner decisions. Nothing is invented. Where a number
// cannot be measured with this backend the payload says so explicitly ("unavailable").
//
// Storage is the office's own pattern: JSON files in data/ (no database in this stack).
//   data/ops-events.json   append-only event log (bounded ring, monotonic seq per event)
//   data/ops-alerts.json   alert records — ack/resolution changes status, never erases history
//   data/ops-state.json    controls (pause), per-agent runtime status, usage counters, config
import fs from 'node:fs';
import path from 'node:path';

const EV_CAP = 2000;                          // ring bound: a busy day's events, bounded on disk
const STALE_MS = 15 * 60 * 1000;              // a "running" task this old with no change = unhealthy
const WAIT_ALERT_MS = 30 * 60 * 1000;         // a draft waiting this long on the owner = nudge alert
const REPEAT_FAILS = 3;                       // N failures on one agent in an hour = critical
const HEARTBEAT_MS = 25 * 1000;               // SSE keep-alive
// Model pricing for ESTIMATED costs. Only models with a known price produce an estimate; a null
// price means "not configured" and the dashboard reports costs as unavailable for those runs.
// Editable in data/ops-config.json (defaults = the provider's published per-Mtok rates).
const DEFAULT_PRICING = { sonnet: { inPerMtok: 3, outPerMtok: 15 }, opus: { inPerMtok: 15, outPerMtok: 75 }, fable: null };

const SEV_RANK = { critical: 0, error: 1, warning: 2, info: 3 };
const read = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); };
const dayStart = (now = Date.now()) => { const s = new Date(now); s.setHours(0, 0, 0, 0); return s.getTime(); };
const nid = pfx => `${pfx}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function initOps({ dataDir, getTasks, getAgents, deptKeys, getUsage, getVersion, getBackend }) {
  const EV = path.join(dataDir, 'ops-events.json');
  const AL = path.join(dataDir, 'ops-alerts.json');
  const ST = path.join(dataDir, 'ops-state.json');
  const CFG = path.join(dataDir, 'ops-config.json');

  let events = read(EV, []); if (!Array.isArray(events)) events = [];
  let alerts = read(AL, []); if (!Array.isArray(alerts)) alerts = [];
  let state = read(ST, {}); if (!state || typeof state !== 'object') state = {};
  state.seq = state.seq || (events.length ? events[events.length - 1].seq : 0);
  state.pausedAgents = state.pausedAgents || {};
  state.usage = state.usage || { requests: 0, errors: 0, rateLimits: 0, tokensIn: 0, tokensOut: 0, byDept: {}, day: 0 };
  state.usage.byDept = state.usage.byDept || {};
  let cfg = read(CFG, null);
  if (!cfg || typeof cfg !== 'object') { cfg = { pricing: DEFAULT_PRICING, staleAfterMs: 30000 }; write(CFG, cfg); }
  if (!cfg.pricing || typeof cfg.pricing !== 'object') cfg.pricing = DEFAULT_PRICING;

  let flushTimer = null;
  const saveEvents = () => {
    if (flushTimer) return; // coalesce bursts (a team fans out several events at once)
    flushTimer = setTimeout(() => { flushTimer = null; write(EV, events.slice(-EV_CAP)); write(ST, state); }, 300);
  };
  const saveAlerts = () => write(AL, alerts);
  const saveState = () => write(ST, state);

  /* ---------- events (the shared record behind activity feeds, networks, audit) ---------- */
  const sseClients = new Set();
  function emit(kind, f = {}) {
    const ev = {
      seq: ++state.seq, ts: Date.now(), kind,
      severity: f.severity || (kind.includes('fail') ? 'error' : kind.includes('alert') ? 'warning' : 'info'),
      dept: f.dept || null, agent: f.agent || null, taskId: f.taskId || null, workflowId: f.workflowId || null,
      from: f.from || null, to: f.to || null, status: f.status || null,
      title: String(f.title || kind).slice(0, 160), detail: f.detail ? String(f.detail).slice(0, 800) : '',
      meta: f.meta || undefined, test: f.test || undefined,
    };
    events.push(ev);
    if (events.length > EV_CAP) events.splice(0, events.length - EV_CAP);
    saveEvents();
    const frame = `id: ${ev.seq}\nevent: ops\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of sseClients) { try { res.write(frame); } catch { sseClients.delete(res); } }
    return ev;
  }
  const eventsSince = (seq, limit = 200) => {
    const n = Number(seq) || 0;
    const out = events.filter(e => e.seq > n);
    return out.slice(-limit);
  };

  /* ---------- alerts: ack/resolution change status; the incident record is never erased ---------- */
  function raiseAlert(key, fields) {
    const now = Date.now();
    const existing = alerts.find(a => a.key === key && a.status === 'open');
    if (existing) { // a repeat of the same incident: aggregate, keep first, bump count
      existing.count = (existing.count || 1) + 1;
      existing.lastAt = now;
      if (fields.severity && SEV_RANK[fields.severity] < SEV_RANK[existing.severity]) existing.severity = fields.severity;
      if (fields.detail) existing.detail = fields.detail;
      existing.history = existing.history || [];
      existing.history.push({ ts: now, note: fields.note || 'repeated' });
      saveAlerts();
      emit('alert.updated', { severity: existing.severity, dept: existing.dept, taskId: key.startsWith('taskfail') ? fields.taskId : null, title: `⚠ ${existing.title} (×${existing.count})`, detail: existing.detail });
      return existing;
    }
    const a = {
      id: nid('al'), key, severity: fields.severity || 'warning', category: fields.category || 'operational',
      ts: now, lastAt: now, count: 1, title: fields.title, detail: fields.detail || '',
      dept: fields.dept || null, subject: fields.subject || null, taskId: fields.taskId || null,
      status: 'open', ackAt: null, resolvedAt: null, recommended: fields.recommended || '',
      history: [{ ts: now, note: 'raised' }],
    };
    alerts.unshift(a);
    if (alerts.length > 200) alerts.length = 200;
    saveAlerts();
    emit('alert.raised', { severity: a.severity, dept: a.dept, taskId: a.taskId, title: `⚠ ${a.title}`, detail: a.detail, meta: { alertId: a.id } });
    return a;
  }
  function resolveAlert(key, note = 'recovered') {
    const a = alerts.find(x => x.key === key && x.status !== 'resolved');
    if (!a) return null;
    a.status = 'resolved'; a.resolvedAt = Date.now();
    a.history = a.history || []; a.history.push({ ts: Date.now(), note });
    saveAlerts();
    emit('alert.resolved', { severity: 'info', dept: a.dept, title: `✓ ${a.title} — recovered`, detail: note, meta: { alertId: a.id } });
    return a;
  }
  const listAlerts = ({ includeResolved = false } = {}) =>
    alerts.filter(a => includeResolved || a.status !== 'resolved')
      .sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (b.lastAt - a.lastAt));
  function ackAlert(id, note) {
    const a = alerts.find(x => x.id === id);
    if (!a) return null;
    a.status = 'acknowledged'; a.ackAt = Date.now();
    a.history = a.history || []; a.history.push({ ts: Date.now(), note: note ? `ack: ${note}` : 'acknowledged by owner' });
    saveAlerts();
    emit('alert.acknowledged', { severity: 'info', dept: a.dept, title: `ACK ${a.title}`, detail: note || '', meta: { alertId: a.id } });
    return a;
  }
  function resolveAlertById(id, note) {
    const a = alerts.find(x => x.id === id);
    if (!a) return null;
    a.status = 'resolved'; a.resolvedAt = Date.now();
    a.history = a.history || []; a.history.push({ ts: Date.now(), note: note || 'resolved by owner' });
    saveAlerts();
    emit('alert.resolved', { severity: 'info', dept: a.dept, title: `✓ ${a.title} — resolved`, detail: note || '', meta: { alertId: a.id } });
    return a;
  }

  /* ---------- agent runtime status: derived from task records + controls, with a heartbeat ---------- */
  function setAgent(id, patch) {
    const map = state.agentStatus = state.agentStatus || {};
    const cur = map[id] || { status: 'idle', since: Date.now() };
    Object.assign(cur, patch, { heartbeat: Date.now() });
    map[id] = cur; saveState();
    return cur;
  }
  const clearAgent = id => { const m = state.agentStatus || {}; if (m[id]) delete m[id]; saveState(); };

  function deriveAgents() {
    const tasks = getTasks() || [];
    const agents = getAgents() || [];
    const pausedAgents = state.pausedAgents || {};
    const stored = state.agentStatus || {};
    const now = Date.now();
    const byId = {};
    for (const a of agents) {
      const mine = tasks.filter(t => t.agent === a.id);
      const doing = mine.find(t => t.state === 'doing');
      const waiting = mine.filter(t => t.state === 'waiting');
      const lastDone = [...mine].filter(t => t.state === 'done').sort((x, y) => (y.doneAt || 0) - (x.doneAt || 0))[0];
      const openFail = alerts.find(al => al.status === 'open' && (al.category === 'task_failure' || al.category === 'rate_limit') && al.subject?.id === a.id);
      let status = 'idle', detail = '';
      if (pausedAgents[a.id]) { status = 'paused'; detail = pausedAgents[a.id].reason || 'paused by owner'; }
      else if (doing) {
        status = 'working';
        const age = now - (doing.startedAt || doing.addedAt || now);
        if (age > STALE_MS) { status = 'unhealthy'; detail = `running for ${Math.round(age / 60000)} min without completing`; }
        else detail = doing.title;
      } else if (openFail && (!lastDone?.doneAt || lastDone.doneAt < (openFail.lastAt || 0))) { status = 'failed'; detail = openFail.title; }
      else if (waiting.length) { status = 'waiting'; detail = `${waiting.length} draft${waiting.length > 1 ? 's' : ''} waiting for the owner's OK`; }
      const storedAt = stored[a.id];
      byId[a.id] = {
        id: a.id, name: a.name, dept: a.department, lead: !!a.lead,
        status, detail,
        // online = registered against the running office server (agents are in-process seats in
        // this architecture — there is no external agent daemon to be offline from)
        online: true,
        since: storedAt?.since || now, heartbeat: storedAt?.heartbeat || now,
        stale: status === 'unhealthy',
        currentTaskId: doing ? doing.id : null,
        waitingCount: waiting.length,
        lastError: openFail ? { title: openFail.title, detail: openFail.detail, ts: openFail.lastAt } : null,
      };
    }
    const list = Object.values(byId);
    const c = s => list.filter(x => x.status === s).length;
    return {
      total: list.length, online: list.filter(x => x.online).length, offline: list.filter(x => !x.online).length,
      busy: c('working'), idle: c('idle'), waiting: c('waiting'), paused: c('paused'),
      failed: c('failed'), unhealthy: c('unhealthy'),
      heartbeatNote: `unhealthy = a running task older than ${Math.round(STALE_MS / 60000)} min with no state change`,
      byId,
    };
  }

  /* ---------- usage: real counters, labelled estimates only ---------- */
  const bumpDay = () => { const u = state.usage; if (dayStart(u.day) !== dayStart()) { u.day = Date.now(); Object.assign(u, { requests: 0, errors: 0, rateLimits: 0, tokensIn: 0, tokensOut: 0, byDept: {} }); } };
  const noteRequest = () => { bumpDay(); state.usage.requests++; saveState(); };
  const noteError = msg => { bumpDay(); state.usage.errors++; if (/rate|429|overloaded|too many/i.test(String(msg))) state.usage.rateLimits++; saveState(); };
  let runCtx = null; // ambient context: the server runs tasks serially (serve's queue), so one active run is safe
  const beginRun = task => { runCtx = { dept: task?.dept || null, agent: task?.agent || null, model: task?.modelUsed || task?.model || null, taskId: task?.id || null }; };
  const endRun = () => { runCtx = null; };
  // per-run rows (capped): the honest basis for per-model / per-dept / per-period usage and cost estimates.
  // The CLI's stream-json result and the SDK's response both report snake_case token fields.
  state.usageLog = Array.isArray(state.usageLog) ? state.usageLog : [];
  const costOf = (model, din, dout) => {
    const p = model && cfg.pricing[model];
    if (!p) return null;
    return Math.round(((din / 1e6) * p.inPerMtok + (dout / 1e6) * p.outPerMtok) * 10000) / 10000;
  };
  function recordUsage(u) {
    if (!u) return;
    const din = u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0,
          dout = u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0;
    const s = state.usage;
    if (dayStart(s.day) !== dayStart()) { s.day = Date.now(); Object.assign(s, { requests: 0, errors: 0, rateLimits: 0, tokensIn: 0, tokensOut: 0, byDept: {} }); }
    s.tokensIn += din || 0; s.tokensOut += dout || 0;
    if (runCtx?.dept) {
      const d = s.byDept[runCtx.dept] = s.byDept[runCtx.dept] || { tokensIn: 0, tokensOut: 0, runs: 0 };
      d.tokensIn += din || 0; d.tokensOut += dout || 0; d.runs++;
    }
    const row = {
      at: Date.now(), dept: runCtx?.dept || null, agent: runCtx?.agent || null, taskId: runCtx?.taskId || null,
      model: runCtx?.model || null, tokensIn: din || 0, tokensOut: dout || 0,
      costUsd: costOf(runCtx?.model, din || 0, dout || 0), // null when the model has no configured price
    };
    state.usageLog.push(row);
    if (state.usageLog.length > 2000) state.usageLog.splice(0, state.usageLog.length - 2000);
    saveState();
  }
  // usage rows in a period — the shared source for budgets, finance metrics and the usage panel
  const usageRows = (from = 0, to = Infinity) => state.usageLog.filter(r => r.at >= from && r.at <= to);
  function usageByModel(from, to) {
    const out = {};
    for (const r of usageRows(from, to)) {
      const m = out[r.model || 'unknown'] = out[r.model || 'unknown'] || { model: r.model || null, runs: 0, tokensIn: 0, tokensOut: 0, costUsd: null, unpriced: !cfg.pricing[r.model || ''] };
      m.runs++; m.tokensIn += r.tokensIn; m.tokensOut += r.tokensOut;
      if (r.costUsd != null) m.costUsd = (m.costUsd || 0) + r.costUsd;
    }
    for (const m of Object.values(out)) if (m.costUsd != null) m.costUsd = Math.round(m.costUsd * 10000) / 10000;
    return out;
  }
  async function usagePayload() {
    const now = Date.now();
    const s = state.usage;
    const day = dayStart(s.day) === dayStart();
    const totals = day ? s : { requests: 0, errors: 0, rateLimits: 0, tokensIn: 0, tokensOut: 0, byDept: {} };
    let priceable = true;
    const costByModel = {};
    // cost estimate: only models with configured pricing; anything unpriced makes the total unavailable
    const tasks = getTasks() || [];
    const modelUse = {};
    for (const t of tasks.filter(t => dayStart(t.doneAt || 0) >= dayStart() && t.modelUsed)) modelUse[t.modelUsed] = (modelUse[t.modelUsed] || 0) + 1;
    // tokens are recorded in totals but not per model (the office's counter is per window/day) —
    // so a cost total is only honest if every model in play has a configured price AND tokens exist.
    const live = getUsage ? await getUsage() : null;
    const tokens = (totals.tokensIn || totals.tokensOut) ? { in: totals.tokensIn, out: totals.tokensOut } : (live?.office?.tokens ? { in: 0, out: live.office.tokens } : null);
    const models = Object.keys(modelUse);
    for (const m of models) if (!cfg.pricing[m]) priceable = false;
    // cost estimate from the per-run rows: only when every run today has a configured price
    const rows = usageRows(dayStart(), now);
    let cost = null;
    if (rows.length && rows.every(r => r.costUsd != null)) {
      const est = rows.reduce((n, r) => n + (r.costUsd || 0), 0);
      cost = { amount: Math.round(est * 1000) / 1000, currency: 'USD', estimated: true, runs: rows.length };
    }
    return {
      available: !!(tokens || live?.session),
      source: live?.source || 'office',
      period: { kind: 'day', from: dayStart(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
      requests: totals.requests, tokensIn: totals.tokensIn || null, tokensOut: totals.tokensOut || null,
      errors: totals.errors, rateLimitErrors: totals.rateLimits,
      cost, costBasis: cost ? `estimated from recorded token counts × configured pricing (${Object.keys(cfg.pricing).filter(k => cfg.pricing[k]).join(', ') || 'no pricing configured'})` : null,
      unpricedModels: models.filter(m => !cfg.pricing[m]),
      byModel: usageByModel(dayStart(), now),
      byDept: Object.keys(totals.byDept).length ? Object.fromEntries(Object.entries(totals.byDept).map(([k, v]) => [k, { ...v, cost: null, note: 'tokens attributed to real runs; per-dept cost needs configured pricing' }])) : null,
      claude: live ? { source: live.source, session: live.session || null, week: live.week || null, reason: live.reason || null } : null,
      note: tokens || live?.session ? null : 'Usage data unavailable',
    };
  }

  /* ---------- task lifecycle hooks ---------- */
  const hooks = {
    taskCreated(t, f = {}) {
      emit(f.scheduled ? 'task.scheduled' : 'task.assigned', {
        dept: t.dept, agent: t.agent, taskId: t.id,
        title: `${f.scheduled ? 'Scheduled' : 'Assigned'}: ${t.title}`,
        detail: f.scheduled && t.dueAt ? `for ${new Date(t.dueAt).toLocaleString()}` : (t.plan || []).join(' → '),
        status: 'queued',
      });
      setAgent(t.agent, { status: 'idle' });
    },
    routineFired(r, t) {
      emit('routine.fired', { dept: r.dept, agent: r.agent, taskId: t.id, title: `Routine fired: ${r.title}`, detail: r.desc || '', status: 'queued' });
    },
    taskStart(t) {
      beginRun(t);
      emit('task.started', { dept: t.dept, agent: t.agent, taskId: t.id, title: `Started: ${t.title}`, detail: (t.plan || []).slice(0, 3).join(' → '), status: 'running' });
      setAgent(t.agent, { status: 'working', since: Date.now(), currentTask: t.id });
    },
    taskWaiting(t) {
      emit('task.approval_requested', { dept: t.dept, agent: t.agent, taskId: t.id, severity: 'warning', title: `Needs your OK: ${t.title}`, detail: t.ask || 'draft ready', status: 'waiting' });
      setAgent(t.agent, { status: 'waiting', since: Date.now() });
      if (t.ask) raiseAlert(`wait:${t.id}`, {
        severity: 'warning', category: 'intervention', dept: t.dept, taskId: t.id,
        subject: { kind: 'task', id: t.id, name: t.title },
        title: `Draft waiting for your OK: ${t.title}`, detail: t.ask,
        recommended: 'Open the agent chat and APPROVE or REJECT the draft.',
      });
    },
    taskDone(t) {
      endRun();
      emit('task.completed', { dept: t.dept, agent: t.agent, taskId: t.id, title: `Completed: ${t.title}`, detail: `${(t.result || '').length} chars${t.tools?.length ? ' · tools: ' + t.tools.join(', ') : ''}`, status: 'done' });
      setAgent(t.agent, { status: 'idle', since: Date.now(), currentTask: null });
      resolveAlert(`wait:${t.id}`, 'task left the waiting state');
      if (!t.error) resolveAlert(`taskfail:${t.agent}:${t.id}`, 'completed without error');
    },
    taskFail(t, err) {
      endRun();
      const msg = String(err?.message || err || 'unknown error').slice(0, 400);
      const rate = /rate|429|overloaded|too many/i.test(msg);
      const dupFails = alerts.filter(a => a.key.startsWith(`taskfail:${t.agent}:`) && a.status === 'open' && Date.now() - a.ts < 3600000).length + 1;
      emit('task.failed', { dept: t.dept, agent: t.agent, taskId: t.id, severity: 'error', title: `Failed: ${t.title}`, detail: msg, status: 'failed' });
      setAgent(t.agent, { status: 'failed', since: Date.now(), currentTask: null, lastError: msg });
      raiseAlert(`taskfail:${t.agent}:${t.id}`, {
        severity: rate ? 'error' : dupFails >= REPEAT_FAILS ? 'critical' : 'error',
        category: rate ? 'rate_limit' : 'task_failure',
        dept: t.dept, taskId: t.id, subject: { kind: 'agent', id: t.agent, name: t.name || t.agent },
        title: `${rate ? 'Rate limited' : 'Task failed'}: ${t.title}`,
        detail: `${msg}${dupFails > 1 ? ` · ${dupFails} failures on this agent in the last hour` : ''}`,
        recommended: rate ? 'Wait for the provider window to reset, then retry.' : 'Inspect the task error, then retry if safe.',
      });
    },
    taskCancelled(t) {
      emit('task.cancelled', { dept: t.dept, agent: t.agent, taskId: t.id, severity: 'info', title: `Cancelled: ${t.title}`, status: 'cancelled' });
      resolveAlert(`wait:${t.id}`, 'task cancelled');
    },
    decided(t, ok, note) {
      emit(ok ? 'task.approved' : 'task.rejected', {
        dept: t.dept, agent: t.agent, taskId: t.id, severity: 'info',
        title: `${ok ? 'Approved' : 'Sent back'}: ${t.title}`, detail: note || '', status: ok ? 'approved' : 'rework',
      });
      if (!ok) emit('comm', { from: 'owner', to: t.agent, taskId: t.id, title: `Owner → ${t.agent}: rework requested`, detail: note || '', status: 'completed' });
      resolveAlert(`wait:${t.id}`, ok ? 'approved by owner' : 'rejected by owner');
      if (ok && state.paused) { /* owner decisions always pass the dispatch gate */ }
    },
    comm(from, to, f = {}) {
      emit('comm', { from, to, taskId: f.taskId, workflowId: f.workflowId, dept: f.dept, title: f.title || `${from} → ${to}`, detail: f.detail || '', status: f.status || 'completed' });
    },
    dispatchBlocked(t, reason) {
      emit('dispatch.blocked', { dept: t.dept, agent: t.agent, taskId: t.id, severity: 'warning', title: `Dispatch paused: ${t.title}`, detail: reason, status: 'blocked' });
    },
    testFail(t, msg) {
      // fault injection: an explicitly-labelled test task carried through the REAL failure pipeline.
      // The injected task record already says "SIMULATED" in its title/result — pass the raw
      // message on so the alert detail doesn't double-prefix it.
      hooks.taskFail({ ...t, error: true }, msg);
      emit('test.simulated_failure', { dept: t.dept, agent: t.agent, taskId: t.id, severity: 'warning', title: `Test failure injected on ${t.agent}`, detail: msg, status: 'failed', test: true });
      emit('audit.test', { severity: 'info', title: 'Fault-injection test run', detail: `POST /api/ops/test-failure → ${t.agent}`, test: true });
    },
  };

  /* ---------- global controls: pause all / resume, per-agent pause, dispatch gate ---------- */
  let onResume = () => {};
  const setOnResume = fn => { onResume = fn; };
  function pauseAll(by = 'owner', reason = '') {
    if (state.paused) return { already: true, ...pauseReport() };
    state.paused = { at: Date.now(), by, reason };
    saveState();
    emit('audit.pause_all', { severity: 'warning', title: 'Pause All Agents engaged', detail: reason || 'owner confirmed', status: 'paused' });
    return { ok: true, ...pauseReport() };
  }
  function pauseReport() {
    const agents = deriveAgents();
    const busy = Object.values(agents.byId).filter(a => a.status === 'working' || a.status === 'unhealthy');
    const idle = Object.values(agents.byId).filter(a => !['working', 'unhealthy'].includes(a.status));
    for (const a of idle) state.pausedAgents[a.id] = { by: 'pause-all', at: Date.now(), reason: 'Pause All' };
    saveState();
    return {
      paused: idle.map(a => a.id),
      notInterruptible: busy.map(a => ({ id: a.id, name: a.name, reason: a.detail || 'mid-run' })),
      note: 'Paused agents stop receiving new work. Runs already executing cannot always be interrupted — they are listed under notInterruptible and finish on their own.',
    };
  }
  function resumeAll() {
    const was = !!state.paused;
    state.paused = null; state.pausedAgents = {}; saveState();
    emit('audit.resume_all', { severity: 'info', title: 'Orchestration resumed', detail: '', status: 'running' });
    if (was) onResume();
    return { ok: true, resumed: was };
  }
  const dispatchAllowed = () => !state.paused;
  function pauseAgent(id, reason = '') {
    if (!getAgents().some(a => a.id === id)) return null;
    state.pausedAgents[id] = { by: 'owner', at: Date.now(), reason: reason || 'paused by owner' };
    saveState();
    emit('agent.paused', { agent: id, severity: 'warning', title: `Agent paused: ${id}`, detail: reason, status: 'paused' });
    return state.pausedAgents[id];
  }
  function resumeAgent(id) {
    if (!state.pausedAgents[id]) return false;
    delete state.pausedAgents[id]; saveState();
    emit('agent.resumed', { agent: id, severity: 'info', title: `Agent resumed: ${id}`, status: 'idle' });
    return true;
  }

  /* ---------- department health: severity-based, label + icon as well as colour ---------- */
  function deptHealth() {
    const open = alerts.filter(a => a.status === 'open');
    const acked = alerts.filter(a => a.status === 'acknowledged'); // seen, not yet resolved
    const tasks = getTasks() || [];
    const agents = state.pausedAgents || {};
    const out = {};
    for (const k of deptKeys) {
      const depts = open.filter(a => a.dept === k);
      const hard = depts.filter(a => a.severity === 'critical' || a.severity === 'error');
      const worst = [...hard].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])[0];
      const waiting = tasks.filter(t => t.dept === k && t.state === 'waiting').length;
      const deptAgents = (getAgents() || []).filter(a => a.department === k);
      const allPaused = deptAgents.length > 0 && deptAgents.every(a => agents[a.id]);
      const ackedHere = acked.filter(a => a.dept === k);
      let status = 'green', label = 'HEALTHY', icon = '●';
      if (worst && (worst.severity === 'critical' || worst.severity === 'error')) { status = 'red'; label = 'ERROR'; icon = '✖'; }
      // an acknowledged alert is seen but not resolved: the red alarm lifts, the amber attention stays
      else if (worst || ackedHere.length) { status = 'amber'; label = worst ? 'ATTENTION' : 'ACKNOWLEDGED'; icon = '▲'; }
      else if (waiting) { status = 'amber'; label = 'WAITING'; icon = '▲'; }
      else if (allPaused) { status = 'grey'; label = 'PAUSED'; icon = '○'; }
      out[k] = {
        status, label, icon,
        alerts: depts.length, waiting,
        error: status === 'red' ? { title: worst.title, detail: worst.detail, alertId: worst.id, severity: worst.severity, ts: worst.lastAt } : null,
        warnings: depts.filter(a => a.severity === 'warning').map(a => ({ title: a.title, alertId: a.id })),
      };
    }
    return out;
  }

  /* ---------- the dashboard payload (TV / CEO panel / Brain share it) ---------- */
  async function dashboard() {
    const now = Date.now(), ds = dayStart(now);
    const tasks = getTasks() || [];
    const doneOk = tasks.filter(t => t.state === 'done' && !t.error && (t.doneAt || 0) >= ds);
    const doneFail = tasks.filter(t => t.state === 'done' && t.error && (t.doneAt || 0) >= ds);
    const cancelledToday = events.filter(e => e.kind === 'task.cancelled' && e.ts >= ds).length;
    const denom = doneOk.length + doneFail.length;
    const durations = doneOk.filter(t => t.startedAt && t.doneAt).map(t => t.doneAt - t.startedAt);
    const alertsOpen = listAlerts();
    return {
      now, version: getVersion ? getVersion() : '', backend: getBackend ? getBackend() : '',
      day: { start: ds, tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
      agents: deriveAgents(),
      tasks: {
        completedToday: doneOk.length, failedToday: doneFail.length, cancelledToday,
        running: tasks.filter(t => t.state === 'doing').length,
        queued: tasks.filter(t => t.state === 'next').length,
        waiting: tasks.filter(t => t.state === 'waiting').length,
        scheduled: tasks.filter(t => t.state === 'scheduled').length,
        // success/failure rates over completed tasks today; cancelled + unfinished excluded by definition
        successRate: denom ? Math.round((doneOk.length / denom) * 1000) / 10 : null,
        failureRate: denom ? Math.round((doneFail.length / denom) * 1000) / 10 : null,
        rateBasis: denom ? `over ${denom} completed today (cancelled and unfinished excluded)` : 'no completed tasks today',
        avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
        recentFailed: doneFail.slice(-5).map(t => ({ id: t.id, title: t.title, agent: t.agent, dept: t.dept, error: String(t.result || '').slice(0, 300), at: t.doneAt })),
      },
      usage: await usagePayload(),
      activity: events.slice(-40).reverse(),
      alerts: { open: alertsOpen.length, critical: alertsOpen.filter(a => a.severity === 'critical').length, list: alertsOpen.slice(0, 20) },
      depts: deptHealth(),
      controls: { paused: !!state.paused, pausedAt: state.paused?.at || null, pausedReason: state.paused?.reason || null, pausedAgents: Object.keys(state.pausedAgents || {}) },
      stale: { afterMs: cfg.staleAfterMs || 30000, note: 'clients should flag data older than staleAfterMs as stale' },
      eventSeq: state.seq,
    };
  }

  return {
    emit, eventsSince, dashboard,
    hooks, noteRequest, noteError, recordUsage, beginRun, endRun,
    usageRows, usageByModel, pricingTable: () => cfg.pricing,
    listAlerts, ackAlert, resolveAlertById, raiseAlert, resolveAlert,
    setAgent, clearAgent, deriveAgents,
    controls: { state, pauseAll, resumeAll, pauseAgent, resumeAgent, allowed: dispatchAllowed, setOnResume },
    pricing: cfg.pricing, config: cfg,
    sse: {
      clients: sseClients,
      attach(res, lastId) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`retry: 3000\n\n`);
        if (lastId) for (const e of eventsSince(lastId, 500)) res.write(`id: ${e.seq}\nevent: ops\ndata: ${JSON.stringify(e)}\n\n`);
        const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, HEARTBEAT_MS);
        sseClients.add(res);
        res.on('close', () => { clearInterval(beat); sseClients.delete(res); });
      },
    },
    flush: () => { write(EV, events.slice(-EV_CAP)); write(ST, state); },
  };
}
