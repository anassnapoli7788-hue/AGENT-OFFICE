// Agents Office — Agent Teams (V3.2 (16 Sep), 16 Sep 2026).
//
// A team task is one the department LEAD splits across its own desks: the lead plans the pieces,
// the teammates work them at the same time, each in its own Claude session with its own context,
// tools and skills, they leave notes for each other and for the lead, and the lead writes the
// finished deliverable from the pieces. Same shape as Claude Code's agent teams (lead · teammates
// · shared task list · messages) — built by the office, because Claude Code only spawns its own
// teammates in an interactive terminal, never in the headless `claude -p` runs the office makes
// (code.claude.com/docs/en/agent-teams, "Enable agent teams"). What runs here is real: one Claude
// process per teammate, in parallel, on your login.
//
//   intent(text)                 → the owner asked for a team in the sentence
//   planPrompt(...)              → the lead's planning call (Sonnet, JSON out)
//   parsePlan(text, …)           → the pieces, checked against the department's seats
//   teamSection(...)             → what a teammate is told about the team, its piece, the notes
//   parseMessages(text, ids)     → strip `@id: …` note lines off a piece; they go to the mailbox
//   synthPrompt(...)             → the lead's final call: pieces + notes → one deliverable
//   noteExtra(team, nameOf)      → the pieces and the notes, appended to the note in the brain
export const DEFAULTS = { enabled: true, max: 4 };

export function settings(cfg) {
  const t = { ...DEFAULTS, ...((cfg && cfg.teams) || {}) };
  t.enabled = t.enabled !== false;
  t.max = Math.min(6, Math.max(2, parseInt(t.max, 10) || DEFAULTS.max));
  return t;
}

// "as a team", "team up", "get the team on it", "spawn three teammates", "split it across the desks"
const INTENT = /\b(as a team|team up|team this|get the (whole )?team|the (whole )?team (on|to|should|can)|with the team|(spawn|use|get) (\d+|two|three|four|five|a few|some) teammates?|\d+ teammates|split (it|this|the work) (up|across|between)|teammates|team:|whole department)\b/i;
export const intent = text => INTENT.test(String(text || ''));

const num = { two: 2, three: 3, four: 4, five: 5, six: 6 };
export function askedSize(text) { // "spawn three teammates" → 3, else null
  const m = /\b(?:spawn|use|get|with)\s+(\d+|two|three|four|five|six)\s+teammates?\b/i.exec(String(text || ''));
  if (!m) return null; const n = num[m[1].toLowerCase()] || parseInt(m[1], 10); return Number.isFinite(n) ? n : null;
}

export function planPrompt({ business, deptName, lead, seats, text, title, max, notes }) {
  const system = `You are ${lead.name}, the lead of the ${deptName} department of ${business}. You are splitting one request across your team. ` +
    'Return ONLY a JSON object — no prose, no code fences.';
  const user = `Your team (id · name · role · what they do${seats.some(s => s.skills?.length) ? ' · skills' : ''}):\n` +
    seats.map(s => `- ${s.id}${s.lead ? ' (you, the lead)' : ''} · ${s.name} · ${s.role} · ${s.does}${s.skills?.length ? ' · skills: ' + s.skills.join(', ') : ''}`).join('\n') +
    `\n\nThe owner's request: "${text}"${title && title !== text ? `\n(Task title: ${title})` : ''}\n\n` +
    (notes ? `Company notes you may use to split it well:\n${notes}\n\n` : '') +
    `The owner asked for a TEAM, so split the request into 2 to ${max} INDEPENDENT pieces that can be done at the same time, each owned by a different desk whose job or skills fit it — never one piece. ` +
    'When the request is one job in parts (three angles, three emails, three sections), give each part to a different desk with the whole brief so the parts stay distinct; when it is one indivisible thing, give the making to one desk and a different lens to another (a check against the brand voice, the customer\'s view, the numbers, the risks). ' +
    'You may take one piece yourself. Do not invent work the owner did not ask for. Each piece\'s text is a complete instruction the teammate can act on alone, with what the owner said that matters to it.\n' +
    'Return: {"pieces":[{"agent":"<id>","title":"<imperative title, max 70 characters>","text":"<the instruction>"}],"why":"<one short sentence on how you split it>"}';
  return { system, user };
}

function parseJSON(text) {
  const s = String(text || '').replace(/```json|```/g, ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON');
  return JSON.parse(s.slice(a, b + 1));
}

/** The lead's JSON → pieces on real seats. Unknown seats are dropped, a seat gets one piece
 *  (first wins), the count is capped at max. One valid piece → that desk does it (solo); none → the lead does it alone. */
export function parsePlan(text, { seats, lead, max = DEFAULTS.max, fallback = {} }) {
  let j; try { j = parseJSON(text); } catch { j = {}; }
  const ids = new Set(seats.map(s => s.id));
  const pieces = [], taken = new Set();
  for (const p of Array.isArray(j.pieces) ? j.pieces : []) {
    const agent = String(p?.agent || '').trim(), t = String(p?.text || '').trim();
    if (!ids.has(agent) || taken.has(agent) || !t) continue;
    taken.add(agent);
    pieces.push({ agent, title: String(p.title || t).trim().slice(0, 90), text: t.slice(0, 2000) });
    if (pieces.length >= max) break;
  }
  if (pieces.length === 1) return { pieces, why: String(j.why || '').slice(0, 200), solo: true }; // the lead named one desk: that desk does it, the lead writes it up
  if (!pieces.length) return { pieces: [{ agent: lead.id, title: String(fallback.title || fallback.text || 'The task').slice(0, 90), text: String(fallback.text || '') }], why: '', solo: true };
  return { pieces, why: String(j.why || '').slice(0, 200), solo: false };
}

/** What a teammate reads about the team. `me` may be the lead taking a piece. */
export function teamSection({ me, lead, pieces, nameOf }) {
  const mine = pieces.find(p => p.agent === me.id);
  const others = pieces.filter(p => p.agent !== me.id);
  const ids = [...new Set(['lead', ...pieces.map(p => p.agent)])].filter(x => x !== me.id);
  return 'TEAM\n' +
    `You are working as part of a team led by ${nameOf(lead.id)}${me.id === lead.id ? ' (you)' : ''}. Each teammate does one piece at the same time; the lead then writes the finished deliverable from all the pieces.\n` +
    `Your piece: ${mine ? mine.title : '(none)'}\n` +
    (others.length ? 'The other pieces, so you do not repeat them:\n' + others.map(p => `- ${nameOf(p.agent)}: ${p.title}`).join('\n') + '\n' : '') +
    'Do only your piece, completely. Write it as the finished thing, not a plan. At most 220 words unless a skill sets a shape.\n' +
    `To leave a note for a teammate or the lead (a fact they need, a clash, a question), end with one line per note in exactly this form: "@${ids[0] || 'lead'}: the note" — ids: ${ids.join(', ')}. Notes reach the lead before the final is written. No notes if none are needed.`;
}

/** Split `@id: …` lines off the end (or anywhere) of a piece. ids = who can be addressed; "lead" is always allowed. */
export function parseMessages(text, ids = []) {
  const ok = new Set([...ids, 'lead']);
  const messages = [], keep = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*@([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m && ok.has(m[1])) { messages.push({ to: m[1], text: m[2].slice(0, 400) }); continue; }
    keep.push(line);
  }
  return { body: keep.join('\n').replace(/\n{3,}/g, '\n\n').trim(), messages };
}

export function synthPrompt({ task, pieces, messages, nameOf, feedback }) {
  const parts = pieces.map(p => `--- ${nameOf(p.agent)} — ${p.title} ---\n${p.error ? '(could not complete: ' + (p.result || 'no result') + ')' : (p.result || '(empty)')}`).join('\n\n');
  const notes = (messages || []).length ? '\n\nNOTES THE TEAM LEFT\n' + messages.map(m => `- ${nameOf(m.from)} → ${m.to === 'lead' ? 'you' : nameOf(m.to)}: ${m.text}`).join('\n') : '';
  return `Task: ${task.title}\nOwner's request: ${task.text}\n\nYour team has done the pieces below. Write the finished deliverable from them: keep the substance, cut repetition, resolve any clash using the notes, and fill only what is plainly missing (mark it (assumed)). ` +
    'Plain text: a short heading, then short sections or bullets. At most 450 words unless a skill or the owner\'s instructions set a different shape — those win. ' +
    'End with one line: "Team: NAME did X · NAME did Y".' +
    `\n\nTHE PIECES\n${parts}${notes}` +
    (feedback ? `\n\nThe owner reviewed your previous version and asked for changes: "${feedback}"\nPrevious version:\n${task.result}` : '');
}

export function noteExtra(team, nameOf) {
  if (!team || !team.pieces?.length) return '';
  let s = '\n\n---\n## Team\n' + team.pieces.map(p => `- ${nameOf(p.agent)} (${p.agent}): ${p.title}${p.error ? ' — could not complete' : ''}`).join('\n');
  if (team.messages?.length) s += '\n\n### Notes between teammates\n' + team.messages.map(m => `- ${nameOf(m.from)} → ${m.to === 'lead' ? 'lead' : nameOf(m.to)}: ${m.text}`).join('\n');
  for (const p of team.pieces) s += `\n\n### ${nameOf(p.agent)} — ${p.title}\n${p.result || '(no result)'}`;
  return s;
}

/** Run fn over items with at most n in flight. */
export async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
