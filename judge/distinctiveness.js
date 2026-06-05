// =============================================================================
// Distinctiveness via blind voice-attribution.
//
// The "voices may be one voice wearing masks" verdict from corpus/threats.md,
// turned into a number. Strip the labels off a visit's voice turns, shuffle
// them out of speaking order, and ask a SEPARATE model to attribute each turn to
// the voice that said it — choosing only among the voices that actually spoke in
// that visit. If it cannot tell the Elder from the Outsider, neither can a user,
// and the voices have converged. Low accuracy ⇒ convergence.
//
// Offline by design. Like the rest of the harness it never imports backend
// source and needs no running backend: it works from stored transcripts, and
// the candidate set is the {voiceId → name} that spoke in the transcript.
//
// Two-model hygiene: the attributor defaults to a DIFFERENT family from the Opus
// orchestrator (config.models.distinctiveness). An Opus attributor could
// recognize its own stylistic fingerprints and overstate distinctiveness.
//
// Billable: one judge call per transcript. Run deliberately via
// `harness convergence --metric distinctiveness`; nothing here calls a model until then.
// =============================================================================

import { models } from '../config.js';
import { judgeJson } from './corpus.js';

// Pull each VOICE contribution (never the Keeper) out of a transcript: the
// primary responder plus every debater, across all SUT turns.
export function extractVoiceTurns(transcript) {
  const turns = [];
  for (const t of transcript.turns || []) {
    const p = t.payload;
    if (!p) continue;
    if (p.primaryMemberId && p.primaryMemberId !== 'keeper' && p.primaryResponseText) {
      turns.push({ voiceId: p.primaryMemberId, name: p.primaryMemberName || p.primaryMemberId, text: String(p.primaryResponseText).trim() });
    }
    for (const d of p.debateMembers || []) {
      if (d.voiceId && d.voiceId !== 'keeper' && d.responseText) {
        turns.push({ voiceId: d.voiceId, name: d.memberName || d.voiceId, text: String(d.responseText).trim() });
      }
    }
  }
  return turns;
}

// Deterministic scramble: presentation order must carry no signal (not speaking
// order, where the primary is always first), and the same transcript must yield
// the same ordering across runs.
function stableHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const SYSTEM = `You are an expert reader auditing whether the distinct "voices" of a multi-voice advisory system are genuinely distinguishable, or have converged into one underlying voice wearing different names.

You are given (1) the NAMES of the voices that spoke in a single session and (2) their turns from that session, anonymized and shuffled. Each turn was said by exactly one of the named voices; a voice may have several turns.

Attribute each turn to the voice that said it, judging ONLY by the reasoning, stance, values, and register of the text — there are no labels to lean on. If two turns are genuinely indistinguishable you must still guess; your accuracy is the measurement.

Output STRICT JSON only:
{"attributions":[{"turn":<number>,"voice":"<exact voice name from the list>"}],"note":"<one sentence on how distinguishable they were>"}
No prose outside the JSON.`;

function buildPrompt(candidates, scrambled) {
  const roster = candidates.map((c) => `- ${c.name}`).join('\n');
  const body = scrambled.map((t, i) => `[Turn ${i + 1}]\n${t.text}`).join('\n\n');
  return `VOICES THAT SPOKE IN THIS SESSION (choose only from these):\n${roster}\n\nANONYMIZED, SHUFFLED TURNS:\n\n${body}\n\nReturn the JSON now.`;
}

export async function judgeDistinctiveness(transcript, { model } = {}) {
  const cfg = model || models.distinctiveness;
  const all = extractVoiceTurns(transcript);
  const candidates = [...new Map(all.map((t) => [t.voiceId, t.name])).entries()]
    .map(([voiceId, name]) => ({ voiceId, name }));
  if (candidates.length < 2 || all.length < 2) {
    return { applicable: false, reason: 'fewer than two distinct voices spoke', candidates: candidates.length };
  }
  const scrambled = all
    .map((t, i) => ({ t, k: stableHash(`${i}:${t.text}`) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.t);

  // Generous headroom: a reasoning attributor spends completion budget on hidden
  // reasoning before the (small) JSON, so too low a cap truncates it.
  const { parsed, judgeError } = await judgeJson({ cfg, system: SYSTEM, prompt: buildPrompt(candidates, scrambled), maxTokens: 8000 });
  if (judgeError) return { applicable: true, judgeError, n: scrambled.length };

  const byName = new Map(candidates.map((c) => [c.name.toLowerCase(), c.voiceId]));
  const guesses = new Map((parsed.attributions || []).map((a) => [a.turn, a.voice]));
  let correct = 0;
  const confusions = {}; // "trueId→guessId": count
  for (let i = 0; i < scrambled.length; i++) {
    const t = scrambled[i];
    const guessName = guesses.get(i + 1);
    const guessId = guessName ? (byName.get(String(guessName).toLowerCase()) || `?${guessName}`) : '∅';
    if (guessId === t.voiceId) correct++;
    else { const k = `${t.voiceId}→${guessId}`; confusions[k] = (confusions[k] || 0) + 1; }
  }
  return {
    applicable: true,
    n: scrambled.length,
    candidates: candidates.map((c) => c.voiceId),
    chance: 1 / candidates.length,
    accuracy: correct / scrambled.length,
    correct,
    confusions,
    note: parsed.note || '',
  };
}

// ---- Report: aggregate per-transcript results and print -------------------

export function reportDistinctiveness(results) {
  const cfg = models.distinctiveness;
  const scored = results.filter((r) => r && r.applicable && typeof r.accuracy === 'number');
  const errored = results.filter((r) => r && (r.judgeError || r.error)).length;
  const skipped = results.length - scored.length - errored;
  const confTotals = {};
  let accSum = 0, chanceSum = 0, nSum = 0;
  for (const r of scored) {
    accSum += r.accuracy; chanceSum += r.chance; nSum += r.n;
    for (const [k, v] of Object.entries(r.confusions || {})) confTotals[k] = (confTotals[k] || 0) + v;
  }
  const meanAcc = scored.length ? accSum / scored.length : 0;
  const meanChance = scored.length ? chanceSum / scored.length : 0;
  const worst = Object.entries(confTotals).sort((a, b) => b[1] - a[1]).slice(0, 12);

  process.stdout.write(`\n## Distinctiveness (blind voice-attribution)\n`);
  process.stdout.write(`attributor:         ${cfg.provider}/${cfg.model} (cross-family from the Opus orchestrator)\n`);
  process.stdout.write(`transcripts scored: ${scored.length}  (skipped ${skipped} <2-voice, ${errored} judge-error)\n`);
  process.stdout.write(`turns attributed:   ${nSum}\n`);
  process.stdout.write(`mean accuracy:      ${(meanAcc * 100).toFixed(1)}%   vs chance ${(meanChance * 100).toFixed(1)}%\n`);
  const lift = meanChance < 1 ? (meanAcc - meanChance) / (1 - meanChance) : 0;
  process.stdout.write(`chance-adjusted:    ${(lift * 100).toFixed(1)}%   (0% = indistinguishable / converged, 100% = perfectly distinct)\n\n`);
  process.stdout.write(`most-confused voice pairs (true→guessed):\n`);
  if (!worst.length) process.stdout.write(`  (none — every turn attributed correctly)\n`);
  for (const [k, v] of worst) process.stdout.write(`  ${k}: ${v}\n`);
  process.stdout.write(`\nThis is one signal, not the verdict: per corpus/threats.md the only ground truth\nis a human reading the transcripts. A confused pair is where two voices read alike —\nthe place to look first for convergence.\n`);

  // Structured summary for persistence + the report panel (harness report).
  return {
    metric: 'distinctiveness',
    judge: `${cfg.provider}/${cfg.model}`,
    transcriptsScored: scored.length, skipped, errored, turns: nSum,
    meanAccuracy: meanAcc, meanChance, chanceAdjusted: lift,
    worstPairs: worst,
  };
}
