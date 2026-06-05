// =============================================================================
// Ingest real (already-happened) sessions for judgement.
//
// A real visit export is just { messages: [{ type, content, memberName,
// isGreeting }] } (the app's visit JSON). We convert it into the same
// `turns` / `rendered` shape the judges consume, tagged source: "real" with no
// scenario/persona, and store it under real/ (gitignored — it's private user
// data). Judge it with the standing rubric via `harness judge --real`.
//
//   harness ingest --file <visit.json | dir-of-json>
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REAL_DIR } from './config.js';
import { fullTranscriptText } from './store.js';

const PASS_RE = /^pass\b[\s.!,:;-]*/i;

// Group consecutive voice messages (a primary + debaters + the Keeper's
// synthesis) that follow a user turn into one "system turn", since a real visit
// stores them as a flat sequence of {memberName, content} messages.
export function visitToTranscript(visit, { label, origin }) {
  const messages = Array.isArray(visit) ? visit : visit.messages || [];
  const turns = [];
  let voiceBuf = [];
  const flush = () => {
    if (!voiceBuf.length) return;
    const rendered = voiceBuf
      .filter((m) => m.content && !PASS_RE.test(String(m.content).trim()))
      .map((m) => `${m.memberName || 'voice'}: ${String(m.content).trim()}`)
      .join('\n\n');
    turns.push({ role: 'sut', kind: 'chat', rendered });
    voiceBuf = [];
  };
  for (const m of messages) {
    if (!m || !m.content) continue;
    if (m.type === 'user') {
      flush();
      turns.push({ role: 'user', text: m.content });
    } else if (m.isGreeting) {
      flush();
      turns.push({ role: 'keeper', kind: 'greeting', text: m.content, rendered: m.content.trim() });
    } else {
      voiceBuf.push(m); // a voice / keeper-synthesis message
    }
  }
  flush();

  return {
    source: 'real',
    id: label,
    origin,
    visitId: (visit && visit.id) ?? null,
    name: (visit && visit.name) ?? null,
    ingestedAt: new Date().toISOString(),
    sensitive: false, // unknown until judged; the crisis check will flag it
    turns,
    rendered: fullTranscriptText(turns),
  };
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}

async function ingestOne(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  let visit;
  try {
    visit = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${filePath}: not valid JSON (${e.message})`);
  }
  const base = path.basename(filePath).replace(/\.json$/i, '');
  const label = sanitize(visit?.id != null ? `${base}-visit${visit.id}` : base);
  const t = visitToTranscript(visit, { label, origin: filePath });
  if (t.turns.length === 0) throw new Error(`${filePath}: no messages found`);
  await fs.mkdir(REAL_DIR, { recursive: true });
  const out = path.join(REAL_DIR, `${label}.json`);
  await fs.writeFile(out, JSON.stringify(t, null, 2));
  return { out, turns: t.turns.length, label };
}

export async function runIngest({ file } = {}) {
  if (!file) throw new Error('ingest needs --file <visit.json | directory>');
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) throw new Error(`no such path: ${file}`);

  const files = stat.isDirectory()
    ? (await fs.readdir(file)).filter((f) => f.endsWith('.json')).map((f) => path.join(file, f))
    : [file];
  if (files.length === 0) throw new Error(`no .json files under ${file}`);

  for (const f of files) {
    try {
      const r = await ingestOne(f);
      process.stdout.write(`ingested ${r.label} (${r.turns} turns) → ${path.relative(process.cwd(), r.out)}\n`);
    } catch (e) {
      process.stdout.write(`! skipped ${f}: ${e.message}\n`);
    }
  }
  process.stdout.write(`\nNow judge them: harness judge --real\n`);
}
