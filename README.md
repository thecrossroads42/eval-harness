# @thecrossroads42/eval-harness

The eval **engine** behind [The Crossroads](https://thecrossroads.to) — the part
that drives a real visit, plays a difficult user, and judges the transcript. It
talks to the system **only over the public API** (via
[`@thecrossroads42/cli`](https://github.com/thecrossroads42/cli) in `--json`
mode), so it exercises exactly what a real client hits — it never imports or stubs
the orchestration.

You point it at **your own account** and **your own persona + scenario battery**
(or the bundled example) and get back judgments: per-scenario rubric verdicts and,
for real sessions, the **standing promise-rubric**.

## What's here (and what isn't)

Published — the *method* and the *criteria*:

- the runner, the simulated-user driver, and the judges (Tier-A process judge,
  the Tier-B fairness panel, the convergence panel — distinctiveness / substance /
  synthesis — and the standing-rubric judge);
- the **standing rubric** (`standing-rubric.json`) — the conditional
  promise-checks the engine scores a real session against, **including the
  critical `crisis-protocol` check**;
- the **persona / scenario schemas** (`schemas/`) and the methodology specs
  (`spec/`);
- a runnable **`example/`** (one persona, one scenario).

Withheld by design — the *probe inputs*, not the method:

- The Crossroads' own authored **battery** (the specific personas and scenarios
  that probe its failure modes) and its coverage ledger stay private. Publishing
  the criteria but not the probes is deliberate: it lets the standing rubric be
  audited and reused without handing over a test that could be gamed. Crisis
  handling in particular is a critical promise-check — we publish *that we test
  it and the bar it must clear*, not the inputs that trigger it.

## Use

Requires Node ≥ 20. You provide model API keys (the judges call Anthropic /
OpenAI / Google) and an account on the target deployment.

```sh
npm install        # installs the LLM SDKs; pulls the CLI from GitHub (optional)

# Point at a deployment and your account:
export API_URL=https://thecrossroads.to
export HARNESS_TOKEN=tcr_…            # your personal API key (Settings → API access)
export OPENAI_API_KEY=…              # the simulated user
export ANTHROPIC_API_KEY=…           # the Tier-A / standing judge
# export GEMINI_API_KEY=…            # optional third member of the fairness panel

# Run the bundled example (one persona × one scenario), then judge it:
npx harness run --scenario example-promotion-vs-time --repeat 1 --force
npx harness judge --tier a
```

Bring your own battery by pointing `EVALS_DIR` at a directory holding
`personas.json` + `scenarios.json` in the documented shape (`schemas/`):

```sh
EVALS_DIR=./my-evals npx harness run --force
```

Run `harness help` for the full command set (`validate`, `run`, `ingest`,
`judge`, `review`, `report`, `convergence`, `scorecard`, `clean`).

### Auth: bring your own account

By default the engine runs against **one pre-existing account**, authenticating
with `HARNESS_TOKEN` (a `tcr_` API key, or a user id). It never creates, credits,
or deletes users — the account funds itself, just like any other client. Runs are
metered against that account's balance.

(The Crossroads' own operator setup injects an admin provisioner via
`HARNESS_AUTH_BACKEND` to mint a throwaway user per run; that hook is unused in
the BYO path.)

## Configuration

| Env | Meaning | Default |
|---|---|---|
| `API_URL` | backend to test against | `http://localhost:3001` |
| `HARNESS_TOKEN` | the account the runs bill to | — (required for BYO) |
| `EVALS_DIR` | your persona/scenario battery | the bundled `example/` |
| `HARNESS_OUT` | where run artifacts are written | the current directory |
| `HARNESS_CLI` | path to the CLI to drive | the `@thecrossroads42/cli` dependency |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | judge + simulated-user model keys | — |

## Source

This is the published copy of code developed in The Crossroads' **private**
repository and mirrored here. Please open issues at
[github.com/thecrossroads42/theCrossroads](https://github.com/thecrossroads42/theCrossroads/issues)
rather than sending pull requests against this copy.
