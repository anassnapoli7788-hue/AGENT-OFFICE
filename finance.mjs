// finance.mjs — business performance records + metrics (V3.9, the Performance Wall).
//
// The office has NO financial integration wired (no Stripe, no bank feed, no CRM): the only
// honest sources are (a) records the owner enters here, marked verified or not, and (b) real
// usage the office itself measured (API costs estimated from configured pricing, runs, tokens).
// Nothing in this module invents revenue, leads or profit. Metrics that need a source the
// office does not have (pipeline, leads, conversion) come back as null + a reason, and the
// wall shows "unavailable" for them.
//
// Records: { id, kind: 'revenue'|'expense', source, ref, amount, currency, date, category,
//            dept, project, verified, note, createdAt }  in data/finance.json.
// Metric definitions (documented, tested):
//   revenue         = Σ verified revenue records in the period
//   expenses         = Σ verified expense records in the period
//   actualProfit     = revenue − expenses (recognized records only)
//   conversionRate   = null — no lead source connected; needs a CRM integration first
//   costPerCompletedTask = estimated API cost in the period ÷ completed tasks in the period
//                          (only when every run in the period has a configured price; else tokens)
import fs from 'node:fs';
import path from 'node:path';

export function initFinance({ dataDir, usageRows, getTasks }) {
  const FILE = path.join(dataDir, 'finance.json');
  const read = () => { try { const v = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(v.records) ? v.records : []; } catch { return []; } };
  const write = records => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ records }, null, 2)); };
  const nid = () => 'fin_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function add(r) {
    const kind = r.kind === 'revenue' || r.kind === 'expense' ? r.kind : null;
    if (!kind) throw new Error('kind must be revenue or expense');
    const amount = Number(r.amount);
    if (!(amount > 0)) throw new Error('amount must be a positive number');
    const date = typeof r.date === 'number' ? r.date : Date.parse(r.date);
    if (!(date > 0)) throw new Error('date must be a time (ms or ISO)');
    const rec = {
      id: nid(), kind, source: String(r.source || 'manual entry').slice(0, 120), ref: String(r.ref || '').slice(0, 120),
      amount: Math.round(amount * 100) / 100, currency: String(r.currency || 'USD').slice(0, 8).toUpperCase(),
      date, category: String(r.category || '').slice(0, 60), dept: r.dept || null, project: String(r.project || '').slice(0, 80),
      verified: false, note: String(r.note || '').slice(0, 300), createdAt: Date.now(),
    };
    const all = read();
    // duplicate accounting records are refused: same kind+source+ref+amount+day already filed
    const day = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
    if (all.some(x => x.kind === rec.kind && x.source === rec.source && x.ref === rec.ref && x.amount === rec.amount && day(x.date) === day(rec.date)))
      throw new Error('this exact record is already filed (same kind, source, reference, amount and day)');
    all.push(rec); write(all);
    return rec;
  }
  function verify(id) {
    const all = read(); const r = all.find(x => x.id === id);
    if (!r) return null;
    r.verified = true; r.verifiedAt = Date.now(); write(all);
    return r;
  }
  const remove = id => { const all = read(); const n = all.length; const out = all.filter(x => x.id !== id); write(out); return out.length !== n; };

  function metrics({ from = 0, to = Infinity, dept = null } = {}) {
    const recs = read().filter(r => r.date >= from && r.date <= to && (!dept || r.dept === dept));
    const v = recs.filter(r => r.verified);
    const revenue = v.filter(r => r.kind === 'revenue').reduce((n, r) => n + r.amount, 0);
    const expenses = v.filter(r => r.kind === 'expense').reduce((n, r) => n + r.amount, 0);
    // completed tasks in the period (success only — failures consumed cost but delivered nothing)
    const tasks = (getTasks() || []).filter(t => t.state === 'done' && !t.error && (t.doneAt || 0) >= from && (t.doneAt || 0) <= to && (!dept || t.dept === dept));
    const rows = usageRows(from, to).filter(r => !dept || r.dept === dept);
    const runs = rows.length;
    const apiCostAllPriced = runs > 0 && rows.every(r => r.costUsd != null);
    const apiCost = apiCostAllPriced ? Math.round(rows.reduce((n, r) => n + (r.costUsd || 0), 0) * 10000) / 10000 : null;
    const tokens = rows.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0);
    // department costs: attribution from the real per-run rows (estimated when pricing exists)
    const byDeptCost = {};
    for (const r of rows) {
      const d = byDeptCost[r.dept || 'unattributed'] = byDeptCost[r.dept || 'unattributed'] || { runs: 0, tokens: 0, costUsd: null };
      d.runs++; d.tokens += r.tokensIn + r.tokensOut;
      if (r.costUsd != null) d.costUsd = (d.costUsd || 0) + r.costUsd; else d.costUsd = null;
    }
    return {
      period: { from, to },
      currency: recs.length ? recs[0].currency : 'USD',
      records: { total: recs.length, verified: v.length, unverified: recs.length - v.length },
      revenue: Math.round(revenue * 100) / 100,
      expenses: Math.round(expenses * 100) / 100,
      actualProfit: Math.round((revenue - expenses) * 100) / 100,
      revenueBasis: `verified revenue records in the period (${v.filter(r => r.kind === 'revenue').length} records)`,
      profitBasis: 'recognized revenue − recognized expenses (verified records only)',
      // no lead/pipeline source exists in this stack — say so instead of inventing numbers
      leads: null, qualifiedLeads: null, conversionRate: null, pipelineValue: null,
      leadsNote: 'No lead/CRM integration is connected — connect one to record leads and pipeline',
      completedTasks: tasks.length,
      apiRuns: runs,
      apiTokens: tokens,
      apiCost, apiCostNote: apiCost == null
        ? (runs ? 'runs in this period used models with no configured price — cost unavailable' : 'no model usage in this period')
        : 'estimated from recorded token counts × configured pricing',
      costPerCompletedTask: tasks.length ? (apiCost != null
        ? { value: Math.round((apiCost / tasks.length) * 10000) / 10000, basis: 'estimated API cost ÷ completed tasks in the period' }
        : { value: null, tokensPerTask: Math.round(tokens / tasks.length), basis: 'pricing not configured — showing tokens per completed task instead' }) : null,
      deptCosts: byDeptCost,
    };
  }
  const list = () => read();
  function exportCsv({ from = 0, to = Infinity } = {}) {
    const rows = read().filter(r => r.date >= from && r.date <= to);
    const head = 'id,kind,source,ref,amount,currency,date,category,dept,project,verified,note';
    const esc = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
    return [head, ...rows.map(r => [r.id, r.kind, r.source, r.ref, r.amount, r.currency, new Date(r.date).toISOString(), r.category, r.dept, r.project, r.verified ? 'yes' : 'no', r.note].map(esc).join(','))].join('\n');
  }
  return { add, verify, remove, list, metrics, exportCsv };
}
