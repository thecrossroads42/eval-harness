# The Crossroads Eval Harness — Specification & Documentation

**What this is.** The complete specification and
documentation for the *testing system* — the automated
harness that validates whether The Crossroads keeps the
promises it makes, and that detects regressions whenever its
prompts change. This document covers the harness only. The
application it tests (The Crossroads itself — its manifesto,
voices, orchestration, memory) is treated here as an external
**system under test (SUT)** and is documented separately in
that system's own `SYSTEM-SPEC.md`; this document references
it rather than reproducing it.

**Status.** Specification, not yet implemented. The data the
harness consumes (personas, scenarios, policies) is authored
and included. The program that runs them is specified here
and in `harness-build-brief.md`, to be built against the real
codebase.

**Audience.** Engineering handoff (to build the harness) +
founder's reference (to run it and read its results).

---

## 0. Package contents

The published engine (`@thecrossroads42/eval-harness`) ships the program
and its method — not the answer key:

```
eval-harness/
├── bin/harness, runner, judges, store, reporter   the engine
├── spec/
│   ├── HARNESS-SPEC.md          ← this document (entry point)
│   ├── harness-build-brief.md   intent/product spec for a builder
│   ├── harness-architecture.md  component design & rationale ("how")
│   ├── run-count-policy.md      how many repeats per test; reading pass rates
│   └── panel-judging-protocol.md  how the multi-model + human panel operates
├── schemas/
│   ├── personas-schema.md       what a persona is and how it's structured
│   └── scenarios-schema.md      what a scenario is and how it's structured
├── standing-rubric.json         conditional promise-checks for real sessions
└── example/                     one persona + one scenario, runs out of the box
```

What it does **not** ship is the **battery** — the authored
`personas.json`, `scenarios.json`, and the `promise-test-map.md` coverage
ledger that probe The Crossroads' specific failure modes, plus the matrix
design (which cells exist and why). The battery is the private *input* the
engine consumes: point `EVALS_DIR` at your own, or run the bundled
`example/`. The split is deliberate — the *method and criteria* are
published (so the harness can be audited and reused), the *probe inputs*
are withheld (so the test can't be gamed). The schemas tell you how to
author your own.

Reading order for the method: this doc → build-brief → architecture →
schemas. Reading order for running it: this doc → run-count-policy →
panel-judging-protocol.

---

## 1. Why this system exists

The Crossroads makes specific behavioral promises — it stages
genuine disagreement instead of giving false answers; it
refuses to recommend on questions that have no single answer;
it answers plainly on questions that do; it handles distress
with care; it does not optimize for engagement. (The full
list, and where each is enforced in the SUT, is in the main
SYSTEM-SPEC; the harness's own coverage of them is in
`data/promise-test-map.md`.)

Those promises are currently *design intentions*. No one has
verified the system behaves that way, and no one can check it
by hand at any useful scale — each test is a full multi-turn
conversation that must be played as a difficult user and then
judged. This system automates that, for two purposes:

1. **Validation** — produce evidence that the SUT does (or
   does not) deliver on each promise, so claims rest on
   measurement rather than hope.
2. **Regression detection** — every time a prompt in the SUT
   changes, re-run and show whether the change helped the
   target behavior *and* whether it broke anything else.
   Prompt edits have non-local effects; a fix for one case
   routinely breaks another, silently. This is what makes
   that visible.

The deeper goal: turn "improve the prompts" from a
vibes-driven activity into a measured loop where every change
is checked against the whole set of promises before it is
accepted.

---

## 2. The system under test (minimum context)

The harness needs to know only a few things about The
Crossroads to do its job; everything else is in the main
SYSTEM-SPEC.

- The SUT is a multi-voice advisory system. A user brings a
  life question; a moderator ("the Keeper") reads the
  situation, selects relevant advisor "voices," runs a
  debate, and produces an outcome (a synthesis, a reframed
  question, a staged choice, or an action plan).
- The harness drives the SUT through a **CLI frontend** (a
  thin client on the real backend; specified separately). The
  CLI exposes a non-interactive, reactive driver mode so an
  external program can sit in the user's seat — see §4.
- The SUT is **stochastic**: the same input produces
  different outputs across runs. This is why a single run is
  noise and why the harness measures pass *rates* (§6).
- The harness MUST exercise the real orchestration through
  the CLI, never a reimplementation of it (§3, principle 1).

---

## 3. The principles that make the results trustworthy

These matter more than any feature. Get one wrong and the
harness produces confident, false results.

**1 — It tests the real system, never a copy.** The harness
drives the actual backend orchestration through the CLI. It
must not reimplement, stub, or simplify any orchestration to
make testing easier. The moment the thing tested diverges
from the thing that ships, every result is a lie about a
system that does not exist. This is the single most important
rule.

**2 — The simulated user behaves like a real, difficult
person, not a helpful tester.** Real users are vague, guarded,
contradictory, sometimes hostile, and do not answer the
question they were asked. An AI playing the user defaults to
cooperative and articulate, which walks the SUT down its easy
path and reports that everything works — then real users hit
the cracks never tested. Each persona's defined behavior
(withholding, escalating, resisting, deflecting) must
actually appear in the transcripts. The simulated user is not
trying to help; it is a person with a problem and a stance.

**3 — Validate the simulated users before trusting any
result.** Run a few personas, read the *user side* of the
transcripts by hand, confirm they behave as written. If they
break character or default to agreeable, every downstream
number is contaminated and worse than no number, because it
will be believed. This is a precondition, not a nicety.

**4 — Judging is honest about what it can reliably judge.**
Objective checks (did a plan appear, did it refuse to
recommend, did it avoid naming methods) → a model judge is
reliable. Fairness checks (did it stage both sides with equal
force, or favor the side the user leaned toward) → a model
judge is unreliable, because "compelling" is graded against
its own leanings and it may read prompts it helped write
charitably. Fairness checks therefore require a panel and a
human (see `panel-judging-protocol.md`). Resonance ("would a
real person feel met") is not a model-judge task at all —
collect for human review, do not auto-score.

**5 — Every check is answered with evidence.** The judge
quotes the specific text that satisfies or violates each
check, or marks none-found. If it cannot quote text that
affirmatively passes a check, it scores a fail — it does not
pass ambiguous output by default. ("No quote, no pass.")

**6 — A single run is noise.** Each persona × scenario runs
several times; the result is a pass *rate*, not pass/fail. A
promise meant to always hold that holds 7/10 is failing, not
70%-passing. Safety-critical tests must pass essentially
every time. See `run-count-policy.md`.

**7 — Everything is stamped with prompt versions.** Every
transcript and result records which version of every SUT
prompt produced it. Without this you cannot tell improvement
from variance, nor catch the regression where fixing one test
broke another. Full transcripts are kept, not just scores.

**8 — Crisis tests use a realistic signal, not realistic
content.** Testing crisis handling checks the SUT's *response*
to a distress signal. A brief, non-graphic signal triggers
the protocol fully. The harness never generates graphic
self-harm content. Such transcripts are flagged sensitive.

---

## 4. How it works (component overview)

Full design and rationale: `harness-architecture.md`. In
brief, five components:

- **Loader** — reads the data files, expands the run matrix
  (each scenario × its bound personas × N repeats per
  policy). Fairness scenarios also run a neutral baseline
  persona.
- **Runner** — for each run, starts a real session via the
  CLI, and **plays the user** via a separate simulated-user
  model held in character. This is a *live reactive driver*:
  it receives each SUT turn and generates the next user turn
  in response, in character, to the end of the visit — only
  the first turn (the scenario's opening message) is fixed.
  There is no fixed-script mode (a persona's behavior exists
  only in how it reacts). Runs to a natural end or a turn cap.
- **Judge** — scores each transcript against its scenario's
  checklist, evidence-cited; routes by reliability tier (A
  process / B fairness / C resonance — see §5).
- **Transcript Store** — full transcripts, version-stamped,
  with sensitive transcripts handled carefully.
- **Reporter** — clusters failures by promise, diffs across
  prompt versions, optionally proposes leads (never
  auto-applies).

The simulated-user model MUST be a different model from the
orchestrator under test, and ideally a different family from
the judges, to avoid a model talking to and grading itself.

---

## 5. Judging tiers and the panel

The harness judges at three reliability tiers; this is the
core of why its results can be trusted.

- **Tier A — process / refusal checks** (did CASE 5 fire, was
  a plan produced, were methods named). Near-mechanical. A
  single model judge (Opus) is reliable.
- **Tier B — fairness / tilt / equal-force checks.** A single
  judge is least reliable here. Requires the **panel**:
  multiple model judges from different labs/families plus a
  human, run independently and blind, with disagreement used
  to route human attention rather than averaged away. Full
  operating rules — composition, the shared-bias rule, the
  human's role — are in `panel-judging-protocol.md`.
- **Tier C — resonance.** Not a model task. Human-only,
  deferred until real users exist; collected, not auto-scored.

The fairness checks (Tier B) are the SUT's core
differentiator and the thing a skeptic attacks first, which
is exactly why they are the hardest to judge and get the
heaviest machinery. Never report a fairness verdict as final
on a single judge.

---

## 6. What the results must look like

After a run, expect:

- **A per-promise scorecard** — pass rate per promise across
  all tests covering it, repeat counts visible; stated most
  usefully where it *failed* ("the fork collapsed into a
  recommendation in 3/10 family-fork runs under pressure").
- **Failures clustered by pattern**, not listed individually
  — the systematic finding is the valuable one.
- **Fairness/tilt findings as direction + magnitude, with
  quotes** — "the self-authorship voice got warmer, longer
  treatment than the obligation voice in 4/5 runs, including
  the neutral baseline."
- **Readable misses** — every failure links to its full
  transcript and the judge's quoted evidence.
- **Variance reported, not hidden** — a 9/10 with one
  catastrophic miss is worse than a stable 85%.
- **A clean version-to-version diff** — on a prompt change:
  which promises improved, regressed, held, at equal repeat
  counts. The headline output, looked at on every change.
- **Safety results unmissable** — crisis results reported
  separately; any failure blocks acceptance of that prompt
  version regardless of other scores.
- **Leads, clearly marked as leads** — hypotheses about a
  failure cluster's cause, never edits to apply.

---

## 7. The loop this enables (the point of it all)

1. Stamp current SUT prompt versions.
2. Run the full matrix.
3. Read the per-promise scorecard and clustered failures.
4. Form a hypothesis about one change.
5. Make exactly one change to the SUT.
6. Re-run the **whole** matrix.
7. Diff against the previous version: did the target improve,
   and did anything else regress?
8. Accept only if net-positive across the whole set.
   Re-stamp. Repeat.

The discipline the tooling must encourage and never
undermine: **change one thing, re-run everything, diff.** The
test set deliberately includes cases where the correct
behavior is a confident recommendation (not a fork) and cases
that bait over-forking — so a change that improves
fork-staging cannot silently start forking questions that
have real answers without the diff catching it.

---

## 8. Build order (suggested)

The minimum useful version is reachable early.

1. Session running + transcript capture + version stamping —
   real, stamped transcripts flowing through the CLI against
   the real backend.
2. Simulated-user behavior check — hand-validate a few
   personas before trusting anything.
3. Tier-A judging only — this alone is a working regression
   detector, which is most of the value. Ship it.
4. Reporting: per-promise scorecard, clustered failures,
   version diff.
5. Tier-B panel judging (multi-model + human) per
   `panel-judging-protocol.md`; human-review routing for B
   and C.
6. Lead proposal last, as hypotheses.

Step 3 is the minimum viable harness: it closes the loop and
catches regressions automatically on every prompt change. Do
not block the loop waiting for a perfect fairness judge.

---

## 9. Known weaknesses of the harness itself

The harness has its own weak points, distinct from the SUT's.
For the SUT's weaknesses see its KNOWN-WEAKNESSES doc; the
harness-specific ones:

- **The judge is partly self-judging on fairness.** The first
  judge (Opus) may share a lineage with the SUT's prompt
  author and grades "compelling" against its own dispositions.
  Mitigated by the panel and the shared-bias rule, not cured.
- **The simulated user is an unvalidated instrument until the
  §3.3 gate is honored.** A cooperative simulated user makes
  the whole report a confident lie. The risk is the temptation
  to skip the gate under time pressure.
- **Model-vs-model artificiality.** A simulated user is a
  model talking to a model; the two can fall into an
  unnaturally smooth rhythm no real distressed human produces.
  The harness buys scale and consistency at some cost in
  realism — keep occasional *human*-driven sessions as a
  reality check on what the simulated ones smooth over.
- **Shared cultural priors across the panel.** Decorrelation
  reduces but does not eliminate the case where all model
  judges agree and all are wrong in a direction the culture
  leans. The shared-bias rule (panel protocol) inverts the
  hierarchy on the named scenarios where this is likely.
- **Auto-suggest is low-trust and tempting to over-trust.**
  Proposed prompt edits have no view of the cases they might
  break; they are leads, re-validated against the whole matrix
  before acceptance, never auto-applied.
- **Coverage is thin on some promises.** A few promises rest
  on a single scenario; the epistemics fork has no test yet
  (it wants a behavioral routing test, not a symmetry one).
  See `data/promise-test-map.md` for the current ledger and
  intentional gaps.

---

## 10. The constraints to never relax

If time pressure forces a shortcut, do not let it be either of
these:

- Reimplementing or stubbing the SUT orchestration "just to
  get tests running" — this silently invalidates everything.
- Skipping the simulated-user behavior check — this makes the
  whole report a confident lie.

Everything else can be staged, simplified, or deferred. These
two cannot.
