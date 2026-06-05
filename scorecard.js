// =============================================================================
// Scorecard drafter
//
// Derive DRAFT per-visit scorecards for showcase visits from stored judgements,
// so "a scorecard on every showcased visit" scales. The harness already computed
// the verdict + a cited evidence quote per check (`judgements/<version>/...`);
// this maps that onto the public `scorecard` field consumed by the app
// (see corpus/scorecard.md, docs/03 · "Showcase visits", and
// components/visit/ScorecardModal).
//
// Mechanical only, on purpose:
//   - `status` and `evidence` and `version` are DERIVED from the judgement.
//   - `promise` is a PLACEHOLDER (the scenario's internal promise tags) the
//     curator MUST rewrite into public, plain-language phrasing.
//   - `reviewed` starts at 'automated-provisional'.
// Nothing here auto-publishes. The fork checks are noisy on a single judge
// (run the Tier-B panel before trusting a fork status), so a human reviews the
// drafts, rewrites the promise, sanity-checks status/quote, and commits. The
// version stamped is the version the visit was *judged at* — keep it equal to
// the version that *generated* the visit (don't scorecard a visit from a judge
// run of a different prompt). See docs/05 · "Publishing the results".
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SHOWCASE_DIR, JUDGEMENTS_DIR, EVALS_DIR } from './config.js';
import { computeVersion } from './version.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Showcase filenames are `{scenarioId}__{personaId}__r{n}` — ids carry hyphens
// but never a double underscore, so a 3-way split is unambiguous.
function parseShowcaseId(stem) {
  const parts = stem.split('__');
  if (parts.length !== 3 || !/^r\d+$/.test(parts[2])) return null;
  return { scenarioId: parts[0], personaId: parts[1], repeat: parseInt(parts[2].slice(1), 10) };
}

const allChecks = (j) => [...(j.tierA || []), ...(j.tierB || [])];
const failed = (j) => allChecks(j).filter((c) => c.pass === false);
const passed = (j) => allChecks(j).filter((c) => c.pass === true);

function statusFor(j) {
  if (j?.summary?.criticalFail) return 'fell-short';
  if (failed(j).length === 0) return 'held';
  if (passed(j).length === 0) return 'fell-short';
  return 'mixed';
}

// A real transcript quote: the cited evidence of a relevant check — a failed one
// for a miss, a passed one for a hold. Tier-B evidence lives per-judge.
function evidenceFor(j, status) {
  const ev = (c) => c.evidence || (c.judges || []).map((x) => x.evidence).find(Boolean) || null;
  const primary = status === 'held' ? passed(j) : failed(j);
  for (const c of [...primary, ...allChecks(j)]) {
    const e = ev(c);
    if (e && e.trim()) return e.trim();
  }
  return null;
}

async function loadScenarios() {
  const raw = await fs.readFile(path.join(EVALS_DIR, 'scenarios.json'), 'utf8');
  return JSON.parse(raw).scenarios;
}

export async function draftFor(scenarioId, personaId, repeat, version, scenarios) {
  const jPath = path.join(JUDGEMENTS_DIR, version, scenarioId, personaId, `${repeat}.json`);
  let j;
  try { j = JSON.parse(await fs.readFile(jPath, 'utf8')); } catch { return { missing: true }; }
  const sc = scenarios.find((s) => s.id === scenarioId);
  const status = statusFor(j);
  return {
    draft: {
      promise: (sc?.promise_under_test || []).join('; ') || scenarioId, // PLACEHOLDER — rewrite
      status,
      evidence: evidenceFor(j, status),
      version,
      reviewed: 'automated-provisional',
    },
    expected: sc?.expected_system_behavior || null,
  };
}

export async function runScorecard({ version, scenario, persona, repeat, write }) {
  const v = version || (await computeVersion()).key;
  const scenarios = await loadScenarios();
  const now = new Date();
  const date = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;

  let files = [];
  try { files = (await fs.readdir(SHOWCASE_DIR)).filter((f) => f.endsWith('.json')).sort(); } catch { /* none */ }

  let drafted = 0, missing = 0, wrote = 0;
  for (const file of files) {
    const ids = parseShowcaseId(file.slice(0, -'.json'.length));
    if (!ids) continue;
    if (scenario && ids.scenarioId !== scenario) continue;
    if (persona && ids.personaId !== persona) continue;
    if (repeat != null && ids.repeat !== repeat) continue;

    const res = await draftFor(ids.scenarioId, ids.personaId, ids.repeat, v, scenarios);
    if (res.missing) {
      missing++;
      process.stdout.write(`—  ${file}\n     no judgement at version ${v} — regenerate + judge at this version (or pass --version)\n`);
      continue;
    }
    drafted++;
    const d = { ...res.draft, date };
    const ev = d.evidence ? `"${d.evidence.slice(0, 150)}${d.evidence.length > 150 ? '…' : ''}"` : '(none cited)';
    process.stdout.write(
      `★  ${file}\n` +
      `     status:   ${d.status}\n` +
      `     promise:  ${d.promise}   ← DRAFT — rewrite to public phrasing\n` +
      `     evidence: ${ev}\n` +
      `     expected: ${(res.expected || '').replace(/\s+/g, ' ').slice(0, 130)}\n`
    );
    if (write) {
      const fpath = path.join(SHOWCASE_DIR, file);
      const visit = JSON.parse(await fs.readFile(fpath, 'utf8'));
      visit.scorecard = d;
      await fs.writeFile(fpath, `${JSON.stringify(visit, null, 2)}\n`);
      wrote++;
      process.stdout.write('     → written\n');
    }
  }

  process.stdout.write(
    `\n${drafted} drafted, ${missing} without a judgement at ${v}` +
    `${write ? `, ${wrote} written` : ' — dry run; pass --write to inject'}\n`
  );
  if (write) {
    process.stdout.write(
      'Before committing, for each written scorecard: rewrite `promise` into a public\n' +
      'sentence, sanity-check status + quote against the transcript (fork checks are\n' +
      'noisy on a single judge — run the Tier-B panel), then set `reviewed: human-reviewed`.\n'
    );
  }
}
