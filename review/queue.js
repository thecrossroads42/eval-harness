// =============================================================================
// Human-review queue for Tier-B (fairness) judgements.
//
// RECONSTRUCTED 2026-06-05. The original `review/queue.js` lived INSIDE the
// gitignored `review/` directory, so it was never tracked by git and was lost to
// an `rm -rf` (no copy in history, swap files, the recovery dir, or the mirrors).
// It is rebuilt here from its call sites — `enqueue` (judge/standing.js,
// judge/tierB.js, bin/harness `review`) and the judgement-file shape
// (judge/index.js). The `.gitignore` was also corrected so the source is tracked
// while the working `pending/`/`done/` queues stay ignored.
//
//   - `enqueue` is FULLY DETERMINED by its call sites (faithful).
//   - `runReview` (interactive blind review + `--merge`) is a faithful
//     reconstruction; its `--merge` is intentionally ADDITIVE (it attaches a
//     `humanReview` field to the judgement, never overwrites the model verdicts),
//     so it cannot corrupt judgement data. Sanity-check it against intended
//     semantics before relying on `harness review --merge`.
//
// Why a human queue at all: a single model is unreliable on EQUAL-FORCE fairness,
// so every APPLIED Tier-B check is also written here as a BLIND packet
// (instructions + material only — never the model verdicts) for an independent
// human second signal. `harness review` presents each packet, collects a verdict,
// and (with --merge) folds it back into the corresponding judgement file.
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { REVIEW_DIR, JUDGEMENTS_DIR } from '../config.js';

const pendingDir = () => path.join(REVIEW_DIR, 'pending');
const doneDir = () => path.join(REVIEW_DIR, 'done');

// Write a blind review packet. Idempotent by id: re-judging the same transcript
// overwrites its packet rather than piling up duplicates. The packet deliberately
// carries only `instructions` + `material` — never the model verdicts — so the
// human signal stays independent of the panel.
export async function enqueue(item) {
  if (!item || !item.id) throw new Error('enqueue: item.id is required');
  await fs.mkdir(pendingDir(), { recursive: true });
  const packet = {
    id: item.id,
    type: item.type || 'tierB',
    versionKey: item.versionKey ?? null,
    scenarioId: item.scenarioId ?? null,
    sharedBias: item.sharedBias ?? false,
    predictedTilt: item.predictedTilt ?? null,
    instructions: item.instructions || '',
    material: item.material || '',
    queuedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(pendingDir(), `${item.id}.json`), JSON.stringify(packet, null, 2));
}

async function readPackets(version) {
  let files;
  try {
    files = (await fs.readdir(pendingDir())).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  const packets = [];
  for (const f of files.sort()) {
    const p = JSON.parse(await fs.readFile(path.join(pendingDir(), f), 'utf8'));
    if (version && p.versionKey && p.versionKey !== version) continue;
    packets.push(p);
  }
  return packets;
}

function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, (a) => resolve(String(a).trim())));
}

// Resolve which judgement file a completed verdict belongs to, from its packet id:
//   chk_<version>_<scenario>_<persona>_<repeat> -> judgements/<v>/<sc>/<p>/<r>.json
//   sym_<version>_<scenario>                    -> judgements/<v>/_symmetry/<sc>.json
//   real_<id>                                   -> judgements/real/<id>.json
function judgementFileFor(v) {
  if (v.type === 'symmetry') {
    return path.join(JUDGEMENTS_DIR, v.versionKey, '_symmetry', `${v.scenarioId}.json`);
  }
  if (v.type === 'standing-fairness') {
    const id = v.id.replace(/^real_/, '');
    return path.join(JUDGEMENTS_DIR, 'real', `${id}.json`);
  }
  // tierB-checks: id = chk_<version>_<scenario>_<persona>_<repeat>
  const m = /^chk_(.+)_([^_]+)_([^_]+)_(\d+)$/.exec(v.id);
  if (m) {
    const [, version, scenario, persona, repeat] = m;
    return path.join(JUDGEMENTS_DIR, version, scenario, persona, `${repeat}.json`);
  }
  return null;
}

// Fold completed human verdicts (review/done) back into the judgement files,
// ADDITIVELY: each judgement gains a `humanReview` field. The model verdicts are
// never overwritten, so a re-merge is safe and the panel/human signals stay
// distinguishable downstream.
async function mergeVerdicts(version) {
  let files;
  try {
    files = (await fs.readdir(doneDir())).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  if (!files.length) {
    process.stdout.write('no completed verdicts to merge (review/done is empty).\n');
    return;
  }
  let merged = 0;
  let missing = 0;
  for (const f of files.sort()) {
    const v = JSON.parse(await fs.readFile(path.join(doneDir(), f), 'utf8'));
    if (version && v.versionKey && v.versionKey !== version) continue;
    const target = judgementFileFor(v);
    if (!target) {
      process.stdout.write(`  ? cannot resolve judgement for verdict ${v.id} — skipped\n`);
      missing++;
      continue;
    }
    let judgement;
    try {
      judgement = JSON.parse(await fs.readFile(target, 'utf8'));
    } catch {
      process.stdout.write(`  ? judgement file not found for ${v.id} (${path.relative(JUDGEMENTS_DIR, target)}) — skipped\n`);
      missing++;
      continue;
    }
    judgement.humanReview = {
      verdict: v.verdict,
      pass: v.pass,
      note: v.note || '',
      reviewedAt: v.reviewedAt,
    };
    await fs.writeFile(target, JSON.stringify(judgement, null, 2));
    merged++;
  }
  process.stdout.write(`\nmerged ${merged} human verdict(s) into judgements${missing ? `, ${missing} unresolved` : ''}.\n`);
}

// Blind human review of the pending Tier-B packets. Presents each WITHOUT the
// model verdicts, collects a verdict, writes it to review/done, and removes it
// from review/pending. `--merge` folds completed verdicts into the judgements.
export async function runReview({ merge = false, version } = {}) {
  if (merge) return mergeVerdicts(version);

  const packets = await readPackets(version);
  if (!packets.length) {
    process.stdout.write(`no pending review items${version ? ` for version ${version}` : ''}.\n`);
    return;
  }
  await fs.mkdir(doneDir(), { recursive: true });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(
    `${packets.length} item(s) to review — BLIND (model verdicts withheld; judge the material yourself).\n` +
    `verdict keys: f = fair (equal force) · t = tilted · s = split/unsure · k = skip (leave pending) · q = quit\n`
  );

  let reviewed = 0;
  for (const p of packets) {
    process.stdout.write(`\n${'='.repeat(72)}\n`);
    process.stdout.write(`${p.type} — ${p.scenarioId || p.id}${p.sharedBias ? '   [SHARED-BIAS: the human read is PRIMARY here]' : ''}\n`);
    if (p.predictedTilt) process.stdout.write(`predicted tilt to check for: ${p.predictedTilt}\n`);
    process.stdout.write(`${'='.repeat(72)}\n\n${p.instructions}\n\n--- MATERIAL ---\n${p.material}\n--- END MATERIAL ---\n`);

    let verdict = null;
    while (verdict === null) {
      const a = (await ask(rl, '\nverdict [f/t/s/k/q]: ')).toLowerCase();
      if (a === 'q') {
        rl.close();
        process.stdout.write(`\nquit — reviewed ${reviewed}, remaining items left pending.\n`);
        return;
      }
      if (a === 'k') { verdict = 'skip'; break; }
      if (a === 'f') verdict = 'fair';
      else if (a === 't') verdict = 'tilted';
      else if (a === 's') verdict = 'split';
      else process.stdout.write('  enter one of f / t / s / k / q.\n');
    }
    if (verdict === 'skip') continue;

    const note = await ask(rl, 'note (optional): ');
    const record = {
      id: p.id,
      type: p.type,
      versionKey: p.versionKey,
      scenarioId: p.scenarioId,
      sharedBias: p.sharedBias,
      predictedTilt: p.predictedTilt,
      verdict,
      pass: verdict === 'fair' ? true : verdict === 'tilted' ? false : null,
      note,
      reviewedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(doneDir(), `${p.id}.json`), JSON.stringify(record, null, 2));
    await fs.rm(path.join(pendingDir(), `${p.id}.json`), { force: true });
    reviewed++;
  }

  rl.close();
  process.stdout.write(`\nreviewed ${reviewed} item(s) → ${path.relative(process.cwd(), doneDir())}.\n`);
  process.stdout.write('run `harness review --merge` to fold these verdicts into the judgement files.\n');
}
