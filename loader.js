// =============================================================================
// Loader: reads personas.json + scenarios.json, applies the run-count policy,
// and expands the run matrix (scenario × bound personas × N repeats).
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EVALS_DIR } from './config.js';

export async function loadData() {
  const [personasRaw, scenariosRaw] = await Promise.all([
    fs.readFile(path.join(EVALS_DIR, 'personas.json'), 'utf8'),
    fs.readFile(path.join(EVALS_DIR, 'scenarios.json'), 'utf8'),
  ]);
  const personas = JSON.parse(personasRaw).personas;
  const scenarios = JSON.parse(scenariosRaw).scenarios;
  const personaById = new Map(personas.map((p) => [p.id, p]));
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
  return { personas, scenarios, personaById, scenarioById };
}

// A scenario is safety-critical if it lives in the crisis domain or carries a
// check whose failure is declared CRITICAL (overrides the whole scenario).
export function isCriticalScenario(scenario) {
  if (scenario.domain === 'crisis') return true;
  return (scenario.judge_rubric || []).some((c) => /critical\s+fail/i.test(c.fail_means || ''));
}

// Core-differentiator behavioral/traps that define whether the product is
// itself — run at 5 per run-count-policy.md.
const CORE_FIVE = new Set([
  'beh-resister-demands-answer',
  'trap-settled-question-no-fork',
  'trap-false-fork-apartment',
  'trap-orphan-unopposed-stance',
  // Centrism-resistance traps: do the voices stay unhedged, does the Keeper's
  // synthesis avoid soft-resolving, and does the system converge instead of
  // manufacturing a fork. These define whether the product resists the
  // centrist pull at all, so they run at core-differentiator count.
  'trap-voice-regresses-to-mean',
  'trap-keeper-soft-resolve',
  'trap-manufactured-fork-on-convergent-question',
  // Voice convergence — threats.md calls this "the single most important thing
  // to check." A 3-run pass would under-sample the drift, so run it at 5.
  'integ-voice-distinctness',
]);

// Repeats per the policy: safety/critical = 10; symmetry = 5/persona; core
// differentiator behavioral/trap = 5; everything else = 3.
export function repeatsFor(scenario) {
  if (isCriticalScenario(scenario)) return 10;
  if (scenario.kind === 'symmetry') return 5;
  if (CORE_FIVE.has(scenario.id)) return 5;
  return 3;
}

// Expand the run matrix. `filter` = { scenario, persona, repeat } (all optional).
// `repeat` overrides the policy count (useful for cheap smoke runs).
export async function expandMatrix(filter = {}) {
  const { scenarios, personaById, scenarioById } = await loadData();
  const specs = [];
  const chosen = filter.scenario
    ? scenarios.filter((s) => s.id === filter.scenario)
    : scenarios;
  if (filter.scenario && chosen.length === 0) {
    throw new Error(`unknown scenario "${filter.scenario}"`);
  }
  for (const scenario of chosen) {
    // requires_setup marks a scenario whose prior state the harness cannot yet
    // seed (no `setup` recipe covers it — e.g. seeded held forks/judgments).
    // A returning-user scenario whose prior state is just an action plan carries
    // a `setup` block instead (applySetup replays it over the real API) and runs
    // live. Skip the still-unsupported ones unless targeted by id.
    if (scenario.requires_setup && !filter.scenario) continue;
    const repeats = filter.repeat != null ? filter.repeat : repeatsFor(scenario);
    for (const personaId of scenario.bind_personas) {
      if (filter.persona && personaId !== filter.persona) continue;
      const persona = personaById.get(personaId);
      if (!persona) throw new Error(`scenario ${scenario.id} binds unknown persona "${personaId}"`);
      for (let r = 0; r < repeats; r++) {
        specs.push({ scenarioId: scenario.id, personaId, repeatIndex: r, repeats });
      }
    }
  }
  return { specs, scenarioById, personaById };
}
