// =============================================================================
// `harness literary` — the run-and-read mode for the literary persona PROBE
// (spec Part A, A2). A sibling of `validate`, not of `run`: it reuses the
// runner's transport but is its own command with its own no-judge, read-by-hand
// output.
//
// Each literary persona (schemas/literary-personas-schema.md) is a self-contained
// probe — it carries its own opening message, so there is NO scenario and NO
// combinatorial expansion. It is run ONCE, alone. The deliverable is the full
// transcript, surfaced for the EDITOR to read (the human turns especially) — NOT
// an automated quality judgment. The only automated signal is the
// cooperative-drift pointer (literary-drift.js), which is a pointer, not a verdict.
//
//   harness literary                 run every literary persona, write transcripts
//   harness literary --persona <id>  run a single one
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assertHygiene, requireKeys, models, apiUrl, EVALS_DIR, LITERARY_DIR,
} from './config.js';
import { computeVersion } from './version.js';
import { runOne } from './runner.js';
import { checkBackend } from './authBackend.js';
import { nextLiteraryUserTurn } from './simulated-user.js';
import { fullTranscriptText, userSideText } from './store.js';
import { analyzeDrift, formatDriftPointer } from './literary-drift.js';

export async function loadLiteraryPersonas() {
  const raw = await fs.readFile(path.join(EVALS_DIR, 'literary-personas.json'), 'utf8');
  return JSON.parse(raw).literary_personas || [];
}

export async function runLiterary({ only = null, creditUsd } = {}) {
  assertHygiene();
  requireKeys([models.simulatedUser.provider]);
  // Provisioning comes from the auth backend (injected admin provisioner, or BYO
  // token); runOne surfaces a clear error if neither is configured.
  if (!(await checkBackend())) throw new Error(`backend not reachable at ${apiUrl}.`);

  const version = await computeVersion();
  let personas = await loadLiteraryPersonas();
  if (only) {
    personas = personas.filter((p) => p.id === only);
    if (personas.length === 0) throw new Error(`no literary persona "${only}" in literary-personas.json.`);
  }
  if (personas.length === 0) throw new Error('no literary personas found in literary-personas.json.');

  await fs.mkdir(LITERARY_DIR, { recursive: true });
  process.stdout.write(`Running ${personas.length} literary persona(s) on version ${version.key}.\n`);
  process.stdout.write(`sim user: ${models.simulatedUser.provider}/${models.simulatedUser.model}\n`);
  process.stdout.write('These are PROBES: read the HUMAN turns, judge the persona — not the voices. No automated verdict.\n');
  if (process.env.HARNESS_LOG) process.stdout.write(`live log: ${process.env.HARNESS_LOG} (tail -f it)\n`);
  process.stdout.write('\n');

  for (const persona of personas) {
    process.stdout.write(`— ${persona.id} ...\n`);
    // Synthetic scenario: the persona carries its OWN opening, and there is no
    // scenario to fan out against — literary personas are never combinatorial.
    // setup:null means applySetup is a no-op (arrives as a first visit).
    const scenario = { id: `literary:${persona.id}`, opening_message: persona.opening_message, setup: null };
    const t = await runOne({
      scenario,
      persona,
      repeatIndex: 0,
      version,
      keep: false,      // never archive a probe transcript to showcase/
      writeRuns: false, // never let it enter the judged runs/ set
      creditUsd,
      nextTurn: ({ turns }) => nextLiteraryUserTurn({ persona, turns }),
    });

    const drift = analyzeDrift(t);
    const block =
      `# Literary probe: ${persona.id}\n\n` +
      'READ THE HUMAN (USER) TURNS. One question: would a real person like this own these —\n' +
      'the evasions, the contradictions, the arguing-against-own-interest, the refusal of the\n' +
      'obvious point? Bracket the voices: at this stage the PROBE is what is judged, by you,\n' +
      'not by a model. If the turns ring true you have a valid instrument; if they flatten (or\n' +
      'start faithful and decay) that is itself the finding.\n\n' +
      `status: ${t.status}   endReason: ${t.endReason}   chatTurns: ${t.chatTurns}\n\n` +
      '## What this persona is concealing (named to the model, forbidden from its speech)\n' +
      `${persona.unspoken_thing?.truth || '(unspecified)'}\n\n` +
      `${formatDriftPointer(drift)}\n\n` +
      '## USER SIDE (read this first)\n\n' +
      `${userSideText(t)}\n\n` +
      '## FULL TRANSCRIPT\n\n' +
      `${t.rendered || fullTranscriptText(t.turns)}\n`;

    const txtPath = path.join(LITERARY_DIR, `${persona.id}.txt`);
    await fs.writeFile(txtPath, block);
    await fs.writeFile(path.join(LITERARY_DIR, `${persona.id}.json`), JSON.stringify({ ...t, drift }, null, 2));
    process.stdout.write(
      `  status=${t.status} turns=${t.chatTurns}` +
      `${drift.flagged ? '  ⚡ cooperative-drift (see pointer)' : ''} ` +
      `→ ${path.relative(process.cwd(), txtPath)}\n`
    );
  }

  process.stdout.write(
    `\nDone. Read the USER side of each transcript in ${path.relative(process.cwd(), LITERARY_DIR)}/.\n` +
    'Ask of the human turns only: would the depicted own these words? The drift flag (if any)\n' +
    'is a POINTER to where to look, never a verdict on the probe.\n'
  );
}
