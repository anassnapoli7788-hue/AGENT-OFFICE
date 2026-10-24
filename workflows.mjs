// workflows.mjs — the Brain's orchestration engine (V3.9, Feature 2).
//
// A workflow: an objective the owner (or the Brain panel) hands the office. The engine asks
// Claude for a structured plan (bounded: at most 5 steps, each with a title, the work, a
// department, an agent and dependencies), creates REAL tasks in data/tasks.json wired with
// `workflowId` + `dependsOn`, and dispatches them as their dependencies complete — through the
// same runServerTask the bar and the routines use, under the same Pause-All gate, budgets and
// autonomy levels. Bounded retries (a failed step retries once automatically only when its
// previous run could not have had an external side effect; anything that ran after an approval
// needs the owner's explicit acknowledgement). When every step is in, the Brain synthesizes a
// final report from the real results and files it as a note in the brain.
//
// Idempotent creation: the same objective text with a live workflow returns the existing one —
// a page refresh or a resubmitted request never starts a duplicate. State survives a restart:
// everything is read back from data/workflows.json + data/tasks.json.
import fs from 'node:fs';
import path from 'node:path';

const MAX_STEPS = 5;
const AUTO_RETRY_MAX = 1;      // a failed step retries once on its own, at most
const MAX_MANUAL_RETRY = 3;

export function initWorkflows(deps) {
  const { dataDir, DEPTS, DEPT_KEYS, getAgents, ask, parseJSON, guessNeedsOk,
          loadTasks, saveTasks, nid, runTask, isPaused, pausedAgents, autonomy,
          maxConcurrent, writeWorkflowNote, ops } = deps;
  const FILE = path.join(dataDir, 'workflows.json');
  const read = () => { try { const v = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } };
  const write = v => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(v, null, 2)); };
  const now = () => Date.now();
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ');
  const leadOf = dept => getAgents().find(a => a.department === dept && a.lead) || getAgents().find(a => a.department === dept);
  const agentById = id => getAgents().find(a => a.id === id);

  /* ---------- planning: one structured JSON plan from the objective ---------- */
  function rosterText() {
    return DEPT_KEYS.map(k => `${DEPTS[k].name} (${k}): ` + getAgents().filter(a => a.department === k)
      .map(a => `${a.id}${a.lead ? ' (lead)' : ''} · ${a.name} · ${a.role || a.does || ''}`).join(' | ')).join('\n');
  }
  async function planObjective(objective) {
    const system = 'You are the Brain of an AI company. Break the objective into a structured plan of independent-or-sequential steps that the company\'s agents will really execute. Return ONLY a JSON object — no prose, no code fences.';
    const user = `Objective: "${objective}"\n\nThe company's departments and agents:\n${rosterText()}\n\n` +
      `Return: {"why":"<one sentence on the approach>","steps":[{"title":"<imperative, max 70 chars>","text":"<the full instruction for the agent, one paragraph>","dept":"<a dept key: ${DEPT_KEYS.join('|')}>","agent":"<an agent id from that department>","dependsOn":[<0-based indices of earlier steps that must finish first>],"needs_ok":<true if this step would send, post, pay, delete or change anything outside this machine>}]}\n` +
      `Rules: 1 to ${MAX_STEPS} steps. dependsOn only refers to earlier steps. Prefer the agent whose role fits; the department lead is the safe default.`;
    const j = parseJSON(await ask(system, user, { maxTokens: 1200, timeout: 150000, model: 'sonnet' }));
    const steps = (Array.isArray(j.steps) ? j.steps : []).slice(0, MAX_STEPS).map((s, i) => {
      const dept = DEPT_KEYS.includes(s.dept) ? s.dept : null;
      if (!dept) return null;
      const agent = (typeof s.agent === 'string' && agentById(s.agent)?.department === dept) ? s.agent : leadOf(dept).id;
      const dependsOn = (Array.isArray(s.dependsOn) ? s.dependsOn : []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d < i);
      return { title: String(s.title || objective).slice(0, 90), text: String(s.text || s.title || objective).slice(0, 1200), dept, agent, dependsOn: [...new Set(dependsOn)], needsOk: typeof s.needs_ok === 'boolean' ? s.needs_ok : guessNeedsOk(String(s.text || s.title || '')) };
    }).filter(Boolean);
    if (!steps.length) throw new Error('the plan came back with no usable steps');
    return { why: String(j.why || '').slice(0, 300), steps };
  }

  /* ---------- creation (idempotent) ---------- */
  async function create({ objective, title }) {
    objective = norm(objective);
    if (!objective) throw new Error('an objective is required');
    const existing = read().find(w => w.objective === objective && ['planning', 'running', 'paused', 'blocked', 'waiting'].includes(w.state));
    if (existing) return { workflow: enrich(existing), existing: true };
    const wf = { id: 'wf_' + nid(), objective, title: norm(title || objective).slice(0, 90), state: 'planning', createdAt: now(), updatedAt: now(), why: '', stepIds: [], report: null, error: null, blockers: [], history: [] };
    const all = read(); all.unshift(wf); write(all);
    ops.emit('workflow.created', { workflowId: wf.id, title: `Workflow started: ${wf.title}`, detail: objective.slice(0, 200), status: 'planning' });
    let plan;
    try { plan = await planObjective(objective); }
    catch (e) { // no plan, no workflow — honest failure, never a fabricated plan
      wf.state = 'failed'; wf.error = `planning failed: ${e.message}`; wf.updatedAt = now(); write(all);
      ops.emit('workflow.failed', { workflowId: wf.id, severity: 'error', title: `Workflow failed to plan: ${wf.title}`, detail: wf.error, status: 'failed' });
      return { workflow: enrich(wf), error: wf.error };
    }
    // the steps become real tasks, wired together
    const tasks = loadTasks();
    const ids = [];
    plan.steps.forEach((s, i) => {
      const t = { id: nid(), dept: s.dept, agent: s.agent, title: s.title, text: s.text, plan: [], eta: 20, why: `workflow step ${i + 1}`, state: 'next', addedAt: now(), by: 'brain', workflowId: wf.id, dependsOn: s.dependsOn.map(d => ids[d]).filter(Boolean), priority: Math.max(0, MAX_STEPS - i), needsOk: s.needsOk, retryCount: 0 };
      ids.push(t.id); tasks.push(t);
    });
    saveTasks(tasks);
    Object.assign(wf, { state: 'running', why: plan.why, stepIds: ids, history: [...wf.history, { at: now(), what: `planned: ${ids.length} steps — ${plan.why}` }] });
    wf.updatedAt = now(); write(all);
    for (const id of ids) ops.hooks.taskCreated(tasks.find(t => t.id === id), {});
    ops.emit('workflow.running', { workflowId: wf.id, title: `Workflow running: ${wf.title}`, detail: `${ids.length} steps · ${plan.why}`, status: 'running' });
    tick();
    return { workflow: enrich(wf) };
  }

  /* ---------- the dispatcher: runs on a tick and after every task completion ---------- */
  const taskOf = id => loadTasks().find(t => t.id === id);
  function inFlight() { return loadTasks().filter(t => t.workflowId && t.state === 'doing').length; }
  function stepReady(t, tasks) {
    if (t.state !== 'next' || t.wfDispatched) return false;
    return (t.dependsOn || []).every(d => { const dep = tasks.find(x => x.id === d); return dep && dep.state === 'done' && !dep.error; });
  }
  function stepBlockedBy(t, tasks) {
    const out = [];
    for (const d of t.dependsOn || []) {
      const dep = tasks.find(x => x.id === d);
      if (dep && dep.state === 'done' && dep.error) out.push({ taskId: d, title: dep.title });
    }
    return out;
  }
  function tick() {
    if (isPaused()) return; // Pause All stops dispatch; running steps finish on their own
    const wfs = read();
    const tasks = loadTasks();
    const cap = Math.max(1, maxConcurrent());
    let dispatched = 0;
    for (const wf of wfs) {
      if (wf.state !== 'running') continue;
      const steps = wf.stepIds.map(taskOf).filter(Boolean);
      // blocked: an upstream step failed for good
      for (const s of steps) {
        const blockers = stepBlockedBy(s, tasks);
        if (blockers.length && (s.retryCount || 0) >= AUTO_RETRY_MAX + 1) {
          wf.state = 'blocked'; wf.blockers = blockers; wf.updatedAt = now();
          wf.history.push({ at: now(), what: `blocked: ${blockers.map(b => b.title).join(', ')} failed` });
          ops.emit('workflow.blocked', { workflowId: wf.id, severity: 'warning', title: `Workflow blocked: ${wf.title}`, detail: blockers.map(b => b.title).join(', ') + ' failed and the downstream steps wait on the owner', status: 'blocked' });
          break;
        }
      }
      if (wf.state !== 'running') { write(wfs); continue; }
      // waiting for approval shows on the workflow itself
      if (steps.some(s => s.state === 'waiting')) { wf.waitingOn = steps.filter(s => s.state === 'waiting').map(s => s.title); }
      else wf.waitingOn = [];
      // dispatch ready steps, highest priority first, while concurrency allows and agents are free
      const busyAgents = new Set(tasks.filter(t => t.state === 'doing').map(t => t.agent));
      const ready = steps.filter(s => stepReady(s, tasks))
        .filter(s => !busyAgents.has(s.agent) && !pausedAgents()[s.agent] && autonomy.get(s.agent) !== 'read_only')
        .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.addedAt - b.addedAt);
      for (const s of ready) {
        if (inFlight() + dispatched >= cap) break;
        s.wfDispatched = true; s.state = 'next';
        saveTasks(loadTasks().map(t => t.id === s.id ? s : t));
        dispatched++;
        wf.history.push({ at: now(), what: `dispatched step: ${s.title}` });
        wf.updatedAt = now();
        runTask(s.id); // the same runServerTask everything else uses
      }
      // all steps done → the report
      if (steps.length && steps.every(s => s.state === 'done' && !s.error)) {
        wf.state = 'synthesizing'; wf.updatedAt = now(); write(wfs);
        finish(wf.id).catch(e => { const w = read().find(x => x.id === wf.id); if (w) { w.state = 'failed'; w.error = 'report failed: ' + e.message; write(read()); } });
        continue;
      }
      write(wfs);
    }
  }

  /* ---------- the final report: synthesized from the real step results ---------- */
  async function finish(id) {
    const wfs = read(); const wf = wfs.find(w => w.id === id);
    if (!wf) return null;
    const steps = wf.stepIds.map(taskOf).filter(Boolean);
    const evidence = steps.map(s => `## ${s.title} (${agentById(s.agent)?.name || s.agent})\n${String(s.result || '').slice(0, 1200)}`).join('\n\n');
    try {
      const system = 'You are the Brain of an AI company. Write the final report of a completed workflow from the real step results below. Plain text: a one-line outcome, then what was done (a bullet per step, naming the agent), then conclusions and recommended next actions. At most 250 words. Never invent results that are not in the evidence.';
      const out = await ask(system, `Objective: ${wf.objective}\n\nStep results:\n${evidence}`, { maxTokens: 1500, model: 'sonnet' });
      wf.report = out.trim();
    } catch (e) { wf.report = `(The report could not be synthesized: ${e.message}. The step results are on the tasks.)`; wf.reportError = e.message; }
    wf.state = 'completed'; wf.completedAt = now(); wf.updatedAt = now();
    wf.history.push({ at: now(), what: 'completed — report written' });
    write(wfs);
    try { if (writeWorkflowNote) writeWorkflowNote(wf); } catch {}
    ops.emit('workflow.completed', { workflowId: wf.id, title: `Workflow completed: ${wf.title}`, detail: (wf.report || '').slice(0, 300), status: 'done' });
    return wf;
  }

  /* ---------- controls ---------- */
  function pause(id) { const wfs = read(); const wf = wfs.find(w => w.id === id); if (!wf || !['running', 'blocked'].includes(wf.state)) return null; wf.state = 'paused'; wf.updatedAt = now(); wf.history.push({ at: now(), what: 'paused — new dispatches stop; runs in flight finish on their own' }); write(wfs); ops.emit('workflow.paused', { workflowId: id, severity: 'warning', title: `Workflow paused: ${wf.title}`, status: 'paused' }); return wf; }
  function resume(id) { const wfs = read(); const wf = wfs.find(w => w.id === id); if (!wf || wf.state !== 'paused') return null; wf.state = 'running'; wf.updatedAt = now(); wf.history.push({ at: now(), what: 'resumed' }); write(wfs); ops.emit('workflow.resumed', { workflowId: id, title: `Workflow resumed: ${wf.title}`, status: 'running' }); tick(); return wf; }
  function cancel(id) {
    const wfs = read(); const wf = wfs.find(w => w.id === id);
    if (!wf || ['completed', 'cancelled', 'failed'].includes(wf.state)) return null;
    const tasks = loadTasks(); let stopped = 0, inFlight = [];
    for (const s of wf.stepIds.map(taskOf).filter(Boolean)) {
      if (s.state === 'doing') inFlight.push(s.title); // cannot be interrupted mid-run — reported honestly
      else if (s.state !== 'done') { const t = tasks.find(t => t.id === s.id); t.state = 'cancelled'; t.cancelledAt = now(); stopped++; ops.hooks.taskCancelled(t); }
    }
    saveTasks(tasks);
    wf.state = 'cancelled'; wf.cancelledAt = now(); wf.updatedAt = now();
    wf.history.push({ at: now(), what: `cancelled: ${stopped} steps cancelled${inFlight.length ? `, ${inFlight.length} left to finish on their own (${inFlight.join(', ')})` : ''}` });
    write(wfs);
    ops.emit('workflow.cancelled', { workflowId: id, title: `Workflow cancelled: ${wf.title}`, detail: inFlight.length ? `runs already in flight were not interrupted: ${inFlight.join(', ')}` : '', status: 'cancelled' });
    return wf;
  }
  // retry a failed step. Refused when the previous run may have had an external side effect
  // (it ran after an approval) unless the owner explicitly acknowledges that risk.
  function retryStep(id, taskId, { ackSideEffects = false } = {}) {
    const wfs = read(); const wf = wfs.find(w => w.id === id);
    if (!wf) throw new Error('no such workflow');
    const tasks = loadTasks(); const t = tasks.find(x => x.id === taskId && x.workflowId === id);
    if (!t) throw new Error('no such step');
    if (t.state !== 'done' || !t.error) throw new Error('only a failed step can be retried');
    if ((t.retryCount || 0) >= MAX_MANUAL_RETRY) throw new Error(`this step already retried ${t.retryCount} times`);
    if (t.approved && !ackSideEffects) throw new Error('this step ran after your approval and may already have acted outside this machine — retry with ackSideEffects to confirm you accept that risk');
    t.retryCount = (t.retryCount || 0) + 1; t.state = 'next'; t.error = false; t.lastError = t.result; t.result = undefined; t.wfDispatched = false; t.approved = false; t.doneAt = undefined;
    saveTasks(tasks);
    if (wf.state === 'failed' || wf.state === 'blocked') { wf.state = 'running'; wf.blockers = []; }
    wf.history.push({ at: now(), what: `step retried: ${t.title} (attempt ${t.retryCount + 1})` });
    wf.updatedAt = now(); write(wfs);
    ops.emit('workflow.retry', { workflowId: id, taskId, title: `Step retry: ${t.title}`, detail: `attempt ${t.retryCount + 1}`, status: 'queued' });
    tick();
    return wf;
  }
  // a step failed → one automatic retry when the failed run could not have had side effects
  function onTaskDone(task) {
    if (!task.workflowId) return;
    const wfs = read(); const wf = wfs.find(w => w.id === task.workflowId);
    if (!wf) return;
    if (task.state === 'done' && task.error) {
      const sideEffects = !!task.approved; // a run after approval may have acted externally
      if (!sideEffects && (task.retryCount || 0) < AUTO_RETRY_MAX) {
        const tasks = loadTasks(); const t = tasks.find(x => x.id === task.id);
        if (t) { t.retryCount = (t.retryCount || 0) + 1; t.state = 'next'; t.error = false; t.wfDispatched = false; t.result = `(auto-retry after failure: ${String(task.result || '').slice(0, 200)})`; saveTasks(tasks); wf.history.push({ at: now(), what: `auto-retry ${t.retryCount}: ${t.title}` }); write(wfs); tick(); return; }
      }
      wf.history.push({ at: now(), what: `step failed: ${task.title} — ${sideEffects ? 'ran after approval, needs the owner to retry' : 'no more automatic retries'}` });
    }
    write(wfs);
    tick(); // a finished step may unblock the next one
  }
  function setPriority(id, taskId, priority) {
    const p = Math.max(0, Math.min(9, Number(priority)));
    if (!Number.isInteger(p)) throw new Error('priority must be an integer 0–9');
    const tasks = loadTasks(); const t = tasks.find(x => x.id === taskId && x.workflowId === id);
    if (!t) throw new Error('no such step');
    t.priority = p; saveTasks(tasks);
    return p;
  }

  /* ---------- reads for the panels ---------- */
  function enrich(wf) {
    const tasks = loadTasks();
    const steps = wf.stepIds.map(id => tasks.find(t => t.id === id)).filter(Boolean).map(t => ({
      id: t.id, title: t.title, agent: t.agent, agentName: agentById(t.agent)?.name || t.agent, dept: t.dept,
      state: t.state, needsOk: !!t.needsOk, priority: t.priority || 0, retryCount: t.retryCount || 0,
      dependsOn: t.dependsOn || [], error: t.error ? String(t.result || '').slice(0, 200) : null,
      waitingReason: t.state === 'next'
        ? (t.dependsOn || []).some(d => { const dep = tasks.find(x => x.id === d); return dep && !(dep.state === 'done' && !dep.error); }) ? 'waiting on dependencies'
          : t.wfDispatched ? 'dispatched' : pausedAgents()[t.agent] ? 'agent paused' : isPaused() ? 'orchestration paused' : autonomy.get(t.agent) === 'read_only' ? 'agent is read-only' : 'queued'
        : null,
      startedAt: t.startedAt || null, doneAt: t.doneAt || null,
    }));
    return { ...wf, steps };
  }
  const list = () => read().map(enrich);
  const get = id => { const wf = read().find(w => w.id === id); return wf ? enrich(wf) : null; };

  return { create, tick, pause, resume, cancel, retryStep, onTaskDone, setPriority, list, get };
}
