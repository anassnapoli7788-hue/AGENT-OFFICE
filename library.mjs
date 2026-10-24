// library.mjs — the knowledge library (V3.9, Feature 8): approved documents the agents
// retrieve when they work, with versions, categories, tags, access control and search.
//
// Files live in the owner's own brain: <brain>/Agents Office/library/<id>.v<n>.md — the same
// vault the agents already read — and the index is data/library.json. Upload is text-only in
// this release (markdown/plain text/CSV/JSON pasted or posted as content): binary formats are
// refused with a clear message rather than half-supported. Size cap 512 KB, filename is
// server-generated (no user path ever touches the disk), executable extensions are refused.
//
// Document status (quality): approved (the owner verified it) · unverified (new or
// agent-generated) · historical (kept for the record, not given to agents as current) ·
// superseded (replaced by a newer document). Nothing silently overwrites an approved
// document: a new version keeps the old ones on disk and in the index.
//
// Access: 'agents' documents are merged into the vault index the agents read (approved and
// unverified are retrievable — unverified labelled so; historical/superseded are not);
// 'owner' documents are never given to the agents. Enforced here, server-side.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 512 * 1024;
const CATEGORIES = ['sop', 'project', 'research', 'faq', 'template', 'lessons', 'strategy', 'decisions', 'output', 'reference', 'other'];

export function initLibrary({ dataDir, brainDir }) {
  const DIR = path.join(brainDir, 'Agents Office', 'library');
  const FILE = path.join(dataDir, 'library.json');
  const read = () => { try { const v = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(v.docs) ? v.docs : []; } catch { return []; } };
  const write = docs => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ docs }, null, 2)); };
  const nid = () => 'doc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = () => Date.now();

  const fileFor = (id, n) => path.join(DIR, `${id}.v${n}.md`);

  function validateContent(content) {
    if (typeof content !== 'string' || !content.trim()) throw new Error('content is required (text/markdown)');
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error(`content is over the ${MAX_BYTES / 1024} KB cap`);
    if (/\u0000/.test(content)) throw new Error('binary content is not accepted — paste text or markdown');
    if (/<\s*\/??\s*(script|iframe|object|embed|form)\b|javascript:/i.test(content)) throw new Error('unsafe content: executable markup (script/iframe/…) is not accepted — paste plain text or markdown');
  }
  function add({ title, content, category = 'other', tags = [], access = 'agents', status = 'unverified', note = '' }) {
    validateContent(content);
    title = String(title || '').trim().slice(0, 120);
    if (!title) throw new Error('title is required');
    if (!CATEGORIES.includes(category)) throw new Error(`category must be one of: ${CATEGORIES.join(', ')}`);
    if (!['agents', 'owner'].includes(access)) throw new Error('access must be agents or owner');
    const id = nid();
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(fileFor(id, 1), content, 'utf8');
    const doc = {
      id, title, category, tags: (Array.isArray(tags) ? tags : String(tags).split(',')).map(t => String(t).trim()).filter(Boolean).slice(0, 12),
      owner: 'owner', access, status: status === 'approved' ? 'unverified' : status, // new documents start unverified — approval is an explicit owner action
      createdAt: now(), updatedAt: now(), current: 1,
      versions: [{ n: 1, at: now(), bytes: Buffer.byteLength(content, 'utf8'), note: String(note || 'created').slice(0, 200) }],
    };
    const docs = read(); docs.unshift(doc); write(docs);
    return doc;
  }
  function addVersion(id, { content, note = '' }) {
    const docs = read(); const doc = docs.find(d => d.id === id);
    if (!doc) throw new Error('no such document');
    validateContent(content);
    const n = (doc.versions[doc.versions.length - 1]?.n || 0) + 1;
    fs.writeFileSync(fileFor(id, n), content, 'utf8');
    doc.versions.push({ n, at: now(), bytes: Buffer.byteLength(content, 'utf8'), note: String(note || `version ${n}`).slice(0, 200) });
    doc.current = n; doc.updatedAt = now();
    // a content change never silently keeps an "approved" label
    if (doc.status === 'approved') doc.status = 'unverified';
    write(docs);
    return doc;
  }
  function patch(id, p = {}) {
    const docs = read(); const doc = docs.find(d => d.id === id);
    if (!doc) throw new Error('no such document');
    if (typeof p.title === 'string' && p.title.trim()) doc.title = p.title.trim().slice(0, 120);
    if (typeof p.category === 'string' && CATEGORIES.includes(p.category)) doc.category = p.category;
    if (Array.isArray(p.tags)) doc.tags = p.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 12);
    if (p.access === 'agents' || p.access === 'owner') doc.access = p.access;
    if (typeof p.status === 'string') {
      if (!['unverified', 'approved', 'historical', 'superseded'].includes(p.status)) throw new Error('status must be unverified, approved, historical or superseded');
      if (p.status === 'approved' && doc.status !== 'approved') doc.approvedAt = now(); // the owner's explicit verification
      doc.status = p.status;
      if (p.status === 'superseded' && p.supersededBy) doc.supersededBy = p.supersededBy;
    }
    doc.updatedAt = now();
    write(docs);
    return doc;
  }
  function remove(id) {
    const docs = read(); const n = docs.length;
    const out = docs.filter(d => d.id !== id);
    if (out.length === n) return false;
    write(out);
    for (const v of (docs.find(d => d.id === id)?.versions || [])) { try { fs.rmSync(fileFor(id, v.n)); } catch {} }
    return true;
  }
  function content(id, n) {
    const doc = read().find(d => d.id === id);
    if (!doc) throw new Error('no such document');
    const ver = doc.versions.find(v => v.n === Number(n)) || doc.versions.find(v => v.n === doc.current);
    if (!ver) throw new Error('no such version');
    let text; try { text = fs.readFileSync(fileFor(id, ver.n), 'utf8'); } catch { throw new Error('the file for this version is missing from the brain'); }
    return { doc, version: ver, text };
  }
  function list({ q = '', category = '', tag = '', includeDeleted } = {}) {
    let docs = read();
    if (category) docs = docs.filter(d => d.category === category);
    if (tag) docs = docs.filter(d => d.tags.includes(tag));
    if (q) {
      const needle = String(q).toLowerCase();
      docs = docs.map(d => {
        let text = '';
        try { text = fs.readFileSync(fileFor(d.id, d.current), 'utf8').toLowerCase(); } catch {}
        const inTitle = d.title.toLowerCase().includes(needle), inTags = d.tags.some(t => t.toLowerCase().includes(needle)), inText = text.includes(needle);
        if (!inTitle && !inTags && !inText) return null;
        let snippet = '';
        if (inText) { const i = text.indexOf(needle); snippet = text.slice(Math.max(0, i - 60), i + 90).replace(/\s+/g, ' ').trim(); }
        return { ...d, match: inTitle ? 'title' : inTags ? 'tag' : 'body', snippet };
      }).filter(Boolean);
    }
    return docs.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const get = id => read().find(d => d.id === id) || null;
  const categories = () => CATEGORIES;
  // what the agents may retrieve: access 'agents' + a status that means "current knowledge".
  // Approved and unverified are both retrievable (unverified is labelled in the prompt);
  // historical and superseded are not — they are kept for people, not for tasks.
  function agentIndex() {
    const out = new Map();
    for (const d of read()) {
      if (d.access !== 'agents') continue;
      if (!['approved', 'unverified'].includes(d.status)) continue;
      try { out.set(`library/${d.title}`, { text: fs.readFileSync(fileFor(d.id, d.current), 'utf8'), title: d.title, status: d.status, category: d.category }); } catch {}
    }
    return out;
  }
  return { add, addVersion, patch, remove, content, list, get, categories, agentIndex };
}
