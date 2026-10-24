// meetings.mjs — the virtual meeting room (V3.9, Feature 9): a real, bounded workflow.
//
// A meeting: a title, an objective, an agenda, the participants (the Brain proposes them from
// the roster by role and department, or the owner picks), a deadline and a contribution budget.
// Each participant contributes in their own persona through a real Claude turn (the same askX
// the office's tasks use), the contributions and the evidence they cite are persisted, then the
// Brain combines them into decisions, open questions and action items. Action items become REAL
// tasks on the participants' desks (through the same creation path as the bar, under the same
// autonomy rules — a meeting can never bypass an approval requirement).
//
// Bounds: maxRounds (default 1), a wall-clock deadline, a token budget estimated from real
// usage, and a refusal to re-run a finished meeting. Repeated or contradictory contributions
// are surfaced by the synthesis step, not silently merged. Stored in data/meetings.json.
import fs from 'node:fs';
import path from 'node:path';

const MAX_PARTICIPANTS = 4;
const DEFAULT_BUDGET_TOKENS = 60000;

export function initMeetings(deps) {
  const { dataDir, DEPTS, DEPT_KEYS, getAgents, ask, askPersona, parseJSON, nid,
          createTask, guessNeedsOk, ops } = deps;
  const FILE = path.join(dataDir, 'meetings.json');
  const read = () => { try { const v = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } };
  const write = v => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(v, null, 2)); };
  const now = () => Date.now();
  const agentById = id => getAgents().find(a => a.id === id);
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ');

  /* ---------- participant selection: the Brain proposes; the owner can override ---------- */
  async function selectParticipants(objective, agenda, dept) {
    const seats = getAgents().map(a => `${a.id} · ${a.name} · ${a.department} · ${a.role || ''} · ${a.does || ''}`).join('\n');
    const system = 'You are the Brain of an AI company choosing the participants for a working meeting. Pick the agents whose role fits the objective — never more than one per department unless the objective truly needs it. Return ONLY a JSON object.';
    const user = `Objective: "${objective}"\n${agenda ? `Agenda:\n${agenda}\n` : ''}${dept ? `Suggested department: ${DEPTS[dept]?.name}\n` : ''}\nAgents:\n${seats}\n\nReturn: {"participants":["<agent id>", …],"why":"<one sentence>"}`;
    const j = parseJSON(await ask(system, user, { maxTokens: 500, timeout: 150000, model: 'sonnet' }));
    let ids = (Array.isArray(j.participants) ? j.participants : []).map(String).filter(id => agentById(id));
    ids = [...new Set(ids)].slice(0, MAX_PARTICIPANTS);
    if (!ids.length) throw new Error('no usable participants proposed');
    return { participants: ids, why: String(j.why || '') };
  }

  /* ---------- creation ---------- */
  async function create({ title, objective, agenda = '', dept = null, participants = null, deadlineMinutes = 30, maxRounds = 1, budgetTokens = DEFAULT_BUDGET_TOKENS }) {
    objective = norm(objective);
    if (!objective) throw new Error('an objective is required');
    if (dept && !DEPT_KEYS.includes(dept)) throw new Error('unknown department');
    const m = {
      id: 'mtg_' + nid(), title: norm(title || objective).slice(0, 90), objective, agenda: String(agenda || '').slice(0, 2000),
      dept: dept || null, status: 'planned', round: 0, maxRounds: Math.max(1, Math.min(3, Number(maxRounds) || 1)),
      participants: [], participantsWhy: '', contributions: [], decisions: [], openQuestions: [], actionItems: [],
      createdAt: now(), deadlineAt: now() + Math.max(5, Number(deadlineMinutes) || 30) * 60000,
      budgetTokens: Math.max(10000, Number(budgetTokens) || DEFAULT_BUDGET_TOKENS), usedTokens: 0, runs: 0,
      finishedAt: null, stoppedReason: null, history: [],
    };
    const all = read(); all.unshift(m); write(all);
    ops.emit('meeting.created', { meetingId: m.id, dept, title: `Meeting scheduled: ${m.title}`, detail: objective.slice(0, 200), status: 'planned' });
    if (Array.isArray(participants) && participants.length) {
      m.participants = [...new Set(participants.map(String))].filter(id => agentById(id)).slice(0, MAX_PARTICIPANTS);
      m.participantsWhy = 'picked by the owner';
      if (!m.participants.length) throw new Error('none of those participants are on the roster');
    } else {
      try { const p = await selectParticipants(objective, agenda, dept); m.participants = p.participants; m.participantsWhy = p.why; }
      catch (e) { const lead = getAgents().find(a => a.department === (dept || DEPT_KEYS[0]) && a.lead); m.participants = [lead.id]; m.participantsWhy = `selection fell back to the lead (${e.message})`; }
    }
    m.status = 'planned'; write(all);
    return m;
  }

  /* ---------- running the meeting: real turns, persisted contributions, hard bounds ---------- */
  async function run(id) {
    const all = read(); const m = all.find(x => x.id === id);
    if (!m) throw new Error('no such meeting');
    if (m.status === 'running') throw new Error('this meeting is already running');
    if (['done', 'stopped', 'cancelled'].includes(m.status)) throw new Error(`this meeting is ${m.status}`);
    m.status = 'running'; m.startedAt = now(); write(all);
    ops.emit('meeting.started', { meetingId: m.id, dept: m.dept, title: `Meeting running: ${m.title}`, detail: `participants: ${m.participants.map(p => agentById(p)?.name || p).join(', ')}`, status: 'running' });
    const overBudget = () => m.usedTokens > m.budgetTokens || now() > m.deadlineAt;
    const stop = reason => {
      m.status = 'stopped'; m.stoppedReason = reason; m.finishedAt = now();
      write(all);
      ops.emit('meeting.stopped', { meetingId: m.id, severity: 'warning', title: `Meeting stopped: ${m.title}`, detail: reason, status: 'stopped' });
    };
    try {
      for (let round = 1; round <= m.maxRounds; round++) {
        m.round = round;
        for (const pid of m.participants) {
          if (overBudget()) { stop(now() > m.deadlineAt ? 'the deadline passed before every contribution landed' : 'the token budget ran out before every contribution landed'); return m; }
          const a = agentById(pid);
          const prior = m.contributions.slice(-6).map(c => `${agentById(c.agent)?.name || c.agent}: ${c.text.slice(0, 300)}`).join('\n');
          const prompt = `We are in a structured working meeting: "${m.title}".\nObjective: ${m.objective}\n${m.agenda ? `Agenda:\n${m.agenda}\n` : ''}` +
            (prior ? `\nWhat has been said so far:\n${prior}\n` : '') +
            `\nYou are ${a.name}, ${a.role || 'an agent'} in ${DEPTS[a.department].name}. ${a.does || ''}\nContribute your part in under 150 words: what your department brings to this objective, grounded in what you know. If a previous contribution is wrong or repeats yours, say so plainly. End with one line "ACTION: <one concrete action you will own>" or "ACTION: none".`;
          const res = await askPersona(pid, prompt);
          m.runs++; m.usedTokens += res.tokens || 0;
          const text = (res.text || '').trim();
          const action = /^ACTION:\s*(.+)$/m.exec(text)?.[1]?.trim() || null;
          m.contributions.push({ agent: pid, round, at: now(), text, action, tools: res.tools || [] });
          write(all);
          ops.hooks.comm(pid, 'brain', { meetingId: m.id, title: `${a.name} contributes to "${m.title}"`, detail: text.slice(0, 160), status: 'completed' });
          ops.emit('meeting.contribution', { meetingId: m.id, agent: pid, dept: a.department, title: `${a.name} contributed`, detail: text.slice(0, 160), status: 'done' });
        }
      }
      // the Brain combines: decisions, open questions, action items — from the real contributions
      if (overBudget()) { stop('the bounds were reached before the synthesis could run'); return m; }
      const system = 'You are the Brain of an AI company, chairing a meeting. Combine the participants\' contributions into the meeting outcome. Return ONLY a JSON object.';
      const user = `Objective: ${m.objective}\n\nContributions:\n${m.contributions.map(c => `${agentById(c.agent)?.name || c.agent}: ${c.text}`).join('\n\n')}\n\n` +
        `Return: {"decisions":["<decision, one sentence each>"],"openQuestions":["<unresolved, one sentence each>"],"actionItems":[{"title":"<imperative, max 70 chars>","agent":"<agent id from the participants>","text":"<the full instruction>"}],"summary":"<the meeting in three sentences, user-facing: what was decided and why — no hidden reasoning>"}\n` +
        'Mark repeated or contradictory contributions in openQuestions. Action items only for the participants, and only where a concrete next step exists.';
      const j = parseJSON(await ask(system, user, { maxTokens: 1400, timeout: 150000, model: 'sonnet' }));
      m.decisions = (Array.isArray(j.decisions) ? j.decisions : []).map(String).slice(0, 12);
      m.openQuestions = (Array.isArray(j.openQuestions) ? j.openQuestions : []).map(String).slice(0, 12);
      m.summary = String(j.summary || '').slice(0, 800);
      m.runs++; write(all);
      // action items become real tasks (under the office's normal rules: approvals still apply)
      const items = (Array.isArray(j.actionItems) ? j.actionItems : []).filter(x => x && m.participants.includes(String(x.agent))).slice(0, 6);
      for (const it of items) {
        try {
          const t = createTask({ agent: String(it.agent), title: String(it.title || 'Meeting action').slice(0, 90), text: String(it.text || it.title).slice(0, 1200), by: 'meeting', meetingId: m.id, needsOk: guessNeedsOk(String(it.text || '')) });
          m.actionItems.push({ title: t.title, agent: t.agent, taskId: t.id, state: t.state });
        } catch (e) { m.actionItems.push({ title: String(it.title || ''), agent: String(it.agent || ''), error: e.message }); }
      }
      m.status = 'done'; m.finishedAt = now(); write(all);
      ops.emit('meeting.completed', { meetingId: m.id, dept: m.dept, title: `Meeting concluded: ${m.title}`, detail: `${m.decisions.length} decisions · ${m.actionItems.length} action items`, status: 'done' });
      return m;
    } catch (e) {
      m.status = 'failed'; m.error = String(e.message || e); m.finishedAt = now(); write(all);
      ops.emit('meeting.failed', { meetingId: m.id, severity: 'error', title: `Meeting failed: ${m.title}`, detail: m.error, status: 'failed' });
      return m;
    }
  }
  function cancel(id) {
    const all = read(); const m = all.find(x => x.id === id);
    if (!m || ['done', 'cancelled'].includes(m.status)) return null;
    m.status = 'cancelled'; m.finishedAt = now(); write(all);
    ops.emit('meeting.cancelled', { meetingId: id, title: `Meeting cancelled: ${m.title}`, status: 'cancelled' });
    return m;
  }
  const list = () => read();
  const get = id => read().find(x => x.id === id) || null;
  return { create, run, cancel, list, get };
}
