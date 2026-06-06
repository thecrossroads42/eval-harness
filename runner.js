// =============================================================================
// Runner. For each run spec: provision an isolated user, spawn the real CLI in
// --json mode (which drives the real backend orchestration), play the persona
// reactively via the simulated-user model, and capture the full transcript.
//
// PRINCIPLE 1 (the unbreakable one): this drives the real CLI -> real backend.
// It never reimplements or stubs orchestration.
// =============================================================================

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  CLI_PATH, REPO_ROOT, apiUrl, runner as runnerCfg, ORCHESTRATOR, models,
} from './config.js';
import { provisionUser, grantCredits, deleteUser, fetchVisitDebug } from './authBackend.js';
import { nextUserTurn } from './simulated-user.js';
import { renderSutPayload, fullTranscriptText, writeTranscript, writeDebugLog } from './store.js';
import { archiveToShowcase } from './showcase.js';
import { RecordQueue, mapLimit } from './lib/util.js';

// Live progress: one tagged line per turn to stderr, and (if HARNESS_LOG is set)
// also into that file along with the raw token stream, so it can be `tail -f`d.
const snip = (s) => JSON.stringify((s || '').replace(/\s+/g, ' ').trim().slice(0, 70));

// The backend generates a visit's summary ASYNCHRONOUSLY, and ONLY once the
// visit is marked ended: the `PUT /visits/:id` that first sets `endDate` returns
// immediately and builds the summary in the background, which takes several
// seconds (see backend/visits/api.js#handleUpdateVisit). Two consequences for
// the harness:
//
//   1. The difficult personas usually END THE VISIT BY WALKING AWAY once they've
//      gotten what they came for, so the visit never reaches
//      ===VISIT_CONCLUDED=== and the CLI never sets `endDate` — meaning the
//      backend never generates a summary at all (the common case here).
//   2. Even when a visit does conclude, the CLI exits the instant it does, so
//      the summary lands in no turn payload.
//
// For a showcased session to look like a native COMPLETED visit, we therefore
// finalize it ourselves — set `endDate` over the public API exactly as the CLI
// does on conclusion (the messages are already persisted turn-by-turn, so the
// backend summarizes the full transcript) — then poll until the summary lands or
// we hit the deadline. This is a lifecycle write (like provisioning the
// throwaway user), not orchestration; we never read the data dir. A visit that
// already concluded keeps the CLI's `endDate`; we just poll.
// The async summary (a Sonnet call over the whole transcript) can take well over
// a minute for long visits, especially with several sessions finalizing at once.
// The old 90s default lost the summary on ~half of a concurrency-2 showcase batch
// (the poll gave up before it landed, then the throwaway user was deleted and it
// was gone). 4 minutes gives ample margin; override with HARNESS_SUMMARY_TIMEOUT_MS.
const SUMMARY_TIMEOUT_MS = parseInt(process.env.HARNESS_SUMMARY_TIMEOUT_MS || '240000', 10);
const SUMMARY_POLL_INTERVAL_MS = parseInt(process.env.HARNESS_SUMMARY_POLL_INTERVAL_MS || '2000', 10);

async function endVisitAndAwaitSummary(userId, visitId, alreadyConcluded) {
  const auth = { Authorization: `Bearer ${userId}` };
  // Mark it ended (unless it concluded on its own) to kick off summary gen.
  if (!alreadyConcluded) {
    try {
      await fetch(`${apiUrl}/api/visits/${visitId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ endDate: Date.now() }),
      });
    } catch {
      /* if we can't finalize it, the poll below just times out to null */
    }
  }
  const deadline = Date.now() + SUMMARY_TIMEOUT_MS;
  // The backend folds the visit's server-computed cost into the same visit JSON
  // we poll here, so we capture it alongside the summary (the showcase view
  // renders it). Keep the latest seen value so cost is preserved even if the
  // summary itself never lands before the deadline.
  let cost = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/api/visits/${visitId}`, { headers: auth });
      if (res.ok) {
        const visit = await res.json();
        if (visit?.cost) cost = visit.cost;
        if (visit?.summary) return { summary: visit.summary, cost };
      }
    } catch {
      /* transient — keep polling until the deadline */
    }
    await new Promise((r) => setTimeout(r, SUMMARY_POLL_INTERVAL_MS));
  }
  return { summary: null, cost };
}

// Open HARNESS_LOG for appending, expanding a leading ~ and creating the parent
// directory if needed. Returns null when HARNESS_LOG is unset.
function openLogStream() {
  const raw = process.env.HARNESS_LOG;
  if (!raw) return null;
  const path = raw === '~' ? homedir()
    : raw.startsWith('~/') ? join(homedir(), raw.slice(2))
    : raw;
  mkdirSync(dirname(path), { recursive: true });
  return createWriteStream(path, { flags: 'a' });
}

// Seed a trajectory scenario's prior state over the REAL user-facing HTTP API,
// before the visit is driven — so a "returning user with a carried plan" is set
// up the way a real prior visit would have left it, with the harness still only
// touching public endpoints (never the data dir; PRINCIPLE 1 holds — seeding is
// just the user's own prior actions replayed). Today it can seed the action plan
// and notes, which is what the returning-user scenarios need. An unknown setup
// key THROWS rather than silently under-seeding: a half-seeded run would pass or
// fail for the wrong reason, which is worse than a loud refusal.
const SUPPORTED_SETUP_KEYS = new Set(['actionPlan', 'notes']);
export async function applySetup(userId, setup, progress = () => {}) {
  if (!setup) return;
  const unknown = Object.keys(setup).filter((k) => !SUPPORTED_SETUP_KEYS.has(k));
  if (unknown.length) {
    throw new Error(`scenario setup has unsupported key(s): ${unknown.join(', ')} — extend applySetup() or keep requires_setup`);
  }
  const headers = { Authorization: `Bearer ${userId}`, 'Content-Type': 'application/json' };
  const put = async (p, body, label) => {
    const res = await fetch(`${apiUrl}${p}`, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`seed ${label} failed (status ${res.status})`);
  };
  if (setup.actionPlan != null) await put('/api/action-plan', { actionPlan: setup.actionPlan }, 'action plan');
  if (setup.notes != null) await put('/api/notes', { notes: setup.notes }, 'notes');
  progress(`seeded prior state (${Object.keys(setup).join(', ')})`);
}

// `nextTurn` and `writeRuns` exist so the literary run-and-read mode can reuse
// this transport unchanged: it injects a literary, self-contained simulated user
// (no scenario) via `nextTurn`, and sets `writeRuns: false` so its probe
// transcripts never land in runs/ (where `judge` would pick them up) — the
// literary command persists them to its own dir instead. The eval matrix and the
// validation gate pass neither, so their behavior is identical.
export async function runOne({
  scenario, persona, repeatIndex, version,
  keep = true, creditUsd = runnerCfg.defaultCreditUsd,
  nextTurn = nextUserTurn, writeRuns = true,
}) {
  const startedAt = new Date().toISOString();
  const tag = `${scenario.id}/${persona.id}#${repeatIndex}`;
  const logStream = openLogStream();
  const progress = (line) => {
    const out = `  [${tag}] ${line}\n`;
    process.stderr.write(out);
    if (logStream && logStream.writable) logStream.write(out);
  };
  progress('── start ──');

  const { userId, email } = await provisionUser();
  await grantCredits(email, creditUsd);
  progress(`granted $${creditUsd.toFixed(2)} credit`);

  // Trajectory scenarios seed prior state (e.g. a carried action plan) before
  // the visit is driven, so the user arrives as a returning user.
  await applySetup(userId, scenario.setup, progress);

  const turns = [];
  let status = 'ok';
  let endReason = null;
  let sutError = null;
  let visitId = null;
  let repo = null;
  let stderrBuf = '';
  let summary = null;
  let cost = null;

  const child = spawn('node', [CLI_PATH, '--json', '--token', userId, '--api', apiUrl], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const queue = new RecordQueue();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      return; // ignore stray non-JSON
    }
    queue.push(rec);
  });
  rl.on('close', () => queue.close());
  child.stderr.on('data', (d) => {
    const s = d.toString();
    stderrBuf += s;
    if (logStream && logStream.writable) logStream.write(s); // tee the live token stream for tail -f
  });
  child.on('error', (e) => { sutError = sutError || `failed to spawn CLI: ${e.message}`; queue.close(); });

  const writeLine = (text) =>
    new Promise((resolve) => child.stdin.write(`${text.replace(/\r?\n/g, ' ')}\n`, resolve));
  const closeStdin = () => { try { child.stdin.end(); } catch { /* already closed */ } };

  try {
    let chatTurnCount = 0;
    let pendingEnd = false; // user's closing line sent; stop after the response to it
    while (true) {
      let rec;
      try {
        rec = await queue.nextWithTimeout(runnerCfg.turnTimeoutMs);
      } catch (e) {
        status = 'timeout';
        endReason = endReason || 'timeout';
        sutError = sutError || e.message;
        break;
      }
      if (rec === null) {
        endReason = endReason || 'stream-closed';
        break;
      }

      switch (rec.type) {
        case 'version':
          repo = rec.repo;
          continue;
        case 'error':
          status = 'error';
          sutError = sutError || rec.message;
          endReason = endReason || 'error';
          break;
        case 'turn-error':
          status = 'error';
          sutError = sutError || rec.message;
          endReason = endReason || 'turn-error';
          break;
        case 'end':
          endReason = endReason || rec.reason;
          visitId = rec.visitId ?? visitId;
          break;
        case 'turn':
          if (rec.turn === 'greeting') {
            visitId = rec.visitId ?? visitId;
            turns.push({ role: 'keeper', kind: 'greeting', text: rec.text, payload: rec.payload, rendered: (rec.text || '').trim() });
            turns.push({ role: 'user', text: scenario.opening_message });
            progress(`greeting received; → user (opening): ${snip(scenario.opening_message)}`);
            await writeLine(scenario.opening_message);
            continue;
          }
          if (rec.turn === 'chat') {
            visitId = rec.visitId ?? visitId;
            chatTurnCount++;
            turns.push({ role: 'sut', kind: 'chat', text: rec.text, payload: rec.payload, rendered: renderSutPayload(rec.payload) });

            const p = rec.payload || {};
            const debating = (p.debateMembers || []).filter((d) => d.responseText && !/^pass\b/i.test(d.responseText.trim())).length;
            progress(`turn ${chatTurnCount} ← ${p.primaryMemberName || '?'}${debating ? ` +${debating} debating` : ''}${p.moderatorSummary ? ', +synthesis' : ''}${p.visitConcluded ? ' [CONCLUDED]' : ''}`);

            if (rec.payload?.visitConcluded) {
              endReason = endReason || 'concluded';
              continue; // CLI will emit `end` then exit
            }
            if (pendingEnd) {
              // This turn is the response to the user's closing line (the
              // backend's closing-remarks flow, or just a normal reply if it
              // didn't treat it as a conclusion). Either way, the user is done.
              endReason = endReason || 'persona-ended';
              progress('user ended the visit');
              closeStdin();
              continue;
            }
            if (chatTurnCount >= runnerCfg.maxTurns) {
              status = status === 'ok' ? 'max_turns' : status;
              endReason = endReason || 'max_turns';
              progress(`turn cap (${runnerCfg.maxTurns}) reached — ending`);
              closeStdin();
              continue; // drain to `end`
            }
            let next;
            try {
              next = await nextTurn({ persona, scenario, turns });
            } catch (e) {
              status = 'error';
              sutError = sutError || `simulated user failed: ${e.message}`;
              endReason = endReason || 'sim-user-error';
              progress(`simulated user error: ${e.message}`);
              closeStdin();
              continue;
            }
            if (!next.text) {
              // Nothing to say — the persona just leaves without a closing line.
              endReason = endReason || 'persona-ended';
              progress('user ended the visit');
              closeStdin();
              continue;
            }
            turns.push({ role: 'user', text: next.text });
            progress(`turn ${chatTurnCount} → user${next.end ? ' (closing)' : ''}: ${snip(next.text)}`);
            await writeLine(next.text);
            // The persona signalled end: send this closing line, then stop once
            // the system responds to it (handled by the pendingEnd check above).
            if (next.end) pendingEnd = true;
            continue;
          }
          continue;
        default:
          continue;
      }
      // a `break` inside the switch (error/turn-error/end) lands here
      break;
    }
  } finally {
    closeStdin();
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
    });
    rl.close();
    // The CLI has now fully exited, so its per-turn message persists have
    // flushed. Finalize the visit and wait for the async summary BEFORE deleting
    // the user (only when we're going to showcase it — `keep`). Difficult
    // personas rarely let a visit conclude, so without this the showcased visit
    // would carry no summary.
    if (keep && visitId != null && turns.some((t) => t.role === 'sut')) {
      progress('finalizing visit — waiting for async summary…');
      try {
        ({ summary, cost } = await endVisitAndAwaitSummary(userId, visitId, endReason === 'concluded'));
      } catch (e) {
        progress(`summary wait failed: ${e.message}`);
      }
      progress(summary
        ? 'summary captured'
        : `summary not generated within ${Math.round(SUMMARY_TIMEOUT_MS / 1000)}s`);
    }
    // Always archive the raw per-visit LLM debug log (full prompts + raw
    // responses + usage) next to the transcript BEFORE the user is deleted —
    // it dies with the throwaway user, so this is the only chance to keep it.
    // (writeRuns gates it: a literary probe writes nothing under runs/.)
    if (writeRuns && visitId != null) {
      try {
        const gz = await fetchVisitDebug(email, visitId);
        if (gz) {
          const dp = await writeDebugLog(version.key, scenario.id, persona.id, repeatIndex, gz);
          progress(`debug log saved → ${dp}`);
        } else {
          progress('debug log unavailable (no log returned by admin API)');
        }
      } catch (e) {
        progress(`debug log archive failed: ${e.message}`);
      }
    }
    await deleteUser(email);
    progress(`── done: status=${status} reason=${endReason} (${turns.filter((t) => t.role === 'sut').length} turns) ──`);
  }

  const transcript = {
    scenarioId: scenario.id,
    personaId: persona.id,
    repeatIndex,
    versionKey: version.key,
    versionFullHash: version.fullHash,
    repo,
    orchestrator: ORCHESTRATOR,
    simUser: models.simulatedUser,
    sensitive: !!persona.sensitive,
    visitId,
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    endReason,
    sutError,
    summary,
    cost,
    chatTurns: turns.filter((t) => t.role === 'sut').length,
    turns,
    rendered: fullTranscriptText(turns),
    stderrTail: stderrBuf.slice(-4000),
  };

  // Copy the finished session into the committed showcase/ directory (default on).
  if (keep && turns.some((t) => t.role === 'sut')) {
    try {
      const s = await archiveToShowcase(transcript);
      if (s) {
        transcript.showcase = s;
        progress(`archived → showcase/${s.file}`);
      }
    } catch (e) {
      progress(`showcase archive failed: ${e.message}`);
    }
  }

  // The literary mode (writeRuns: false) keeps probe transcripts out of runs/
  // so `judge` can never pick them up; it persists them to its own dir instead.
  if (writeRuns) await writeTranscript(transcript);
  // Closed here, not in `finally`: the showcase-archive progress lines above
  // still need to reach the log file (they run after `finally`).
  if (logStream) logStream.end();
  return transcript;
}

// Run a list of specs with bounded concurrency. `version` is computed once by
// the caller so every transcript in a run shares the same version key.
export async function runSpecs({ specs, scenarioById, personaById, version, keep = true, creditUsd = runnerCfg.defaultCreditUsd, onProgress }) {
  let done = 0;
  const tasks = specs.map((spec) => async () => {
    const scenario = scenarioById.get(spec.scenarioId);
    const persona = personaById.get(spec.personaId);
    const t = await runOne({ scenario, persona, repeatIndex: spec.repeatIndex, version, keep, creditUsd });
    done++;
    if (onProgress) onProgress(t, done, specs.length, spec);
    return t;
  });
  return mapLimit(tasks, runnerCfg.concurrency, null);
}
