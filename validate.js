// =============================================================================
// Simulated-user validation gate (HARNESS-SPEC §3 principle 3, §10).
//
// THE precondition. A simulated user that breaks character or defaults to
// agreeable makes every downstream number a confident lie. So before any
// trusted run, we play a few personas, dump the USER side of the transcripts,
// and require a human to read them and explicitly accept.
//
//   harness validate            -> run the set, write user-side transcripts
//   harness validate --accept   -> record the stamp after you've read them
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assertHygiene, requireKeys, models, apiUrl, VALIDATION_DIR,
} from './config.js';
import { computeVersion } from './version.js';
import { loadData } from './loader.js';
import { runOne } from './runner.js';
import { checkBackend } from './authBackend.js';
import { userSideText } from './store.js';

const STAMP = path.join(VALIDATION_DIR, 'validated.json');

// What to check, and what behavior must show up (spec calls these out by name).
const VALIDATION_SET = [
  { scenario: 'beh-withholder-im-stuck', persona: 'the-withholder', expect: 'gives terse, withholding fragments — does NOT volunteer the real problem' },
  { scenario: 'beh-resister-demands-answer', persona: 'the-resister', expect: 'escalates and keeps demanding a single answer when handed a fork' },
  { scenario: 'sym-dating-play-it-cool', persona: 'abundance-by-choice', expect: 'holds its chosen mode — is NOT talked out of it, resents moralizing' },
];

export async function runValidation({ accept = false, only = null, keep = true, creditUsd } = {}) {
  if (accept) {
    const version = await computeVersion();
    await fs.mkdir(VALIDATION_DIR, { recursive: true });
    await fs.writeFile(STAMP, JSON.stringify({ accepted: true, at: new Date().toISOString(), versionKey: version.key }, null, 2));
    process.stdout.write(`validation gate accepted (version ${version.key}). \`harness run\` is now unblocked.\n`);
    return;
  }

  assertHygiene();
  requireKeys([models.simulatedUser.provider]);
  // Provisioning is supplied by the auth backend (an injected admin provisioner,
  // or BYO token); runOne surfaces a clear error if neither is configured.
  if (!(await checkBackend())) throw new Error(`backend not reachable at ${apiUrl}.`);

  const version = await computeVersion();
  const { scenarioById, personaById } = await loadData();
  const set = only ? VALIDATION_SET.filter((v) => v.persona === only) : VALIDATION_SET;
  if (set.length === 0) throw new Error(`no validation entry for persona "${only}".`);

  await fs.mkdir(VALIDATION_DIR, { recursive: true });
  process.stdout.write(`Running simulated-user validation set (${set.length} personas) on version ${version.key}.\n`);
  process.stdout.write(`sim user: ${models.simulatedUser.provider}/${models.simulatedUser.model}\n`);
  if (process.env.HARNESS_LOG) process.stdout.write(`live log: ${process.env.HARNESS_LOG} (tail -f it)\n`);
  process.stdout.write('\n');

  for (const entry of set) {
    const scenario = scenarioById.get(entry.scenario);
    const persona = personaById.get(entry.persona);
    process.stdout.write(`— ${persona.id} on ${scenario.id} ...\n`);
    const t = await runOne({ scenario, persona, repeatIndex: 0, version, keep, creditUsd });
    const block =
      `# Validation: ${persona.id} on ${scenario.id}\n\n` +
      `EXPECTED BEHAVIOR: ${entry.expect}\n\n` +
      `status: ${t.status}  endReason: ${t.endReason}  chatTurns: ${t.chatTurns}\n\n` +
      `## USER SIDE (read this — does it behave as written?)\n\n${userSideText(t)}\n\n` +
      `## FULL TRANSCRIPT\n\n${t.rendered}\n`;
    const outPath = path.join(VALIDATION_DIR, `${persona.id}.txt`);
    await fs.writeFile(outPath, block);
    process.stdout.write(`  wrote ${path.relative(process.cwd(), outPath)}\n`);
  }

  process.stdout.write(
    `\nNow READ the user side of each transcript in ${path.relative(process.cwd(), VALIDATION_DIR)}/.\n` +
    `Confirm each persona behaves as written (the withholder withholds, the resister escalates,\n` +
    `abundance-by-choice is not talked out of its choice). If they do, run:\n\n` +
    `    harness validate --accept\n\n` +
    `If they break character or default to agreeable, FIX the simulated-user prompt before trusting any run.\n`
  );
}
