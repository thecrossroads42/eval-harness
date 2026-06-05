// =============================================================================
// Shared engine for the corpus-level convergence metrics (distinctiveness,
// substance, synthesis).
//
// These differ from `harness judge` in kind, not just in name. `judge` scores
// each SESSION against authored rubric checks (pass/fail, tiered, written to
// judgements/ and consumed by the reporter + review queue). The metrics here
// measure an emergent property of the whole CORPUS — the meaning is in the mean
// rate and the pair matrix across many transcripts, not in any one session — and
// they use a single CROSS-FAMILY judge by design (an Opus judge would recognize
// its own output; see each metric's header). So they live as siblings, not as a
// tier inside `judge`.
//
// What they genuinely share is only the plumbing: collecting the transcripts,
// the one judge call + JSON parse, and the fan-out. Each metric keeps its own
// extraction, prompt, scoring, aggregation, and printing, because those legitimately
// differ. This module is that plumbing — nothing metric-specific belongs here.
// =============================================================================

import { promises as fs } from 'node:fs';
import { listTranscripts, readTranscript } from '../store.js';
import { complete, parseJsonLoose } from '../lib/providers.js';
import { mapLimit } from '../lib/util.js';

// Every stored transcript for a version (reusing the same store.js helpers the
// `judge` command uses), or a single transcript when --file is given.
export async function collectTranscripts({ version, file }) {
  if (file) return [JSON.parse(await fs.readFile(file, 'utf8'))];
  const paths = await listTranscripts(version);
  return Promise.all(paths.map(readTranscript));
}

// One judge call → { parsed } on success, { judgeError } on unparseable output.
// Each metric layers its own per-transcript result shape on top of this.
export async function judgeJson({ cfg, system, prompt, maxTokens = 12000, temperature = 0 }) {
  const raw = await complete({
    provider: cfg.provider, model: cfg.model, system,
    messages: [{ role: 'user', content: prompt }],
    maxTokens, temperature,
  });
  try { return { parsed: parseJsonLoose(raw) }; }
  catch (e) { return { judgeError: e.message }; }
}

// Collect transcripts and fan the per-transcript judge over them. Returns the
// results array, or null when there are no transcripts (the caller reports it).
export async function runMetric({ version, file, judgeFn, concurrency = 4 }) {
  const transcripts = await collectTranscripts({ version, file });
  if (!transcripts.length) return null;
  return mapLimit(transcripts.map((t) => () => judgeFn(t)), concurrency);
}
