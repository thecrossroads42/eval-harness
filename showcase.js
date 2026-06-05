// =============================================================================
// Showcase archiving. Each finished session is generated under an isolated
// throwaway user (preserving first-visit isolation for valid judging), then
// COPIED here into the committed `showcase/` directory as one JSON file per
// session so every session is browsable (publicly, read-only) in the app. We
// reconstruct the app's native visit `messages[]` from the transcript's stored
// per-turn payloads (the same data the CLI used to persist the visit before it
// was deleted) and write it to disk for the user to review and `git commit`.
//
// Written by default; `harness clean` never touches `showcase/` (it's
// version-controlled, not throwaway scratch). Disable per run with `--no-keep`.
// =============================================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHOWCASE_DIR } from './config.js';

const PASS_RE = /^pass\b[\s.!,:;-]*/i;

// transcript.turns -> the app's flat visit shape (messages + name/icon/plan).
export function transcriptToVisit(transcript) {
  const messages = [];
  let keeperName = 'The Keeper';
  let name = transcript.name || null;
  let icon = null;
  let plan = null;
  let concluded = false;

  for (const t of transcript.turns || []) {
    if (t.role === 'keeper') {
      keeperName = t.payload?.memberName || keeperName;
      messages.push({ type: 'voice', isGreeting: true, voiceId: 'keeper', memberName: keeperName, content: t.text || t.rendered || '' });
    } else if (t.role === 'user') {
      messages.push({ type: 'user', content: t.text });
    } else if (t.role === 'sut') {
      const p = t.payload || {};
      if (p.visitName && !name) name = p.visitName;
      if (p.visitIcon && !icon) icon = p.visitIcon;
      if (p.visitConcluded) concluded = true;
      // A plan attaches to a visit only when it was ACCEPTED — the only path that
      // sets visitConcluded (api.js plan-accept -> closing flow). A plan merely
      // PROPOSED in a synthesis (visitConcluded false) is never saved to a real
      // visit, so it must not show as the showcased visit's plan either.
      if (p.actionPlan && p.visitConcluded) plan = p.actionPlan;
      if (p.primaryMemberName && p.primaryResponseText) {
        messages.push({ type: 'voice', isPrimary: true, voiceId: p.primaryMemberId, memberName: p.primaryMemberName, content: p.primaryResponseText });
      }
      for (const d of p.debateMembers || []) {
        const txt = (d.responseText || '').trim();
        if (txt && !PASS_RE.test(txt)) messages.push({ type: 'voice', voiceId: d.voiceId, memberName: d.memberName, content: d.responseText });
      }
      if (p.moderatorSummary) messages.push({ type: 'voice', isModeratorSummary: true, voiceId: 'keeper', memberName: keeperName, content: p.moderatorSummary });
      // A real visit built only from `rendered` (e.g. ingested) has no payload —
      // fall back to the rendered block as a single voice message.
      if (!p.primaryMemberName && !p.moderatorSummary && t.rendered) {
        messages.push({ type: 'voice', memberName: 'voices', content: t.rendered });
      }
    }
  }
  return { messages, name, icon, plan, concluded };
}

// A stable, human-readable filename (stem doubles as the showcase id used in the
// app's URL). Deterministic per scenario/persona/repeat so re-runs overwrite the
// same file rather than piling up duplicates.
function showcaseFilename(transcript) {
  const safe = (s) => String(s || 'session').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const parts = [transcript.scenarioId, transcript.personaId, `r${transcript.repeatIndex ?? 0}`];
  return `${parts.map(safe).join('__')}.json`;
}

export async function archiveToShowcase(transcript) {
  const { messages, name, icon, plan, concluded } = transcriptToVisit(transcript);
  if (messages.length === 0) return null;

  mkdirSync(SHOWCASE_DIR, { recursive: true });
  const file = showcaseFilename(transcript);
  const visit = {
    name,
    icon,
    startDate: Date.parse(transcript.startedAt) || Date.now(),
    // Only a concluded visit has an endDate; a persona-ended / abandoned visit
    // stays "ongoing" (endDate null), matching how a real abandoned visit looks.
    endDate: concluded ? (Date.parse(transcript.finishedAt) || Date.now()) : null,
    plan,
    // The backend generates this asynchronously after the visit concludes; the
    // runner polls for it (see runner.js) so a showcased session looks like a
    // native one. May be null if it didn't land within the timeout.
    summary: transcript.summary || null,
    // Server-computed cost for the session, captured over the API while polling
    // for the summary (see runner.js). Null for sessions generated before cost
    // tracking existed; the showcase view simply omits it then.
    cost: transcript.cost || null,
    messages,
  };
  writeFileSync(join(SHOWCASE_DIR, file), JSON.stringify(visit, null, 2));
  return { file, name };
}
