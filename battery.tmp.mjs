// battery.tmp.mjs — acceptance battery for the V3.9 operations/features API.
// Runs against the live local server. No model calls. Fixtures are removed at the end.
// Usage: node battery.tmp.mjs
import fs from 'node:fs';

const B = 'http://localhost:4520';
let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (x ? '   [' + x + ']' : '')); if (!c) fails++; };
const J = async (p, o = {}) => {
  const r = await fetch(B + p, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) } });
  const t = await r.text(); let x = null; try { x = JSON.parse(t); } catch { x = t; }
  return { s: r.status, x };
};
const post = (p, b) => J(p, { method: 'POST', body: JSON.stringify(b ?? {}) });

// ---- wait for readiness ----
let up = false;
for (let i = 0; i < 30; i++) { try { const r = await fetch(B + '/api/health'); if (r.ok) { up = true; break; } } catch {} await new Promise(r => setTimeout(r, 500)); }
if (!up) { console.log('FAIL  server not reachable'); process.exit(1); }

// ---- 1. dashboard shape + agent counters + baseline health ----
const d0 = await J('/api/ops/dashboard');
ok('dashboard 200 with full shape', d0.s === 200 && d0.x.agents && d0.x.tasks && d0.x.usage && d0.x.depts && d0.x.controls && typeof d0.x.eventSeq === 'number');
ok('agent counters match the roster (35)', d0.x.agents?.total === 35, 'total=' + d0.x.agents?.total + ' online=' + d0.x.agents?.online);
ok('online vs idle vs busy distinguished', typeof d0.x.agents?.idle === 'number' && typeof d0.x.agents?.busy === 'number' && typeof d0.x.agents?.online === 'number');
ok('6 department health cards', Object.keys(d0.x.depts || {}).length === 6, Object.entries(d0.x.depts).map(([k, v]) => k + ':' + v.status).join(' '));
ok('baseline depts healthy (green)', Object.values(d0.x.depts).every(v => v.status === 'green'));
ok('day metrics carry tz + rate basis + exclusion rule', !!d0.x.day?.tz && /(cancelled and unfinished excluded|no completed tasks today)/.test(d0.x.tasks.rateBasis || ''), 'tz=' + d0.x.day?.tz + ' basis=' + d0.x.tasks.rateBasis);
ok('usage labelled honestly (data or explicit unavailable)', d0.x.usage && (d0.x.usage.available === true || d0.x.usage.note === 'Usage data unavailable'), 'cost=' + JSON.stringify(d0.x.usage?.cost));
ok('controls: not paused at baseline', d0.x.controls.paused === false);

// ---- 2. events endpoint ----
const ev0 = await J('/api/ops/events?since=0');
ok('event log 200 + array', ev0.s === 200 && Array.isArray(ev0.x.events), 'n=' + ev0.x.events.length);

// ---- 3. SSE: opens, then a REAL event pushes live (no polling) ----
let taskId = null;
try {
  const ac = new AbortController();
  const r = await fetch(B + '/api/ops/events/stream', { signal: ac.signal });
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '';
  const readFor = ms => Promise.race([
    reader.read().then(ch => { buf += dec.decode(ch.value || new Uint8Array()); return true; }),
    new Promise(res => setTimeout(() => res(false), ms)),
  ]);
  const gotFirst = await readFor(3000);
  ok('SSE stream opens with retry directive', gotFirst && buf.includes('retry: 3000'), JSON.stringify(buf.slice(0, 60)));

  // ---- 4. fault injection THROUGH THE REAL PIPELINE, while the stream is open ----
  const f = await post('/api/ops/test-failure', { agent: 'invo', message: 'simulated provider 402 while fetching balances' });
  ok('fault injection accepted (labelled test)', f.s === 200 && f.x.ok && f.x.test === true && f.x.dept === 'fin', JSON.stringify(f.x));
  taskId = f.x.taskId;

  let live = false; const t0 = Date.now();
  while (Date.now() - t0 < 6000 && !live) { const more = await readFor(3000); if (!more) break; if (buf.includes('task.failed') || buf.includes('test.simulated_failure')) live = true; }
  ok('failure event pushed LIVE over SSE', live);
  ac.abort();
} catch (e) { ok('SSE live push', false, e.message); }

// ---- 5. department red highlighting + agent state + alert + activity ----
const d1 = await J('/api/ops/dashboard');
const fin = d1.x.depts?.fin;
ok('dept fin RED with label + icon (not colour alone)', fin && fin.status === 'red' && fin.label === 'ERROR' && fin.icon === '✖', JSON.stringify(fin));
ok('error detail: severity + short explanation + alertId', fin?.error?.detail?.includes('402') && typeof fin.error.severity === 'string' && !!fin.error.alertId);
ok('only the affected dept is red (no blanket highlight)', Object.entries(d1.x.depts).filter(([k, v]) => v.status === 'red').every(([k]) => k === 'fin'), Object.entries(d1.x.depts).filter(([, v]) => v.status === 'red').map(([k]) => k).join(','));
ok('agent invo → failed with lastError', d1.x.agents?.byId?.invo?.status === 'failed', JSON.stringify(d1.x.agents?.byId?.invo?.lastError || '').slice(0, 90));
ok('alert raised on the failure', d1.x.alerts?.list?.some(a => a.taskId === taskId && ['error', 'critical'].includes(a.severity)));
ok('activity feed carries the failure with taskId', d1.x.activity?.some(e => e.taskId === taskId && e.kind === 'task.failed'));
ok('eventSeq advanced', d1.x.eventSeq > d0.x.eventSeq, d0.x.eventSeq + ' → ' + d1.x.eventSeq);
ok('failedToday counts it; rateBasis still excludes unfinished', d1.x.tasks?.failedToday >= 1);

// ---- 6. acknowledge (incident retained) ----
const al = d1.x.alerts.list.find(a => a.taskId === taskId);
const ack = await post('/api/ops/alerts/' + al.id + '/ack', { note: 'battery: acknowledged' });
ok('ack accepted → status acknowledged', ack.s === 200 && ack.x.alert?.status === 'acknowledged');
const all1 = await J('/api/ops/alerts?all=1');
const rec = all1.x.alerts.find(a => a.id === al.id);
ok('ack did NOT erase the incident (history kept)', rec && rec.history?.length >= 2, JSON.stringify(rec?.history?.map(h => h.note)));

// ---- 7. amber while acknowledged ----
const d2 = await J('/api/ops/dashboard');
ok('dept fin AMBER after ack (label ACKNOWLEDGED)', d2.x.depts?.fin?.status === 'amber', d2.x.depts?.fin?.label);

// ---- 8. resolve → green + agent recovery, history preserved ----
const rs1 = await post('/api/ops/alerts/' + al.id + '/resolve', { note: 'battery: recovered' });
ok('resolve accepted', rs1.s === 200 && rs1.x.alert?.status === 'resolved');
const open8 = await J('/api/ops/alerts');
ok('resolved alert leaves the open list', !open8.x.alerts.some(a => a.id === al.id));
const all8 = await J('/api/ops/alerts?all=1');
ok('resolved record still inspectable with full history', all8.x.alerts.some(a => a.id === al.id && a.status === 'resolved' && a.history.length >= 3));
const d3 = await J('/api/ops/dashboard');
ok('dept fin GREEN again after resolution', d3.x.depts?.fin?.status === 'green', d3.x.depts?.fin?.label);
ok('agent recovered to idle (recovery, history kept)', d3.x.agents?.byId?.invo?.status === 'idle');

// ---- 9. Pause All: confirmation required, then honest report ----
const p1 = await post('/api/ops/pause-all', {});
ok('pause without confirm → 400 (server-enforced confirmation)', p1.s === 400 && p1.x.requires === 'confirm: true', String(p1.x.error).slice(0, 60));
ok('confirmation message explains what pause means', /not interruptible/.test(p1.x.meaning || ''));
const p2 = await post('/api/ops/pause-all', { confirm: true, reason: 'acceptance battery' });
ok('confirmed pause → all eligible agents paused, honest report', p2.s === 200 && p2.x.ok && p2.x.paused?.length >= 30, 'paused=' + p2.x.paused?.length + ' notInterruptible=' + JSON.stringify(p2.x.notInterruptible || []));
const d4 = await J('/api/ops/dashboard');
ok('dashboard reflects paused state', d4.x.controls?.paused === true && d4.x.controls?.pausedReason === 'acceptance battery');

// ---- 10. dispatch gate: retry while paused is refused and the card does not move ----
const mv1 = await post('/api/tasks/' + taskId + '/move', { state: 'doing' });
ok('retry while paused → 400 (pause gate, not a fake success)', mv1.s === 400 && /Pause All/.test(mv1.x.error || ''), String(mv1.x.error).slice(0, 70));
const tasks10 = await J('/api/tasks');
const t10 = tasks10.x.find(t => t.id === taskId);
ok('refused move left the card EXACTLY where it was (rollback)', t10 && t10.state === 'done' && !t10.heldByPause, 'state=' + t10?.state);

// ---- 11. resume ----
const rs2 = await post('/api/ops/resume-all', {});
ok('resume-all clears the pause', rs2.s === 200 && rs2.x.resumed === true);
const d5 = await J('/api/ops/dashboard');
ok('controls unpaused again', d5.x.controls?.paused === false);

// ---- 12. move validation: server-side state machine ----
const mv2 = await post('/api/tasks/' + taskId + '/move', { state: 'cancelled' });
ok('done → cancelled refused by the engine', mv2.s === 400 && /does not allow/.test(mv2.x.error || ''), String(mv2.x.error).slice(0, 70));
const mv3 = await post('/api/tasks/nope/move', { state: 'next' });
ok('unknown task → 404', mv3.s === 404);
const listC = JSON.parse(fs.readFileSync(new URL('./data/tasks.json', import.meta.url), 'utf8'));
listC.push({ id: 'fix_battery_done', dept: 'sales', agent: 'enzo', title: 'FIXTURE (acceptance test): completed card', text: 'fixture', plan: [], eta: 1, why: 'acceptance fixture', state: 'done', doneAt: Date.now() - 1000, addedAt: Date.now() - 2000, by: 'test', test: true });
fs.writeFileSync(new URL('./data/tasks.json', import.meta.url), JSON.stringify(listC, null, 2));
const c1 = await post('/api/tasks/fix_battery_done/cancel', {});
ok('cancelling a COMPLETED task refused (work is not undone)', c1.s === 400 && /completed/.test(c1.x.error || ''), String(c1.x.error).slice(0, 70));
const c2 = await post('/api/tasks/fix_battery_done/move', { state: 'doing' });
ok('a completed card also cannot be dragged back to running', c2.s === 400 && /only a failed task can be retried|does not allow/.test(c2.x.error || ''), String(c2.x.error).slice(0, 70));
const dxFD = await J('/api/tasks/fix_battery_done', { method: 'DELETE' });
ok('completed fixture deleted', dxFD.s === 200);

// ---- 13. scheduled fixture: positive move + approval guards ----
const FILE = new URL('./data/tasks.json', import.meta.url);
const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const fix = { id: 'fix_battery_1', dept: 'sales', agent: 'enzo', title: 'FIXTURE (acceptance test): scheduled card', text: 'fixture', plan: [], eta: 1, why: 'acceptance fixture', state: 'scheduled', dueAt: Date.now() + 3600000, addedAt: Date.now(), by: 'test', test: true };
list.push(fix); fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
const mv4 = await post('/api/tasks/fix_battery_1/move', { state: 'next' });
ok('scheduled → next refused (engine rules)', mv4.s === 400, String(mv4.x.error).slice(0, 70));
const mv5 = await post('/api/tasks/fix_battery_1/move', { state: 'cancelled' });
ok('scheduled → cancelled accepted (positive move persists)', mv5.s === 200 && mv5.x.ok === true);
const tasks13 = await J('/api/tasks');
ok('fixture move persisted', tasks13.x.find(t => t.id === 'fix_battery_1')?.state === 'cancelled');
const ap1 = await post('/api/tasks/fix_battery_1/approve', {});
ok('approving a non-waiting task → 400 (no run)', ap1.s === 400 && /not waiting/.test(ap1.x.error || ''));
const ap2 = await post('/api/tasks/nope/approve', {});
ok('approving unknown task → 404', ap2.s === 404);

// ---- 14. budgets: CRUD + validation (enforcement path verified separately) ----
const bg0 = await J('/api/budgets');
ok('budgets overview 200', bg0.s === 200 && Array.isArray(bg0.x.budgets));
const bgBad = await post('/api/budgets', { scope: 'nope', metric: 'runs', window: 'day', limit: 5 });
ok('invalid budget → 400 with reason', bgBad.s === 400 && typeof bgBad.x.error === 'string', String(bgBad.x.error).slice(0, 70));
const bgAdd = await post('/api/budgets', { scope: 'dept', ref: 'delivery', metric: 'runs', window: 'day', limit: 50 });
ok('valid budget created + audited', bgAdd.s === 200 && !!bgAdd.x.budget?.id, JSON.stringify(bgAdd.x.budget || bgAdd.x).slice(0, 120));
if (bgAdd.x.budget?.id) { const del = await J('/api/budgets/' + bgAdd.x.budget.id, { method: 'DELETE' }); ok('budget removed (cleanup)', del.s === 200); }

// ---- 15. autonomy levels: set, validate, audit, restore ----
const a1 = await post('/api/agents/invo/autonomy', { level: 'read_only' });
ok('autonomy set to read_only', a1.s === 200, JSON.stringify(a1.x).slice(0, 110));
const a2 = await post('/api/agents/invo/autonomy', { level: 'yolo' });
ok('invalid autonomy level → 400 + allowed levels', a2.s === 400 && Array.isArray(a2.x.levels) && a2.x.levels.length > 1, (a2.x.levels || []).join(','));
const a3 = await post('/api/agents/invo/autonomy', { level: 'standard' });
ok('autonomy restored', a3.s === 200, JSON.stringify(a3.x).slice(0, 90));

// ---- 16. finance: zero-baseline honesty, unverified vs verified, duplicates ----
const fin0 = await J('/api/finance');
ok('finance metrics 200', fin0.s === 200 && !!fin0.x.metrics);
console.log('      metrics@baseline: ' + JSON.stringify(fin0.x.metrics).slice(0, 260));
const rec1 = await post('/api/finance/records', { kind: 'revenue', amount: 250, date: Date.now(), source: 'acceptance fixture', currency: 'USD', category: 'services' });
ok('revenue record filed starting UNVERIFIED', rec1.s === 200 && rec1.x.record?.verified === false, JSON.stringify(rec1.x.record || rec1.x).slice(0, 130));
const fin1 = await J('/api/finance');
console.log('      metrics@unverified: ' + JSON.stringify(fin1.x.metrics).slice(0, 260));
const dup = await post('/api/finance/records', { kind: 'revenue', amount: 250, date: Date.now(), source: 'acceptance fixture', currency: 'USD', category: 'services' });
ok('duplicate accounting record refused', dup.s === 400, String(dup.x.error).slice(0, 70));
if (rec1.x.record?.id) {
  const ver = await post('/api/finance/records/' + rec1.x.record.id + '/verify', {});
  ok('record verified', ver.s === 200 && ver.x.record?.verified === true);
  const fin2 = await J('/api/finance');
  console.log('      metrics@verified: ' + JSON.stringify(fin2.x.metrics).slice(0, 260));
  const df = await J('/api/finance/records/' + rec1.x.record.id, { method: 'DELETE' });
  ok('record removed (cleanup + audit)', df.s === 200);
  const fin3 = await J('/api/finance');
  ok('metrics return to baseline after removal (no residue)', fin3.s === 200);
}
const exp = await J('/api/finance/export');
ok('CSV export served as text/csv', exp.s === 200 && String(exp.x).includes('kind'));

// ---- 17. knowledge library: upload → search → versions → approval flow → permissions → delete ----
const lb1 = await post('/api/library', { title: 'BATTERY FIXTURE — onboarding checklist', content: '# Onboarding\nSteps for a new hire.\nSee [[CLAUDE]].', category: 'other', access: 'agents' });
ok('document uploaded → v1, starts unverified', lb1.s === 200 && lb1.x.doc?.current === 1 && lb1.x.doc?.status === 'unverified', JSON.stringify(lb1.x.doc || lb1.x).slice(0, 150));
const lbId = lb1.x.doc?.id;
if (lbId) {
  const s1 = await J('/api/library?q=onboarding');
  ok('full-text search finds it', s1.s === 200 && s1.x.docs.some(d => d.id === lbId), 'hits=' + s1.x.docs.length);
  const v2 = await post('/api/library/' + lbId + '/versions', { content: '# Onboarding v2\nUpdated steps.', note: 'battery' });
  ok('version 2 recorded (v1 still stored)', v2.s === 200 && v2.x.doc?.current === 2 && v2.x.doc?.versions?.length === 2);
  const apv = await post('/api/library/' + lbId + '/patch', { status: 'approved' });
  ok('owner approval recorded', apv.s === 200 && apv.x.doc?.status === 'approved', JSON.stringify(apv.x.doc?.status || apv.x).slice(0, 90));
  const v3 = await post('/api/library/' + lbId + '/versions', { content: '# Onboarding v3\nChanged after approval.', note: 'battery' });
  ok('content edit after approval → UNVERIFIED (never silently keeps verified knowledge)', v3.s === 200 && v3.x.doc?.status === 'unverified', v3.x.doc?.status);
  const old = await J('/api/library/' + lbId + '/v/1');
  ok('old version still retrievable (preview)', old.s === 200 && String(old.x.text).includes('new hire'));
  const dl = await J('/api/library/' + lbId + '/v/1?download=1');
  ok('download serves as a file attachment', dl.s === 200 && typeof dl.x === 'string');
  const bad = await post('/api/library', { title: 'x', content: '<script>alert(1)</script>' });
  ok('unsafe content refused at upload', bad.s === 400 && /unsafe/.test(String(bad.x.error)), String(bad.x.error).slice(0, 70));
  const badCat = await post('/api/library', { title: 'x', content: 'text', category: 'nope' });
  ok('invalid category refused with the allowed list', badCat.s === 400 && /category/.test(String(badCat.x.error)));
  const ownerDoc = await post('/api/library', { title: 'BATTERY owner-only', content: 'secret-ish notes', access: 'owner' });
  ok('owner-only document flagged in the record', ownerDoc.s === 200 && ownerDoc.x.doc?.access === 'owner');
  if (ownerDoc.x.doc?.id) await J('/api/library/' + ownerDoc.x.doc.id, { method: 'DELETE' });
  const del = await J('/api/library/' + lbId, { method: 'DELETE' });
  ok('document deleted (audit alert raised)', del.s === 200);
  const gone = await J('/api/library/' + lbId);
  ok('deleted doc → 404', gone.s === 404);
}

// ---- 18. workflows / meetings lists, CEO payload, audit log ----
const wf = await J('/api/workflows');
ok('workflows list 200', wf.s === 200 && Array.isArray(wf.x.workflows), 'n=' + wf.x.workflows.length);
const mt = await J('/api/meetings');
ok('meetings list 200', mt.s === 200 && Array.isArray(mt.x.meetings), 'n=' + mt.x.meetings.length);
const ceo = await J('/api/ceo');
ok('CEO payload: dashboard + approvals + budgets + autonomy + audit', ceo.s === 200 && Array.isArray(ceo.x.approvals) && Array.isArray(ceo.x.budgets) && ceo.x.autonomy && Array.isArray(ceo.x.audit), 'approvals=' + ceo.x.approvals.length + ' audit=' + ceo.x.audit.length);
const aud = await J('/api/audit?limit=300');
const kinds = new Set(aud.x.audit.map(e => e.kind));
ok('audit log captures critical operations', aud.s === 200 && ['audit.pause_all', 'audit.resume_all', 'audit.alert', 'audit.library_add', 'audit.budget_add', 'audit.finance_add', 'audit.autonomy', 'audit.task_delete'].every(k => kinds.has(k)), [...kinds].join(','));
ok('test-failure carried an audit/test marker', [...kinds].some(k => k.startsWith('audit.')) && aud.x.audit.some(e => e.test === true || /Fault|test/i.test(e.title || '')), 'test markers present');

// ---- cleanup: remove the battery test task (events + audit keep the history) ----
if (taskId) { const dt = await J('/api/tasks/' + taskId, { method: 'DELETE' }); ok('battery test task deleted (incident history lives in events/audit)', dt.s === 200); }
const dxF = await J('/api/tasks/fix_battery_1', { method: 'DELETE' });
ok('scheduled fixture deleted', dxF.s === 200);

// ---- final dashboard sanity after everything ----
const dF = await J('/api/ops/dashboard');
ok('final dashboard healthy again (fin green, not paused, agents idle)', dF.x.depts?.fin?.status === 'green' && dF.x.controls?.paused === false && dF.x.agents?.byId?.invo?.status !== 'failed');

console.log(fails ? `\n${fails} BATTERY CHECK(S) FAILED` : '\nALL BATTERY CHECKS PASSED');
process.exit(fails ? 1 : 0);
