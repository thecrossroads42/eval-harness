// =============================================================================
// `harness clean` — prune leaked throwaway users and remove local scratch.
//
// Safe by default: removes only REGENERABLE scratch (transcripts, judgements,
// reports, the review *pending* queue) and prunes leaked example.invalid users.
// It PRESERVES human review verdicts (review/done) and the validation gate stamp
// unless you pass --purge. --dry-run previews without deleting.
//
//   harness clean                 users + safe scratch
//   harness clean --users         only prune leaked throwaway users
//   harness clean --scratch       only remove local scratch
//   harness clean --purge         also wipe review/done + validation (full reset)
//   harness clean --dry-run       show what would be removed, delete nothing
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  RUNS_DIR, JUDGEMENTS_DIR, REPORTS_DIR, REVIEW_DIR, VALIDATION_DIR, REPO_ROOT,
} from './config.js';
import { listHarnessUsers, deleteUser, checkBackend } from './authBackend.js';

const rel = (p) => path.relative(REPO_ROOT, p);

async function dirInfo(dir) {
  // Returns { exists, entries } — a shallow count for the dry-run summary.
  try {
    const entries = await fs.readdir(dir);
    return { exists: true, entries: entries.length };
  } catch {
    return { exists: false, entries: 0 };
  }
}

async function removeDir(dir, dryRun) {
  const info = await dirInfo(dir);
  if (!info.exists) {
    process.stdout.write(`  - ${rel(dir)} (absent)\n`);
    return;
  }
  process.stdout.write(`  ${dryRun ? 'would remove' : 'removing'} ${rel(dir)} (${info.entries} entr${info.entries === 1 ? 'y' : 'ies'})\n`);
  if (!dryRun) await fs.rm(dir, { recursive: true, force: true });
}

async function cleanUsers(dryRun) {
  process.stdout.write('\nLeaked throwaway users (example.invalid):\n');
  // No admin provisioner injected → no throwaway users were ever minted, so
  // listHarnessUsers returns [] and there is nothing to prune (BYO runs touch
  // only the user's own account).
  if (!(await checkBackend())) {
    process.stdout.write('  ! backend not reachable — skipping user prune.\n');
    return;
  }
  let users;
  try {
    users = await listHarnessUsers();
  } catch (e) {
    process.stdout.write(`  ! could not list users: ${e.message}\n`);
    return;
  }
  if (users.length === 0) {
    process.stdout.write('  none.\n');
    return;
  }
  for (const u of users) {
    process.stdout.write(`  ${dryRun ? 'would delete' : 'deleting'} ${u.email}\n`);
    if (!dryRun) await deleteUser(u.email);
  }
}

async function cleanScratch(dryRun, purge) {
  process.stdout.write('\nLocal scratch:\n');
  await removeDir(RUNS_DIR, dryRun);
  await removeDir(JUDGEMENTS_DIR, dryRun);
  await removeDir(REPORTS_DIR, dryRun);
  // Preserve human review verdicts (review/done) by default — that's real human
  // labor. Only the regenerable pending queue goes unless --purge.
  await removeDir(path.join(REVIEW_DIR, 'pending'), dryRun);
  if (purge) {
    process.stdout.write('  --purge: also removing human verdicts + validation stamp\n');
    await removeDir(path.join(REVIEW_DIR, 'done'), dryRun);
    await removeDir(VALIDATION_DIR, dryRun);
  } else {
    process.stdout.write(`  (preserved: ${rel(path.join(REVIEW_DIR, 'done'))} and ${rel(VALIDATION_DIR)} — use --purge to remove)\n`);
  }
}

export async function runClean({ dryRun = false, purge = false, users = false, scratch = false } = {}) {
  // No scope flag → users + scratch. The committed showcase/ directory is never
  // touched here — it's version-controlled, not throwaway scratch.
  const anyScope = users || scratch;
  const doUsers = users || !anyScope;
  const doScratch = scratch || !anyScope;

  process.stdout.write(`harness clean${dryRun ? ' (dry run — nothing will be deleted)' : ''}${purge ? ' [PURGE]' : ''}\n`);
  if (doUsers) await cleanUsers(dryRun);
  if (doScratch) await cleanScratch(dryRun, purge);
  process.stdout.write(`\n${dryRun ? 'dry run complete.' : 'clean complete.'}\n`);
}
