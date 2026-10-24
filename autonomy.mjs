// autonomy.mjs — per-agent permission levels (V3.9, CEO panel · Safe autonomy).
//
// Levels (server-enforced at task creation and at dispatch):
//   read_only      — the agent takes no new work; creating a task for it is refused
//   draft_only     — every task for this agent waits for the owner's OK, whatever the router said
//   standard       — the router's needs_ok decides (the office's default behaviour)
//   low_risk_auto  — read-only tasks (needs_ok=false) run on their own, as standard
//   elevated       — same rules as standard: high-impact actions ALWAYS follow their own
//                    approval rules; no autonomy level bypasses an approval requirement
//
// Stored in data/autonomy.json — plain JSON, the office's own persistence pattern.
import fs from 'node:fs';
import path from 'node:path';

export const AUTONOMY_LEVELS = ['read_only', 'draft_only', 'standard', 'low_risk_auto', 'elevated'];
export const DEFAULT_LEVEL = 'standard';

export function initAutonomy({ dataDir }) {
  const FILE = path.join(dataDir, 'autonomy.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
  const write = v => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(v, null, 2)); };

  function get(id) { return read()[id] || DEFAULT_LEVEL; }
  function set(id, level) {
    if (!AUTONOMY_LEVELS.includes(level)) throw new Error(`level must be one of: ${AUTONOMY_LEVELS.join(', ')}`);
    const all = read(); all[id] = level; write(all);
    return { id, level };
  }
  function all() { return read(); }
  // what a new task for this agent must do. Refusals and forced approvals are enforced here,
  // server-side — the frontend only reads the same answer to explain itself.
  function forTask(agentId, routedNeedsOk) {
    const level = get(agentId);
    if (level === 'read_only') return { level, refuse: 'This agent is set to READ-ONLY (CEO panel → Autonomy). It takes no new work until you change its level.' };
    return { level, refuse: null, needsOk: level === 'draft_only' ? true : !!routedNeedsOk };
  }
  return { get, set, all, forTask, levels: AUTONOMY_LEVELS, default: DEFAULT_LEVEL };
}
