// budgets.mjs — server-side budget enforcement (V3.9, CEO panel · Budgets).
//
// A budget is { id, scope: 'office'|'dept'|'agent', ref, metric, limit, window }:
//   metric: 'runs' (Claude runs) · 'tokens' (in+out) · 'costUsd' (only when model pricing is
//           configured — an unpriced model makes a cost budget unenforceable, and it says so)
//   window: 'day' (local midnight) · 'week' (last Monday) · 'month' (the 1st)
// Usage is computed from ops.mjs's per-run rows — real runs only, never estimates of the future.
// Enforcement: creating a task that would exceed a limit is refused with the reason; approaching
// a limit (≥80%) raises an alert. Estimates are never treated as charges.
import fs from 'node:fs';
import path from 'node:path';

const WINDOWS = ['day', 'week', 'month'];
const METRICS = ['runs', 'tokens', 'costUsd'];

export function initBudgets({ dataDir, usageRows, raiseAlert }) {
  const FILE = path.join(dataDir, 'budgets.json');
  const read = () => { try { const v = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } };
  const write = v => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(v, null, 2)); };

  const nid = pfx => `${pfx}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const startOf = (now = Date.now()) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const startOfWeek = (now = Date.now()) => { const d = new Date(startOf(now)); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return d.getTime(); };
  const startOfMonth = (now = Date.now()) => { const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const windowStart = (w, now) => w === 'day' ? startOf(now) : w === 'week' ? startOfWeek(now) : startOfMonth(now);

  function validate(b) {
    if (!b || typeof b !== 'object') return 'a budget object is required';
    if (!['office', 'dept', 'agent'].includes(b.scope)) return 'scope must be office, dept or agent';
    if (b.scope !== 'office' && !b.ref) return `scope ${b.scope} needs a ref (the ${b.scope} key)`;
    if (!METRICS.includes(b.metric)) return 'metric must be runs, tokens or costUsd';
    if (!WINDOWS.includes(b.window)) return 'window must be day, week or month';
    if (!(Number(b.limit) > 0)) return 'limit must be a positive number';
    return null;
  }
  function add(b) {
    const err = validate(b); if (err) throw new Error(err);
    const item = { id: nid('bud'), scope: b.scope, ref: b.scope === 'office' ? null : String(b.ref), metric: b.metric, limit: Number(b.limit), window: b.window, note: String(b.note || '').slice(0, 200), createdAt: Date.now() };
    const all = read(); all.push(item); write(all);
    return item;
  }
  const remove = id => { const all = read(); const n = all.length; const out = all.filter(x => x.id !== id); write(out); return out.length !== n; };
  const list = () => read();

  // usage for one budget over its window, from the real per-run rows
  function usedBy(item, now = Date.now()) {
    const from = windowStart(item.window, now);
    let rows = usageRows(from, now);
    if (item.scope === 'agent') rows = rows.filter(r => r.agent === item.ref);
    else if (item.scope === 'dept') rows = rows.filter(r => r.dept === item.ref);
    if (item.metric === 'runs') return { used: rows.length, computable: true };
    if (item.metric === 'tokens') return { used: rows.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0), computable: true };
    // costUsd: only enforceable when every row in the window has a configured price
    if (!rows.length) return { used: 0, computable: true };
    if (rows.some(r => r.costUsd == null)) return { used: null, computable: false, reason: 'some runs in this window used a model with no configured price — the cost budget cannot be enforced' };
    return { used: Math.round(rows.reduce((n, r) => n + (r.costUsd || 0), 0) * 10000) / 10000, computable: true };
  }

  // the gate every new task passes. Returns { blocked, reason, warnings[] }
  function check({ agent, dept }, now = Date.now()) {
    const warnings = [];
    for (const item of read()) {
      const mine = item.scope === 'office' || (item.scope === 'agent' && item.ref === agent) || (item.scope === 'dept' && item.ref === dept);
      if (!mine) continue;
      const u = usedBy(item, now);
      if (!u.computable) { warnings.push(`${label(item)}: ${u.reason}`); continue; }
      const pct = (u.used / item.limit) * 100;
      if (pct >= 100) return { blocked: true, item, used: u.used, reason: `${label(item)} is exhausted (${fmtU(item, u.used)} of ${fmtU(item, item.limit)} this ${item.window}) — raise it in the CEO panel to continue` };
      if (pct >= 80) {
        warnings.push(`${label(item)} at ${Math.round(pct)}% (${fmtU(item, u.used)} of ${fmtU(item, item.limit)} this ${item.window})`);
        raiseAlert(`budget:${item.id}:${windowStart(item.window, now)}`, {
          severity: 'warning', category: 'budget', dept: item.scope === 'dept' ? item.ref : null, subject: { kind: item.scope, id: item.ref || 'office' },
          title: `Budget at ${Math.round(pct)}%: ${label(item)}`,
          detail: `${fmtU(item, u.used)} of ${fmtU(item, item.limit)} this ${item.window}. The next task over the limit is refused.`,
          recommended: 'Raise the budget in the CEO panel, or let the window reset.',
        });
      }
    }
    return { blocked: false, reason: null, warnings };
  }
  const label = i => `${i.scope === 'office' ? 'office-wide' : i.scope + ' ' + i.ref} budget (${i.metric === 'costUsd' ? 'estimated $' : i.metric})`;
  const fmtU = (i, v) => i.metric === 'costUsd' ? '$' + Number(v).toFixed(2) + ' (estimated)' : String(Math.round(v));

  // what the panels show: every budget with its live usage
  function overview(now = Date.now()) {
    return read().map(item => {
      const u = usedBy(item, now);
      return { ...item, used: u.used, computable: u.computable, note: u.computable ? null : u.reason, pct: u.computable ? Math.round((u.used / item.limit) * 100) : null, windowStart: windowStart(item.window, now) };
    });
  }
  return { add, remove, list, check, overview, validate };
}
