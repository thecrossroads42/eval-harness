# Literary Personas — Structured Schema

This is the **machine-readable** companion to
[`literary-persona-template.md`](./literary-persona-template.md). The template is
the authoring craft (read it first); this file is the JSON shape `harness
literary` consumes. The authored worked examples (A, B in the template; C–G in
the editor's set) are ingested verbatim into this shape — structuring, never
authoring.

## A literary persona is a different object from an eval persona

The eval personas (`personas-schema.md` / `personas.json`) are **legible,
one-axis, cooperative** test instruments: a *persona* (how someone behaves) is
deliberately separated from a *scenario* (the question they bring), and the
harness runs them **combinatorially** (scenario × bound personas × repeats),
judged against per-scenario rubrics.

A literary persona is the **inverse**, and that inverts the schema too:

- **Self-contained.** It carries its own `opening_message` — the scenario's job
  is folded in. There is no separate scenario and no `bind_personas`.
- **Never combinatorial.** It is run **once, alone**. It must never be expanded
  against scenarios the way eval personas are (different object, different
  purpose). The loader for these (`literary.js`) has no access to the scenario
  list precisely so this can't happen by accident.
- **Never judged.** There is no rubric. At this stage the thing being assessed is
  **the probe itself** (are the human turns real?), by the **editor reading the
  human turns** — not the voices, and not a model. The only automated signal is
  the *cooperative-drift pointer* (below), which is a pointer, not a verdict.

These therefore live in a **separate file** (`literary-personas.json`), never
merged into `personas.json` — where the loader would bind them to scenarios and
the cooperative-persona prompt builder would read fields they don't have.

## Shape

```jsonc
{
  "literary_personas": [
    {
      "id": "kebab-case-handle",          // filing only — NOT a "type" the model performs

      "unspoken_thing": {                  // load-bearing: the engine of interiority
        "truth":           "What is actually true / already decided / really wanted, that this person will NOT say. Named TO the model, forbidden FROM its speech.",
        "presented_story": "The acceptable story they present instead.",
        "crack":           "(optional) what it would take, if anything, for them to finally say it — and whether they ever do."
      },

      "resistances": [                     // load-bearing: what makes the voices work
        {
          "behavior":     "What they DO under pressure (a deflection move, a defensiveness), as authored — third person is fine.",
          "cracks_when":  "The SPECIFIC key that works (not 'a good argument'). null  ⇒  they never give this up in the conversation."
        }
        // 3–4 entries; at least one with cracks_when: null (the thing never conceded).
      ],

      "situation":       "The fast-authored hard particular, 1–2 sentences. Include ONE detail that doesn't fit the clean story.",
      "speech_texture":  "Register + evasion-style (how they avoid when it gets close), NOT vocabulary/catchphrases. 1–2 lines.",
      "arc_permission":  "Explicit license to NOT resolve — leave confused, angry, still inside the story. The prompt builder adds the standing 'do not tidy yourself up' clause on top of this.",
      "opening_message": "The first thing they actually type — presenting the acceptable story, NOT the unspoken thing.",

      "sensitive": false,                  // optional: true ⇒ careful-handling flag + a non-graphic distress rule in the prompt
      "note":      "optional design note (e.g. the soft-direction PURPOSE of example F). Not consumed at runtime."
    }
  ]
}
```

### Field notes

- **`unspoken_thing.truth` is the whole engine.** It is named to the model so it
  can be *played*, and is forbidden from the model's speech — never confessed,
  never volunteered as a hint, never tidied into an end-of-visit insight. The
  prompt builder (`buildLiteraryUserSystem`) states this constraint explicitly.
- **`resistances[].cracks_when`** encodes the template's rule that real people
  yield to the *precise* thing, not to general persuasion. A `null` (or omitted)
  `cracks_when` is the template's "Will never concede X." Author at least one.
- **`arc_permission`** is the anti-flinch field. The builder reinforces it with a
  fixed clause ("you are NOT required to resolve… do not become honest just
  because the conversation is ending"), because the model's gravity is toward a
  clean resolution by the last turn — which is the persona-side failure being
  measured.
- **`sensitive`** mirrors the eval flag's two jobs: it marks the transcript for
  careful handling and (for distress personas) injects a non-graphic distress
  rule. None of the current set are distress; the editor sets this where a
  transcript would be reputationally hazardous if quoted.

## How it runs (`harness literary`)

One pass per persona against the real backend, reusing the runner's transport
(provision → drive the visit → capture transcript). It does **not** write into
`runs/` (so `judge` can never pick it up) and does **not** archive to
`showcase/`. The full transcript + a cooperative-drift pointer are written to
`literary/<id>.txt` (readable) and `literary/<id>.json` (raw) for the editor.

### The cooperative-drift pointer (the one safe automation)

The predicted gravity acts on the **probe** too: a withholding persona tends to
start helpfully articulating its own subtext in later turns. The pointer flags
when a persona's later user turns become markedly longer / more self-aware than
its early ones. It is a **transparent heuristic** (not a model judge — a model
scoring "is this persona good" inherits a flattened prior on the very human
texture being checked) and is **a pointer to where the editor should look, never
a verdict on probe quality**. A flag can mean the persona forgot to withhold OR
the voices genuinely earned the opening — the editor decides by reading.
