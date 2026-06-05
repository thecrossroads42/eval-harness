// =============================================================================
// Central configuration: paths, model registry, run policy, two-model hygiene.
//
// The harness is API-only. It never imports backend source; it spawns the CLI
// as a subprocess and talks to the backend over HTTP. The one exception is
// reading the prompt files to *fingerprint* them for version stamping
// (version.js) — fingerprinting, never executing.
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const HARNESS_DIR = __dirname;

// Everything path- and identity-related is environment-overridable so the same
// engine runs two ways:
//   - Public user: set HARNESS_TOKEN to a `tcr_` API key and run against your
//     own account; artifacts land under $HARNESS_OUT (default: the cwd).
//   - Operator (this monorepo): a private wrapper (test/) points the HARNESS_*
//     vars at the repo and injects an admin provisioner via HARNESS_AUTH_BACKEND.

// The monorepo root — only meaningful to the operator (version.js fingerprints
// the SUT prompt corpus beneath it). A public user has no corpus/; version.js
// tolerates the missing dirs and degrades to an empty fingerprint. The in-repo
// default (packages/eval-harness/../..) is the repo root for the operator.
export const REPO_ROOT = process.env.HARNESS_REPO_ROOT
  ? path.resolve(process.env.HARNESS_REPO_ROOT)
  : path.resolve(__dirname, '..', '..');

// The CLI the runner spawns. Defaults to the published @thecrossroads42/cli
// dependency; override with HARNESS_CLI to point at a local checkout.
function resolveCli() {
  if (process.env.HARNESS_CLI) return path.resolve(process.env.HARNESS_CLI);
  try {
    return path.join(path.dirname(require.resolve('@thecrossroads42/cli/package.json')), 'cli');
  } catch {
    return null; // surfaced as a clear error by the runner if a run is attempted
  }
}
export const CLI_PATH = resolveCli();

// The authored eval suite (personas, scenarios) the matrix runs. A public user
// points this at their own dir, or omits it to use the bundled example/; the
// operator points it at the private battery (corpus/evals). Deliberately NOT
// part of the SUT version fingerprint (version.js): it is the measuring
// instrument, not the system under test. (Still called "the battery" in prose.)
export const EVALS_DIR = process.env.EVALS_DIR
  ? path.resolve(process.env.EVALS_DIR)
  : path.join(__dirname, 'example');

// The standing promise-rubric ships WITH the engine (it is the published
// criteria, not the user's battery), so it is read package-relative.
export const STANDING_RUBRIC = path.join(__dirname, 'standing-rubric.json');

// Where run artifacts are written. Default: the cwd, so an `npx` run drops them
// where it is invoked — never inside the installed package. The operator wrapper
// sets HARNESS_OUT to the repo's test/ dir to preserve today's layout.
const OUT = process.env.HARNESS_OUT ? path.resolve(process.env.HARNESS_OUT) : process.cwd();
export const RUNS_DIR = path.join(OUT, 'runs');
export const REAL_DIR = path.join(OUT, 'real'); // ingested real user sessions (private)
export const JUDGEMENTS_DIR = path.join(OUT, 'judgements');
export const REPORTS_DIR = path.join(OUT, 'reports');
export const REVIEW_DIR = path.join(OUT, 'review');
export const VALIDATION_DIR = path.join(OUT, 'validation');

export const apiUrl = (process.env.API_URL || 'http://localhost:3001').replace(/\/+$/, '');

// The token the CLI authenticates with when no admin provisioner is injected
// (BYO: a `tcr_` personal API key, or a user id). Empty when the operator
// injects an admin backend that mints a throwaway user per run instead.
export const token = process.env.HARNESS_TOKEN || process.env.TOKEN || '';

// Directory finished sessions are archived into for showcasing. The operator
// points HARNESS_SHOWCASE_DIR at the repo's committed showcase/ dir (served
// read-only at /api/showcase/* and browsable on the app); a public user gets
// one under the out dir. `harness clean` never touches it.
export const SHOWCASE_DIR = process.env.HARNESS_SHOWCASE_DIR
  ? path.resolve(process.env.HARNESS_SHOWCASE_DIR)
  : path.join(OUT, 'showcase');

// The system under test's orchestrator. Informational only — the harness never
// calls it directly (it runs inside the backend the CLI talks to). Used solely
// to enforce two-model hygiene against the simulated user.
export const ORCHESTRATOR = { provider: 'anthropic', model: 'claude-opus-4-6' };

// Model registry. Every id is env-overridable. Per panel-judging-protocol.md,
// confirm the *current* flagship of each family at wiring time — these defaults
// were confirmed against the OpenAI account at the time of writing; re-check
// (and bump) them periodically. Resolved ids are printed at startup.
export const models = {
  // Simulated user: a non-reasoning, chat-tuned model so it keeps `temperature`
  // (variation) and role-plays a difficult human without drifting "helpful".
  simulatedUser: {
    provider: process.env.SIM_USER_PROVIDER || 'openai',
    model: process.env.SIM_USER_MODEL || 'gpt-5.3-chat-latest',
    temperature: parseFloat(process.env.SIM_USER_TEMPERATURE || '0.9'),
  },
  // Tier-A judge (process / refusal). Single Anthropic judge per the spec.
  judgeA: {
    provider: 'anthropic',
    model: process.env.JUDGE_A_MODEL || 'claude-opus-4-7',
  },
  // Tier-B fairness panel: three families, decorrelated. Judge 1 = Opus. The
  // GPT judge is a pinned reasoning snapshot (reasoning helps evidence-cited
  // judging, and pinning keeps verdicts reproducible).
  panel: [
    { label: 'opus', provider: 'anthropic', model: process.env.JUDGE_A_MODEL || 'claude-opus-4-7' },
    { label: 'gemini', provider: 'google', model: process.env.JUDGE_GEMINI_MODEL || 'gemini-2.5-pro' },
    { label: 'gpt', provider: 'openai', model: process.env.JUDGE_GPT_MODEL || 'gpt-5.5-2026-04-23' },
  ],
  leads: {
    provider: 'anthropic',
    model: process.env.LEADS_MODEL || 'claude-opus-4-7',
  },
  // Distinctiveness attributor (blind voice-attribution — `harness convergence
  // --metric distinctiveness`). Deliberately a DIFFERENT family from the Opus
  // orchestrator: an Opus attributor could recognize its own stylistic
  // fingerprints and overstate how distinct the voices are.
  distinctiveness: {
    provider: process.env.DISTINCT_PROVIDER || 'openai',
    model: process.env.DISTINCT_MODEL || process.env.JUDGE_GPT_MODEL || 'gpt-5.5-2026-04-23',
  },
  // Substance judge (debate-adds-to-primary — `harness convergence --metric substance`). Same
  // cross-family rationale as the distinctiveness attributor: an Opus judge
  // could read a debate point as "new" precisely because it is the kind of point
  // it would have produced itself, overstating how much the voices disagree.
  substance: {
    provider: process.env.SUBSTANCE_PROVIDER || 'openai',
    model: process.env.SUBSTANCE_MODEL || process.env.JUDGE_GPT_MODEL || 'gpt-5.5-2026-04-23',
  },
  // Synthesis-collapse judge (does the Keeper hold the fork? — `harness convergence
  // --metric synthesis`). Cross-family for the same reason, doubly so: an Opus judge
  // scoring for centrist lean inherits the very prior it is trying to detect.
  // This eval is the most exposed to that shared bias (see judge/synthesis.js).
  synthesis: {
    provider: process.env.SYNTHESIS_PROVIDER || 'openai',
    model: process.env.SYNTHESIS_MODEL || process.env.JUDGE_GPT_MODEL || 'gpt-5.5-2026-04-23',
  },
};

export const runner = {
  maxTurns: parseInt(process.env.HARNESS_MAX_TURNS || '12', 10),
  concurrency: parseInt(process.env.HARNESS_CONCURRENCY || '2', 10),
  // A single mega-batch turn (Opus, multi-round debate) can take a while.
  turnTimeoutMs: parseInt(process.env.HARNESS_TURN_TIMEOUT_MS || '240000', 10),
  // USD credit granted to each throwaway test user after provisioning, so the
  // backend's credit gate lets the visit run. Overridable per-run via --credit.
  defaultCreditUsd: parseFloat(process.env.HARNESS_CREDIT_USD || '2'),
};

// Scenarios whose predicted tilt aligns with priors the models likely SHARE.
// On these, the human read is primary and unanimous model "fair" is provisional
// (panel-judging-protocol.md, the shared-bias rule).
export const SHARED_BIAS_SCENARIOS = new Set([
  'sym-family-move-away',
  'sym-compulsion-fork',
  'sym-meaning-what-to-do',
  'sym-dating-play-it-cool',
  'beh-dating-play-it-straight',
  'sym-partnership-rekindle-or-release',
  // Threat-coverage probes where the judge shares the very prior it must
  // detect: voice convergence, contested-as-settled / false-balance, the
  // out-of-roster fairness cases, and the Keeper's reframe imposition. On
  // these the human read is primary and a unanimous model "fair" is provisional.
  'integ-voice-distinctness',
  'trap-contestable-claim-as-craft',
  'trap-false-symmetry-asymmetric',
  'edge-hypergamy-contested-as-settled',
  'oor-faith-leaving-religion',
  'oor-culture-war-partisan',
  'oor-contested-science',
  'trap-keeper-reframe-imposition',
]);

// Two-model hygiene: the simulated user must not be the orchestrator. A single
// model talking to and grading itself shares blind spots (architecture §2).
export function assertHygiene() {
  const su = models.simulatedUser;
  if (su.provider === ORCHESTRATOR.provider && /opus/i.test(su.model)) {
    throw new Error(
      `Two-model hygiene violation: the simulated user (${su.provider}/${su.model}) ` +
      `must be a different model from the orchestrator under test (${ORCHESTRATOR.provider}/${ORCHESTRATOR.model}). ` +
      `Set SIM_USER_PROVIDER / SIM_USER_MODEL to a non-Opus model (a GPT or Gemini flagship is ideal).`
    );
  }
}

const ENV_KEY_FOR = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
};

// Verify the API keys for the given set of providers exist; throw a clear,
// actionable error listing every missing one at once.
export function requireKeys(providers) {
  const missing = [];
  for (const p of new Set(providers)) {
    const envKey = ENV_KEY_FOR[p];
    if (!envKey) throw new Error(`Unknown provider "${p}"`);
    if (!process.env[envKey]) missing.push(`${envKey} (for ${p})`);
  }
  if (missing.length) {
    throw new Error(`Missing required API key(s): ${missing.join(', ')}. Set them in the environment.`);
  }
}

// Which of the given providers are missing their API key. Used to degrade the
// panel gracefully (warn + run the judges we can) rather than hard-fail.
export function missingKeys(providers) {
  return [...new Set(providers)]
    .filter((p) => !process.env[ENV_KEY_FOR[p]])
    .map((p) => ({ provider: p, envKey: ENV_KEY_FOR[p] }));
}

export function describeModels() {
  const m = models;
  return [
    `  orchestrator (SUT, not called directly): ${ORCHESTRATOR.provider}/${ORCHESTRATOR.model}`,
    `  simulated user:                          ${m.simulatedUser.provider}/${m.simulatedUser.model}`,
    `  judge (Tier A):                          ${m.judgeA.provider}/${m.judgeA.model}`,
    `  panel (Tier B):                          ${m.panel.map((j) => `${j.provider}/${j.model}`).join(', ')}`,
    `  distinctiveness attributor:              ${m.distinctiveness.provider}/${m.distinctiveness.model}`,
    `  substance judge:                         ${m.substance.provider}/${m.substance.model}`,
    `  synthesis judge:                         ${m.synthesis.provider}/${m.synthesis.model}`,
  ].join('\n');
}
