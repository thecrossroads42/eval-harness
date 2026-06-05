// =============================================================================
// Version stamping. The version key fingerprints the SUT prompt set so the
// reporter can diff pass-rates across prompt versions and catch the regression
// where fixing scenario X silently broke scenario Z.
//
// The CLI also emits a git SHA (it pins prompts+models+code together); we record
// that alongside. But the content hash is the diff key because it stays stable
// and meaningful even when the working tree is dirty mid edit-rerun-diff loop.
//
// We only READ these files to hash them — never execute them.
// =============================================================================

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './config.js';

// Roots under which prompt content lives. All authored content sits in the
// top-level `corpus/` directory. Under these roots we fingerprint only the SUT
// prompt set — the prompt templates and the orchestration config that shape
// model behavior (see `isPromptFile` for the exact rule), not authoring docs.
//
// Keep this list EXPLICIT — never broaden it to the whole `corpus/` tree. The
// test battery (`corpus/evals/`) is authored content under corpus/ too, but it
// is the measuring instrument, not the SUT: fingerprinting it would make the
// ruler change the version of the thing it measures. It is excluded by virtue of
// not being listed here, and must stay that way.
const ROOTS = [
  'corpus/prompts',
  'corpus/voices', // voice config.yaml + groups.yaml/pairs.yaml/featured-pairs.yaml
  'corpus/keeper',
];

// Is this file part of the SUT prompt set? Only the files that actually shape
// model behavior count — not every .md/.yaml that happens to sit under a ROOT:
//   - all *.yaml         → orchestration config (voice/keeper config.yaml,
//                          featured*/groups/pairs under voices/)
//   - prompt.md          → a voice's or the Keeper's system prompt
//   - *.md under prompts → the LLM prompt templates
// Authoring / reference docs that live beside the prompts (e.g.
// corpus/voices/AUTHORING_A_VOICE.md) are deliberately EXCLUDED: the model never
// sees them, so fingerprinting them would bump the version key on doc-only edits
// — a false "new SUT version" with no behavior change.
function isPromptFile(full) {
  const name = path.basename(full);
  if (name.endsWith('.yaml')) return true;
  if (name === 'prompt.md') return true;
  const parts = path.relative(REPO_ROOT, full).split(path.sep);
  return name.endsWith('.md') && parts[0] === 'corpus' && parts[1] === 'prompts';
}

async function walk(dir, acc) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, acc);
    } else if (e.isFile() && isPromptFile(full)) {
      acc.add(full);
    }
  }
}

export async function collectPromptFiles() {
  const set = new Set();
  for (const r of ROOTS) await walk(path.join(REPO_ROOT, r), set);
  return [...set].sort();
}

export async function computeVersion() {
  const files = await collectPromptFiles();
  const hash = createHash('sha256');
  const perFile = [];
  for (const f of files) {
    const buf = await fs.readFile(f);
    const fileHash = createHash('sha256').update(buf).digest('hex');
    const rel = path.relative(REPO_ROOT, f);
    hash.update(rel).update('\0').update(buf).update('\0');
    perFile.push({ path: rel, sha256: fileHash.slice(0, 12) });
  }
  const fullHash = hash.digest('hex');
  return {
    key: fullHash.slice(0, 12), // the diff key
    fullHash,
    fileCount: perFile.length,
    files: perFile,
  };
}
