// =============================================================================
// Transcript Store. Full, version-stamped transcripts on disk, plus the helpers
// that render a turn / a whole transcript into the readable form the judges and
// human reviewers consume.
//
//   runs/<versionKey>/<scenarioId>/<personaId>/<repeatIndex>.json
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RUNS_DIR } from './config.js';

const PASS_RE = /^pass\b[\s.!,:;-]*/i;

// Render an SUT chat turn (the structured `done` payload) into readable text
// with voice names resolved and PASS debaters dropped.
export function renderSutPayload(payload) {
  const parts = [];
  if (payload.primaryMemberName && payload.primaryResponseText) {
    parts.push(`${payload.primaryMemberName}: ${payload.primaryResponseText.trim()}`);
  }
  for (const d of payload.debateMembers || []) {
    const t = (d.responseText || '').trim();
    if (t && !PASS_RE.test(t)) parts.push(`${d.memberName}: ${t}`);
  }
  if (payload.moderatorSummary) {
    parts.push(`The Keeper (synthesis): ${payload.moderatorSummary.trim()}`);
  }
  if (payload.actionPlan) {
    const plan = typeof payload.actionPlan === 'string' ? payload.actionPlan : JSON.stringify(payload.actionPlan, null, 2);
    parts.push(`[Action plan proposed]\n${plan}`);
  }
  return parts.join('\n\n');
}

// Join turns into a single readable transcript string for judging / review.
export function fullTranscriptText(turns) {
  const blocks = [];
  for (const t of turns) {
    if (t.role === 'user') blocks.push(`USER: ${t.text}`);
    else if (t.role === 'keeper') blocks.push(`THE KEEPER (greeting): ${(t.text || '').trim()}`);
    else if (t.role === 'sut') blocks.push(`--- system turn ---\n${t.rendered || ''}`);
  }
  return blocks.join('\n\n');
}

// Just the user side — for the simulated-user validation gate (§3.3).
export function userSideText(transcript) {
  return (transcript.turns || [])
    .filter((t) => t.role === 'user')
    .map((t, i) => `[user turn ${i + 1}] ${t.text}`)
    .join('\n\n');
}

export function transcriptPath(versionKey, scenarioId, personaId, repeatIndex) {
  return path.join(RUNS_DIR, versionKey, scenarioId, personaId, `${repeatIndex}.json`);
}

export async function writeTranscript(transcript) {
  const p = transcriptPath(transcript.versionKey, transcript.scenarioId, transcript.personaId, transcript.repeatIndex);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(transcript, null, 2));
  return p;
}

export async function readTranscript(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

// The raw per-visit LLM debug log, archived next to its transcript so a failed
// run (e.g. an off-format mega-batch the parser rejects) stays debuggable after
// the throwaway user is gone. Read it with `zcat`/`gunzip` (multi-member gzip).
export function debugLogPath(versionKey, scenarioId, personaId, repeatIndex) {
  return path.join(RUNS_DIR, versionKey, scenarioId, personaId, `${repeatIndex}.debug.log.gz`);
}

export async function writeDebugLog(versionKey, scenarioId, personaId, repeatIndex, gzBuf) {
  const p = debugLogPath(versionKey, scenarioId, personaId, repeatIndex);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, gzBuf);
  return p;
}

// Walk runs/<versionKey> and return all transcript file paths.
export async function listTranscripts(versionKey) {
  const root = path.join(RUNS_DIR, versionKey);
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.json')) out.push(full);
    }
  }
  await walk(root);
  return out.sort();
}

// Which version directories exist (most recent first by mtime).
export async function listVersions() {
  let entries;
  try {
    entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const stat = await fs.stat(path.join(RUNS_DIR, e.name));
    dirs.push({ key: e.name, mtime: stat.mtimeMs });
  }
  return dirs.sort((a, b) => b.mtime - a.mtime).map((d) => d.key);
}
