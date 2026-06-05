// =============================================================================
// Lead proposal (lowest-trust, last). Given the failure clusters + tilt
// findings in a report, ask a model for HYPOTHESES about likely causes in the
// SUT's prompts and a single change to try. These are leads for a human, never
// edits to apply: a proposed change has no view of the cases it might break, so
// it must be re-validated against the WHOLE matrix before acceptance.
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REPORTS_DIR, models, requireKeys } from './config.js';
import { listVersions } from './store.js';
import { complete, parseJsonLoose } from './lib/providers.js';

const LEADS_SYSTEM = `You are helping debug a multi-voice advisory system ("The Crossroads"). You are given checks that FAILED, with quoted evidence. For each cluster, propose ONE hypothesis about the likely cause in the system's PROMPTS, and ONE concrete change to try.

The system's prompts live in: corpus/prompts/*.md (orchestration: scoring, debate, the moderator synthesis, CASE 5 fork-staging, PRINCIPLE 8), corpus/voices/*/prompt.md (each voice's persona), corpus/keeper/prompt.md (the Keeper), and corpus/voices/pairs.yaml + groups.yaml (pairs/groups).

These are HYPOTHESES, not fixes. A change that helps one cluster routinely breaks another. Output STRICT JSON only:
[{ "cluster": "<scenarioId#check>", "hypothesis": "<the likely cause>", "suggested_change": "<one change to try>", "files_to_look_at": ["<path>", ...], "confidence": "low"|"medium"|"high", "watch_for_regression_in": "<what this change might break>" }]`;

export async function runLeads({ version } = {}) {
  requireKeys([models.leads.provider]);
  const versionKey = version || (await listVersions())[0];
  if (!versionKey) throw new Error('no versions found.');

  const reportJson = path.join(REPORTS_DIR, `${versionKey}.json`);
  let report;
  try {
    report = JSON.parse(await fs.readFile(reportJson, 'utf8'));
  } catch {
    throw new Error(`no report for version ${versionKey}. Run \`harness report\` first.`);
  }

  const clusters = (report.clusters || []).filter((c) => c.fails > 0);
  const tilts = (report.symmetry || []).filter((s) => /tilted|split/.test(s.status));
  if (clusters.length === 0 && tilts.length === 0) {
    process.stdout.write('No failure clusters or tilt findings to hypothesize about. 🎉\n');
    return;
  }

  const clusterText = clusters
    .map((c) => `CLUSTER ${c.scenarioId}#${c.index} (failed ${c.fails}×)${c.critical ? ' [CRITICAL]' : ''}\n  check: ${c.check}\n  sample evidence: ${JSON.stringify(String(c.sampleEvidence || '').slice(0, 300))}\n  judge note: ${String(c.sampleNote || '').slice(0, 240)}`)
    .join('\n\n');
  const tiltText = tilts
    .map((s) => `TILT ${s.scenarioId} (${s.status})\n  judges: ${(s.judges || []).filter((j) => j.ok).map((j) => `${j.label}:${j.tilt}`).join(', ')}`)
    .join('\n\n');

  const user = `Failing clusters:\n\n${clusterText || '(none)'}\n\nTilt findings:\n\n${tiltText || '(none)'}\n\nReturn the JSON array of leads now.`;
  const raw = await complete({ provider: models.leads.provider, model: models.leads.model, system: LEADS_SYSTEM, messages: [{ role: 'user', content: user }], maxTokens: 2500 });

  let leads;
  try {
    leads = parseJsonLoose(raw);
  } catch (e) {
    throw new Error(`leads model returned unparseable output: ${e.message}`);
  }

  const L = [];
  L.push(`# Leads — version \`${versionKey}\``);
  L.push(`\n> ⚠️ These are HYPOTHESES for a human, NOT edits to apply. Any change must be re-validated`);
  L.push(`> against the WHOLE matrix (change one thing, re-run everything, diff). A fix for one cluster`);
  L.push(`> routinely breaks another.\n`);
  for (const l of Array.isArray(leads) ? leads : []) {
    L.push(`\n## ${l.cluster} — confidence: ${l.confidence}`);
    L.push(`- **Hypothesis:** ${l.hypothesis}`);
    L.push(`- **Change to try:** ${l.suggested_change}`);
    L.push(`- **Files:** ${(l.files_to_look_at || []).join(', ')}`);
    L.push(`- **Watch for regression in:** ${l.watch_for_regression_in}`);
  }
  const out = path.join(REPORTS_DIR, `${versionKey}-leads.md`);
  await fs.writeFile(out, L.join('\n'));
  process.stdout.write(L.join('\n') + `\n\nwrote ${path.relative(process.cwd(), out)}\n`);
}
