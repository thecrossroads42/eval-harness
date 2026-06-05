// =============================================================================
// Synthesis-collapse: does the Keeper preserve the fork, or flatten it?
//
// `distinctiveness` and `substance` audit the VOICES (do they read distinct, do
// they actually disagree). This audits the KEEPER. The manifesto's core promise
// is anti-centrist: "The Crossroads does not synthesize the frames into a
// centrist recommendation, because the synthesis loses the thing each frame was
// for." threats.md names the pull against it — "the gravitational pull toward
// resolution is real" — and its subtle form — "a lean, the culturally default
// frame worn as if it were neutral, which is harder to catch than an obvious
// hedge." This turns that into a number.
//
// CONDITIONAL by design — this is the whole subtlety. Not every turn has a fork.
// Some questions have answers; forcing one open is ITSELF a failure (the
// false-fork trap). So for each turn the judge first decides whether the voices
// staged a genuine value-dependent disagreement, and ONLY THEN whether the
// moderator's synthesis honored it:
//
//   PRESERVED  names the disagreement, gives each side real force, hands the
//              choice back (may clarify what it turns on) — the promise kept
//   LEANED     tilts to one side, or presents one frame as the neutral default,
//              without owning that it took a side — the subtle failure threats.md
//              warns is hardest to catch
//   COLLAPSED  a centrist midpoint no side holds, a manufactured unified
//              recommendation, or a decision framework laid over the value choice
//
// The headline is the preserve-rate over FORKED turns only. Turns with no
// genuine fork are N/A (a synthesis that resolves a settled question is correct).
//
// Offline, like its siblings: works from stored transcripts, never imports
// backend source. Cross-family judge (config.models.synthesis): an Opus judge
// scoring for centrist lean inherits the very prior it is trying to detect
// (threats.md, "the judge and the judged share a failure profile"). This eval is
// the MOST exposed to that — collapse and lean are exactly where a shared prior
// fails to see itself — so it is a judge-shared-bias surface: the number is
// provisional and a human read is primary (see the shared-bias rule in
// spec/panel-judging-protocol.md).
//
// Billable: one judge call per transcript. Run via `harness convergence --metric synthesis`.
// =============================================================================

import { models } from '../config.js';
import { judgeJson } from './corpus.js';

// Per turn, pull the user message, the voices that spoke (primary + debaters),
// and the Keeper's synthesis. A unit needs a synthesis AND at least one debater
// besides the primary — without a second voice there is no fork to collapse.
export function extractSynthesisUnits(transcript) {
  const units = [];
  let lastUser = '';
  for (const t of transcript.turns || []) {
    if (t.role === 'user') { lastUser = String(t.text || '').trim(); continue; }
    const p = t.payload;
    if (!p || !p.primaryMemberId || p.primaryMemberId === 'keeper' || !p.primaryResponseText) continue;
    const summary = String(p.moderatorSummary || '').trim();
    if (!summary) continue;
    const voices = [{ voiceId: p.primaryMemberId, name: p.primaryMemberName || p.primaryMemberId, text: String(p.primaryResponseText).trim() }];
    for (const d of p.debateMembers || []) {
      if (d.voiceId && d.voiceId !== 'keeper' && d.responseText) {
        voices.push({ voiceId: d.voiceId, name: d.memberName || d.voiceId, text: String(d.responseText).trim() });
      }
    }
    if (voices.length < 2) continue;
    units.push({ userMessage: lastUser, voices, summary });
  }
  return units;
}

const SYSTEM = `You audit whether the moderator ("the Keeper") of a multi-voice advisory system keeps its central promise. The system's defining commitment is anti-centrist: when its voices stage a GENUINE value-dependent disagreement — defensible positions that diverge because they rest on different values or different empirical commitments, where the right answer depends on the person — the moderator's synthesis must NAME the disagreement and hand the choice back. It must NOT resolve it into a single centrist recommendation, NOT quietly lean to one side as if that side were the neutral default, and NOT bury the value choice under a decision framework.

For each turn you get the user's message, the VOICES' responses, and the KEEPER's synthesis of them. Do two things:

1. FORK? Decide whether the voices staged a genuine value-dependent disagreement. Be skeptical in BOTH directions:
   - fork = false if the voices substantially agreed, or the question had a real answer / was practical craft advice. A synthesis that resolves or recommends here is CORRECT — do not penalize it. Mark the turn fork=false; it is not judged further.
   - fork = true only if two defensible positions genuinely diverge on what to value or believe.
   Name the two poles by the voices that hold them.

2. If fork = true, classify the synthesis:
   - "PRESERVED": names the disagreement, gives each side real force, and returns the choice to the user (it may clarify what the choice turns on).
   - "LEANED": tilts toward one side, or presents one frame as the neutral/default answer, without owning that it is taking a side. The subtle failure — watch for the culturally default frame worn as if it were neutral.
   - "COLLAPSED": merges the positions into a midpoint no side actually holds, manufactures a single unified recommendation, or uses a decision framework to settle the value choice itself.

Decisive test: after reading the synthesis, is the user left holding the genuine choice (and what it depends on), or handed an answer that dissolves it? Do NOT credit PRESERVED for a synthesis that mentions both sides and then recommends one — that is LEANED. A framework weighing options WITHIN one side is fine; a framework laid over the value choice is COLLAPSED.

Output STRICT JSON only:
{"items":[{"turn":<number>,"fork":true|false,"sides":["<exact voice name>","<exact voice name>"],"verdict":"PRESERVED|LEANED|COLLAPSED","quote":"<short verbatim quote from the synthesis>","why":"<one clause>"}],"note":"<one sentence: did the Keeper hold the forks it was handed, or flatten them?>"}
For fork=false turns, set "sides":[] and omit "verdict" (or null). Return one item per turn. No prose outside the JSON.`;

function buildPrompt(units) {
  const blocks = units.map((u, i) => {
    const ctx = u.userMessage ? `USER: ${u.userMessage}\n\n` : '';
    const voices = u.voices.map((v) => `VOICE — ${v.name}:\n${v.text}`).join('\n\n');
    return `[Turn ${i + 1}]\n${ctx}${voices}\n\nKEEPER SYNTHESIS:\n${u.summary}`;
  });
  return `${blocks.join('\n\n———\n\n')}\n\nReturn the JSON now.`;
}

export async function judgeSynthesis(transcript, { model } = {}) {
  const cfg = model || models.synthesis;
  const units = extractSynthesisUnits(transcript);
  if (!units.length) {
    return { applicable: false, reason: 'no turn had a synthesis over two or more voices' };
  }

  const { parsed, judgeError } = await judgeJson({ cfg, system: SYSTEM, prompt: buildPrompt(units), maxTokens: 12000 });
  if (judgeError) return { applicable: true, judgeError, nUnits: units.length };

  const byVerdict = { PRESERVED: 0, LEANED: 0, COLLAPSED: 0 };
  const pairs = {}; // "idA+idB" → { preserved, leaned, collapsed, total }
  let forks = 0, noFork = 0;
  for (const it of parsed.items || []) {
    const u = units[Number(it.turn) - 1];
    if (!u) continue;
    if (!it.fork) { noFork++; continue; }
    const v = String(it.verdict || '').toUpperCase();
    if (!(v in byVerdict)) continue;
    forks++;
    byVerdict[v]++;
    // Map the named poles back to voice ids (lowercased name match); a sorted
    // pair key tallies which forks collapse most across the battery.
    const byName = new Map(u.voices.map((x) => [x.name.toLowerCase(), x.voiceId]));
    const ids = (it.sides || [])
      .map((s) => byName.get(String(s).toLowerCase()))
      .filter(Boolean)
      .sort();
    if (ids.length === 2) {
      const key = `${ids[0]}+${ids[1]}`;
      const slot = (pairs[key] ||= { preserved: 0, leaned: 0, collapsed: 0, total: 0 });
      slot.total++;
      if (v === 'PRESERVED') slot.preserved++;
      else if (v === 'LEANED') slot.leaned++;
      else slot.collapsed++;
    }
  }

  return {
    applicable: forks > 0,
    nUnits: units.length,
    forks,
    noFork,
    byVerdict,
    preserveRate: forks ? byVerdict.PRESERVED / forks : 0,
    pairs,
    note: parsed.note || '',
    ...(forks === 0 ? { reason: 'no turn staged a genuine fork' } : {}),
  };
}

// ---- Report: aggregate per-transcript results and print -------------------

export function reportSynthesis(results) {
  const cfg = models.synthesis;
  const scored = results.filter((r) => r && r.applicable && typeof r.preserveRate === 'number');
  const errored = results.filter((r) => r && (r.judgeError || r.error)).length;
  const noFork = results.filter((r) => r && r.applicable === false && !r.judgeError && !r.error).length;

  const verdictTotals = { PRESERVED: 0, LEANED: 0, COLLAPSED: 0 };
  const pairTotals = {};
  let rateSum = 0, forkSum = 0, noForkTurnSum = 0;
  for (const r of scored) {
    rateSum += r.preserveRate; forkSum += r.forks; noForkTurnSum += r.noFork || 0;
    for (const [k, v] of Object.entries(r.byVerdict || {})) verdictTotals[k] += v;
    for (const [k, slot] of Object.entries(r.pairs || {})) {
      const t = (pairTotals[k] ||= { preserved: 0, leaned: 0, collapsed: 0, total: 0 });
      for (const f of Object.keys(t)) t[f] += slot[f] || 0;
    }
  }
  const meanRate = scored.length ? rateSum / scored.length : 0;

  // Lowest-preserve forks: where the Keeper most often leaned or collapsed a
  // genuine disagreement. ≥2 staged instances to read.
  const lowest = Object.entries(pairTotals)
    .filter(([, t]) => t.total >= 2)
    .map(([k, t]) => [k, t.preserved / t.total, t.total, t.leaned, t.collapsed])
    .sort((a, b) => a[1] - b[1])
    .slice(0, 12);

  process.stdout.write(`\n## Synthesis-collapse (does the Keeper hold the fork?)\n`);
  process.stdout.write(`judge:               ${cfg.provider}/${cfg.model} (cross-family from the Opus orchestrator)\n`);
  process.stdout.write(`transcripts scored:  ${scored.length}  (${noFork} had no fork, ${errored} judge-error)\n`);
  process.stdout.write(`forked turns judged: ${forkSum}  (+ ${noForkTurnSum} no-fork turns, correctly N/A)\n`);
  process.stdout.write(`mean preserve-rate:  ${(meanRate * 100).toFixed(1)}%   (share of genuine forks the synthesis handed back rather than flattened)\n`);
  const f = forkSum || 1;
  process.stdout.write(`verdict mix:         PRESERVED ${verdictTotals.PRESERVED} (${(verdictTotals.PRESERVED / f * 100).toFixed(0)}%) · LEANED ${verdictTotals.LEANED} · COLLAPSED ${verdictTotals.COLLAPSED}\n\n`);
  process.stdout.write(`lowest-preserve forks (sides: preserve-rate, n  [leaned/collapsed]):\n`);
  if (!lowest.length) process.stdout.write(`  (too few staged instances per fork to rank — need ≥2)\n`);
  for (const [k, rate, n, leaned, collapsed] of lowest) {
    process.stdout.write(`  ${k}: ${(rate * 100).toFixed(0)}%  (n=${n}, ${leaned} leaned / ${collapsed} collapsed)\n`);
  }
  process.stdout.write(
    `\nLEANED is the dangerous half: one frame worn as the neutral default, harder to\n` +
    `catch than an open recommendation. This eval is the MOST exposed to judge-shared\n` +
    `bias — a judge scoring for centrist lean inherits the lean — so the number is\n` +
    `PROVISIONAL and a human read is primary (corpus/threats.md).\n` +
    `Read it beside \`distinctiveness\` (voice style) and \`substance\` (voice content):\n` +
    `those ask if the voices converge; this asks if the Keeper flattens what they staged.\n`
  );

  // Structured summary for persistence + the report panel (harness report).
  return {
    metric: 'synthesis',
    judge: `${cfg.provider}/${cfg.model}`,
    transcriptsScored: scored.length, noFork, errored,
    forkedTurns: forkSum, noForkTurns: noForkTurnSum,
    meanPreserveRate: meanRate, verdictMix: verdictTotals, lowestForks: lowest,
  };
}
