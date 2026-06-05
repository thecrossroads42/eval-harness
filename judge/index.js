// =============================================================================
// Judge orchestrator. For each stored transcript: classify its checks by tier,
// run the Tier-A judge on the Tier-A checks, route Tier-B checks + the
// symmetry rubric to the panel (Phase 5), and write a judgement file.
//
//   judgements/<versionKey>/<scenarioId>/<personaId>/<repeatIndex>.json
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JUDGEMENTS_DIR, REAL_DIR, models, requireKeys, missingKeys } from '../config.js';
import { loadData } from '../loader.js';
import { listTranscripts, readTranscript, listVersions } from '../store.js';
import { mapLimit } from '../lib/util.js';
import { classifyRubric } from './tier.js';
import { judgeTierA } from './tierA.js';
import { judgeStanding } from './standing.js';

export function judgementPath(t) {
  return path.join(JUDGEMENTS_DIR, t.versionKey, t.scenarioId, t.personaId, `${t.repeatIndex}.json`);
}

async function writeJudgement(j) {
  const p = judgementPath(j);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(j, null, 2));
}

// Derive the per-transcript verdict from its scored checks.
function summarize(tierAResults, tierBResults) {
  const aFails = tierAResults.filter((r) => !r.pass);
  const criticalFail = [...tierAResults, ...(tierBResults || [])].some((r) => r.critical && r.pass === false);
  return {
    tierAPass: aFails.length === 0,
    tierAFailedChecks: aFails.map((r) => r.index),
    criticalFail,
    tierBPending: (tierBResults || []).some((r) => r.status === 'pending-panel'),
  };
}

export async function runJudge({ version, tier = 'all' } = {}) {
  const wantA = tier === 'a' || tier === 'all';
  const wantB = tier === 'b' || tier === 'all';

  if (wantA) requireKeys([models.judgeA.provider]);

  const versionKey = version || (await listVersions())[0];
  if (!versionKey) throw new Error('no runs found to judge. Run `harness run` first.');

  const { scenarioById } = await loadData();
  const files = await listTranscripts(versionKey);
  if (files.length === 0) throw new Error(`no transcripts under version ${versionKey}.`);

  // Lazily wire the panel only if it exists and Tier B was requested.
  let runPanel = null;
  let runSymmetry = null;
  if (wantB) {
    const panelProviders = models.panel.map((j) => j.provider);
    const missing = missingKeys(panelProviders);
    const workable = models.panel.filter((j) => !missing.some((m) => m.provider === j.provider));
    if (workable.length === 0) {
      throw new Error(`Tier-B panel has no usable judge: missing ${missing.map((m) => m.envKey).join(', ')}.`);
    }
    if (missing.length) {
      process.stdout.write(
        `\n⚠️  Tier-B panel DEGRADED: missing ${missing.map((m) => m.envKey).join(', ')}. ` +
        `Running with ${workable.map((j) => j.label).join(' + ')} only.\n` +
        `   The panel wants 3 families (${panelProviders.join(', ')}); add the missing key(s) for the full panel,\n` +
        `   and treat these fairness verdicts as provisional until then.\n`
      );
    }
    const mod = await import('./tierB.js');
    runPanel = mod.judgeTierBForTranscript;
    runSymmetry = mod.judgeSymmetry;
  }

  process.stdout.write(`judging ${files.length} transcript(s) at version ${versionKey} (tier=${tier})\n`);

  let done = 0;
  const tasks = files.map((file) => async () => {
    const t = await readTranscript(file);
    const scenario = scenarioById.get(t.scenarioId);
    if (!scenario) return { error: `unknown scenario ${t.scenarioId}` };

    const checks = classifyRubric(scenario);
    const aChecks = checks.filter((c) => c.tier === 'A');
    const bChecks = checks.filter((c) => c.tier === 'B');

    let tierAResults = [];
    if (wantA && aChecks.length) tierAResults = await judgeTierA(scenario, aChecks, t);

    let tierBResults = bChecks.map((c) => ({ index: c.index, check: c.check, tier: 'B', critical: c.critical, status: 'pending-panel' }));
    if (wantB && runPanel) {
      tierBResults = await runPanel({ scenario, bChecks, transcript: t });
    }

    const judgement = {
      scenarioId: t.scenarioId,
      personaId: t.personaId,
      repeatIndex: t.repeatIndex,
      versionKey: t.versionKey,
      sensitive: t.sensitive,
      runStatus: t.status,
      judgedAt: new Date().toISOString(),
      judges: { tierA: `${models.judgeA.provider}/${models.judgeA.model}` },
      tierA: tierAResults,
      tierB: tierBResults,
      summary: summarize(tierAResults, tierBResults),
    };
    await writeJudgement(judgement);
    done++;
    const s = judgement.summary;
    process.stdout.write(
      `[${String(done).padStart(3)}/${files.length}] ${t.scenarioId}/${t.personaId}#${t.repeatIndex} ` +
      `— tierA ${s.tierAPass ? 'PASS' : 'FAIL(' + s.tierAFailedChecks.join(',') + ')'}` +
      `${s.criticalFail ? ' — CRITICAL FAIL' : ''}${s.tierBPending ? ' — tierB pending' : ''}\n`
    );
    return judgement;
  });

  await mapLimit(tasks, 3, null);

  // Cross-transcript symmetry/tilt pass (Tier B), once per symmetry scenario.
  if (runSymmetry) {
    process.stdout.write(`\nrunning symmetry (tilt) panel across symmetry scenarios...\n`);
    await runSymmetry(versionKey, scenarioById);
  }

  process.stdout.write(`\ndone. judgements under judgements/${versionKey}\n`);
}

// Judge ingested REAL sessions against the standing rubric. Prints a per-session
// audit and writes judgements to judgements/real/<id>.json.
export async function runJudgeReal() {
  requireKeys([models.judgeA.provider]);
  let files;
  try {
    files = (await fs.readdir(REAL_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  if (files.length === 0) throw new Error('no real sessions. Ingest first: `harness ingest --file <visit.json>`.');

  process.stdout.write(`judging ${files.length} real session(s) against the standing rubric (${models.judgeA.provider}/${models.judgeA.model})\n`);

  for (const f of files) {
    const transcript = JSON.parse(await fs.readFile(path.join(REAL_DIR, f), 'utf8'));
    const { results, summary } = await judgeStanding(transcript);
    const judgement = {
      source: 'real', id: transcript.id, visitId: transcript.visitId, name: transcript.name,
      judgedAt: new Date().toISOString(), judge: `${models.judgeA.provider}/${models.judgeA.model}`,
      results, summary,
    };
    const out = path.join(JUDGEMENTS_DIR, 'real', `${transcript.id}.json`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(judgement, null, 2));

    process.stdout.write(`\n=== ${transcript.id}${transcript.name ? ` — ${transcript.name}` : ''} ===\n`);
    if (summary.criticalFail) process.stdout.write('  🛑 CRITICAL FAIL (crisis) — blocks this session\n');
    for (const r of results.filter((x) => x.applies)) {
      process.stdout.write(`  [${r.tier}${r.critical ? '!' : ''}] ${r.pass ? 'PASS' : 'FAIL'} — ${r.promise}${r.needs_second_judge ? ' (fairness: needs human)' : ''}\n`);
      if (!r.pass && r.evidence) process.stdout.write(`        ↳ ${String(r.evidence).replace(/\s+/g, ' ').slice(0, 160)}\n`);
    }
    const na = results.length - summary.applicable;
    process.stdout.write(`  (${na} N/A) applicablePass=${summary.applicablePass}${summary.tierBPending ? `, ${summary.tierBPending} fairness queued for review` : ''}\n`);
  }
  process.stdout.write(`\ndone. judgements under judgements/real/  (fairness items: harness review)\n`);
}
