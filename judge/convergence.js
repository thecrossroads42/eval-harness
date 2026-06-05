// =============================================================================
// The convergence panel: the three corpus-level metrics that turn the deepest
// threat in corpus/threats.md ("the voices may be one voice wearing masks", plus
// the Keeper's pull toward resolution) into numbers. One command, three metrics,
// meant to be read together:
//
//   distinctiveness  voice STYLE   — can the voices be told apart?
//   substance        voice CONTENT — do the voices actually disagree?
//   synthesis        the KEEPER    — does the synthesis hold the fork or flatten it?
//
// High distinctiveness + low substance = costume (distinct diction, same
// argument). High substance + low synthesis preserve-rate = the voices do their
// job but the Keeper undoes it. That is why `all` is the default — a single
// metric in isolation is easy to misread.
//
// Each metric is a thin descriptor over the shared engine (judge/corpus.js):
// its per-transcript judge and its aggregate/print. Adding a fourth convergence
// metric is one entry here plus a judge/report pair in its own file.
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { models, requireKeys, JUDGEMENTS_DIR } from '../config.js';
import { runMetric } from './corpus.js';
import { judgeDistinctiveness, reportDistinctiveness } from './distinctiveness.js';
import { judgeSubstance, reportSubstance } from './substance.js';
import { judgeSynthesis, reportSynthesis } from './synthesis.js';

const METRICS = {
  distinctiveness: { cfg: () => models.distinctiveness, judge: judgeDistinctiveness, report: reportDistinctiveness },
  substance:       { cfg: () => models.substance,       judge: judgeSubstance,       report: reportSubstance },
  synthesis:       { cfg: () => models.synthesis,        judge: judgeSynthesis,        report: reportSynthesis },
};

export const METRIC_NAMES = Object.keys(METRICS);

export async function runConvergence({ metric = 'all', version, file } = {}) {
  const selected = metric === 'all' ? METRIC_NAMES : [metric];
  for (const name of selected) {
    if (!METRICS[name]) {
      throw new Error(`unknown metric "${name}". Choose one of: ${METRIC_NAMES.join(', ')}, all.`);
    }
  }

  // Preflight every selected judge's provider key up front, so a missing key
  // fails before any (billable) call rather than halfway through the panel.
  requireKeys(selected.map((name) => METRICS[name].cfg().provider));

  const summaries = {};
  for (const name of selected) {
    const m = METRICS[name];
    const results = await runMetric({ version, file, judgeFn: m.judge });
    if (results === null) {
      process.stdout.write(`no transcripts found (version ${version}${file ? `, file ${file}` : ''}).\n`);
      return;
    }
    summaries[name] = { ...m.report(results), generatedAt: new Date().toISOString() };
  }

  // Persist the panel so `harness report` can render it without re-running these
  // (billable) calls — the same judge→report data flow the rest of the harness
  // uses. Only for a full version run; a single --file scoring has no version to
  // attach to. Merge into any existing panel so running one --metric at a time
  // accumulates rather than clobbering the others.
  if (!file) {
    const out = path.join(JUDGEMENTS_DIR, version, '_convergence.json');
    let existing = {};
    try { existing = JSON.parse(await fs.readFile(out, 'utf8')); } catch { /* first run */ }
    const merged = {
      versionKey: version,
      generatedAt: new Date().toISOString(),
      metrics: { ...(existing.metrics || {}), ...summaries },
    };
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(merged, null, 2));
    process.stdout.write(`\nwrote ${path.relative(process.cwd(), out)} — read into \`harness report\`.\n`);
  }
}
