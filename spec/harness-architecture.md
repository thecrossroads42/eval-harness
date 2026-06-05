# The Crossroads Eval Harness — Architecture

This is the design for the testing program (program #2). It drives
real Crossroads sessions using personas + scenarios, captures
transcripts, judges them against the rubrics, and reports failures
clustered by manifesto promise. It does NOT auto-apply prompt
edits.

The companion program #1 (CLI frontend) is the thin client the
harness drives. The single most important architectural constraint
applies to both: **the harness exercises the real orchestration
code path — the same `buildMegaBatchSystemPrompt` /
`streamMegaBatch` the production app uses — by importing it, never
by reimplementing it.** The CLI is a new frontend on the same
backend. The moment the harness and production can drift, the
harness stops measuring production.

---

## Components

```
┌─────────────────────────────────────────────────────────────────┐
│  HARNESS (program #2)                                             │
│                                                                   │
│  ┌────────────┐   ┌──────────────┐   ┌─────────────────────┐     │
│  │  Loader    │──▶│   Runner     │──▶│   Judge             │     │
│  │ personas + │   │ drives the   │   │ scores transcripts  │     │
│  │ scenarios  │   │ session via  │   │ against rubrics;    │     │
│  │            │   │ simulated    │   │ comparative pass    │     │
│  │            │   │ user + real  │   │ for symmetry        │     │
│  │            │   │ backend      │   │                     │     │
│  └────────────┘   └──────┬───────┘   └──────────┬──────────┘     │
│                          │                      │                │
│                   ┌──────▼───────┐       ┌──────▼──────────┐     │
│                   │ Transcript   │       │ Reporter        │     │
│                   │ Store        │       │ cluster by      │     │
│                   │ (versioned)  │       │ promise; diff   │     │
│                   └──────────────┘       │ across runs;    │     │
│                                          │ propose leads   │     │
│                                          └─────────────────┘     │
└───────────────────────────────┬─────────────────────────────────┘
                                 │ imports, does not reimplement
                ┌────────────────▼─────────────────┐
                │  REAL BACKEND (shared with prod)  │
                │  orchestration + voice prompts +  │
                │  config (pairs) + memory          │
                └───────────────────────────────────┘
```

### 1. Loader
Reads `personas.json` and `scenarios.json`. Expands the run
matrix: for each scenario, the bound personas (and
`genuinely-torn` for symmetry baselines). Emits a list of **run
specs**, each = (scenario_id, persona_id, repeat_index). Supports
`--repeat N` because LLM outputs vary run-to-run; thin promise
coverage is compensated by repetition, not by more scenarios. A
promise's pass rate is meaningful only across repeats.

### 2. Runner — the simulated user + the real session
For each run spec:
- Starts a real session through the CLI/backend (same
  orchestration as prod).
- Plays the user via a **simulated-user model**, held in character
  by a system prompt built from the persona's
  `conversational_behavior` + the scenario's
  `user_followups_guidance` + the simulated-user contract from
  `personas-schema.md`.
- The simulated user receives each Keeper/voice turn and responds
  in character, deciding per its profile whether to withhold,
  escalate, deflect, or open up. It is NOT told the rubric and is
  NOT trying to help the system — it is a person with a problem
  and a stance.
- Runs until a natural end (plan accepted/rejected, fork returned,
  session closed) or a `max_turns` cap (suggest 12 — long enough
  for inquiry + debate + summary, capped so a stuck loop doesn't
  run forever).
- Writes the full transcript to the Transcript Store.

**Two-model hygiene.** The simulated user MUST be a different
model instance/role than the orchestrator under test, and ideally
a different model family than the judge, to avoid a single model
talking to itself and grading itself (correlated blind spots). At
minimum: distinct system prompts, distinct API roles, no shared
context.

**Simulated-user validation gate.** Before trusting ANY results,
run 2–3 personas and read the user-side transcripts by hand.
Confirm the-withholder withholds, the-resister escalates,
abundance-by-choice does not get talked out of its choice. A
simulated user that breaks character or defaults to cooperative is
a measurement instrument that lies — worse than no instrument,
because you'll trust it. Gate the full run behind this check.

### 3. Judge
Scores each transcript against its scenario's `judge_rubric`.
Binding rules (from `scenarios-schema.md`): evidence-citing (quote
the text that satisfies/violates each check, or mark "none
found"); refusals scored as first-class; **no quote → no pass**
(every `fail_means` carries this). The judge sees `check`,
`pass_means`, `fail_means`, and `cite` for each check and returns
per-check {pass|fail, quoted_evidence, note}.

**Symmetry judging is comparative and separately gated.** For
symmetry scenarios the judge also runs the `symmetry_judge_rubric`
over the PAIRED/TRIPLED transcripts (leaning runs + neutral
baseline), scoring the DELTA: does the voice matching the user's
lean get more words / the last word / more vivid or charitable
framing than its opposite, and do the leaning runs diverge from
the neutral baseline's balance? It reports the tilt with quotes.

**Judge-reliability tiers (from the earlier flag — the judge has
dispositions, and helped write the prompts):**
- Tier A — process-compliance & refusal checks (did CASE 5 fire /
  not fire, was a plan produced, were methods named): LLM judge
  alone is reliable. The specific `fail_means` and "no quote no
  pass" constrain it well.
- Tier B — symmetry / tilt / "equal force" checks: LLM judge is
  LEAST reliable here because "compelling" is graded against its
  own leanings. REQUIRE a second signal — a second judge model
  from a different family, and/or human review. The harness flags
  every Tier-B result `needs_second_judge: true` and does not
  report a symmetry verdict as final on one judge.
- Tier C — resonance ("would a real person feel met"): NOT an
  LLM-judge task. Routed to human review only; the harness
  collects but does not score these.

Each check in the rubric should be tagged with its tier (add a
`tier` field), or the judge infers it: comparative/"equal
force"/"tilt" language → Tier B; everything cite-and-confirm →
Tier A. The crisis method-naming check is Tier A but flagged
`critical: true` — a fail there fails the whole scenario
regardless of other checks.

### 4. Transcript Store
Every transcript stamped with: scenario_id, persona_id,
repeat_index, timestamp, and — critically — the **versions of
every prompt that produced it** (mega-batch vN, each voice prompt
vN, keeper persona vN, config/pairs vN). Without version stamping
you cannot tell improvement from noise, and cannot catch the
regression where fixing scenario X broke scenario Z. Store full
transcripts, not just scores: when a Tier-B check fails you must
read WHY, and the score alone won't tell you. `sensitive: true`
transcripts (crisis personas) are stored with restricted handling
and never used as few-shot fuel.

### 5. Reporter
- **Detect & categorize** (high trust): per-check pass/fail across
  the matrix.
- **Cluster by promise** (high value): "the fork was synthesized
  in 4/10 power-fork runs", "abstinence defaulted in 3/6
  compulsion runs". This is the gold — it points at a systematic
  behavior, not a one-off.
- **Diff across prompt versions** (high value): same matrix, two
  prompt versions, what changed — this is the regression detector.
  Run it on EVERY prompt change.
- **Propose leads** (low trust — leads, not fixes): hypotheses
  about cause. NEVER auto-applied. A suggested edit has no view of
  the other runs it might break; prompt changes have non-local
  effects (you have seen this repeatedly). Any proposed edit is
  re-validated against the WHOLE battery before acceptance.

---

## The improvement loop (validate first, then improve)

```
1. Stamp current prompt versions.
2. Run full matrix (all scenarios × bound personas × N repeats).
3. Judge (Tier A auto; Tier B second-signal/human; Tier C human).
4. Reporter clusters failures by promise.
5. Human reads clustered failures + transcripts, forms a hypothesis.
6. Make ONE prompt change.
7. Re-run the WHOLE matrix (not just the failing scenario).
8. Diff vs the prior version: did the target failure improve AND did anything regress?
9. Accept only if net-positive across the battery. Re-stamp versions. Goto 2.
```

The discipline that makes this work: **change one thing, re-run
everything, diff.** The failure mode to refuse is optimizing
toward the eval until the eval is all you measure — which is why
the battery includes `settled-question` and the tactical traps: if
a change raises fork-quality but starts forking tractable
questions, the diff catches it.

---

## Build order

1. **CLI frontend (program #1)** on the shared backend — the thing
   the harness drives.
2. **Runner + Transcript Store** with version stamping — get real
   transcripts flowing.
3. **Simulated-user validation gate** — hand-check 2–3 personas
   before trusting anything.
4. **Judge, Tier A only** — process-compliance/refusal checks;
   this alone gives you a regression detector on every prompt
   change, which is most of the value.
5. **Reporter: cluster + version-diff.**
6. **Judge Tier B** (second signal) + human review hooks for Tier
   B/C.
7. **Propose-leads** last, treated as hypotheses.

Tier-A-only judging (step 4) is the minimum viable harness: it
closes the loop and catches regressions automatically. Everything
after sharpens it. Do not block the loop waiting for the perfect
fairness judge — ship the Tier-A regression detector, add Tier B
as the second-signal pipeline comes online.

---

## What this harness deliberately does NOT do
- Does not reimplement orchestration (imports the real path).
- Does not auto-apply prompt edits (proposes leads; human +
  full-battery re-run decides).
- Does not treat one LLM judge as authoritative on tilt/fairness
  (Tier B needs a second signal).
- Does not generate graphic crisis content to "stress test" safety
  (a non-graphic signal triggers the protocol fully).
- Does not score resonance with an LLM (Tier C is human-only).
