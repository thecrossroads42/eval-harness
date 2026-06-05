// =============================================================================
// Substance via debate-adds-to-primary (the "costume" test).
//
// The `distinctiveness` metric measures STYLE: can a judge tell the voices apart by
// register? But a frontier model can make two voices perfectly distinguishable
// in diction while their reasoning quietly converges to the same conclusion —
// distinct costumes worn by one mind. A high distinctiveness score can hide
// exactly the failure the product rests on.
//
// This measures CONTENT, which is the test corpus/threats.md actually names:
// "check whether the opposing voice ever lands a point the primary voice could
// not easily have absorbed on its own. If it never does, the voices are a
// costume." For each turn we take the primary voice's response as the baseline
// and ask a SEPARATE model, for each debater challenging it: did this debater
// raise a consideration the primary's own worldview would not have produced, or
// only restate / elaborate / agree with what the primary already held?
//
//   NEW_CONSIDERATION  a value, objection, or reframe structurally foreign to
//                      the primary's worldview and absent from its text — genuine
//                      adversarial substance (the only verdict that fully counts)
//   SHARPENS           a real counter the primary could plausibly have reached
//                      itself (half credit)
//   ELABORATES         more texture, same direction, no new consideration
//   CONCURS            agrees / supports / restates — adds nothing adversarial
//
// The headline add-rate is NEW_CONSIDERATION / total debater contributions. A
// low add-rate beside a high distinctiveness score is the costume signal: the
// voices read differently and argue the same.
//
// Offline by design, like distinctiveness: it never imports backend source and
// needs no running backend — it works from stored transcripts. Unlike
// distinctiveness it is NOT blind; the judge sees the voice names, because the
// question is whether *the Outsider* added what *the Elder* could not, not
// whether the two can be told apart.
//
// Two-model hygiene: the judge defaults to a DIFFERENT family from the Opus
// orchestrator (config.models.substance). An Opus judge could charitably read a
// debate point as "new" precisely because it is the kind of point it would have
// generated itself — the opposite of the skepticism this measurement needs.
//
// Billable: one judge call per transcript. Run deliberately via
// `harness convergence --metric substance`; nothing here calls a model until then.
// =============================================================================

import { models } from '../config.js';
import { judgeJson } from './corpus.js';

// How much each verdict counts toward the substance index. The add-rate (the
// headline) uses only NEW_CONSIDERATION; the index gives SHARPENS half credit.
const WEIGHT = { NEW_CONSIDERATION: 1, SHARPENS: 0.5, ELABORATES: 0, CONCURS: 0 };

// Per SUT turn, pull the primary voice (the baseline) and the debaters
// challenging it. The Keeper is never a unit here — we measure whether the
// OPPOSING VOICES add to the primary, not whether the synthesis is fair.
export function extractDebateUnits(transcript) {
  const units = [];
  let lastUser = ''; // the most recent user turn — the message this turn answers
  for (const t of transcript.turns || []) {
    if (t.role === 'user') { lastUser = String(t.text || '').trim(); continue; }
    const p = t.payload;
    if (!p || !p.primaryMemberId || p.primaryMemberId === 'keeper' || !p.primaryResponseText) continue;
    const debaters = (p.debateMembers || [])
      .filter((d) => d.voiceId && d.voiceId !== 'keeper' && d.responseText)
      .map((d) => ({ voiceId: d.voiceId, name: d.memberName || d.voiceId, text: String(d.responseText).trim() }));
    if (!debaters.length) continue;
    units.push({
      userMessage: lastUser,
      primary: {
        voiceId: p.primaryMemberId,
        name: p.primaryMemberName || p.primaryMemberId,
        text: String(p.primaryResponseText).trim(),
      },
      debaters,
    });
  }
  return units;
}

const SYSTEM = `You are an adversarial auditor measuring whether a multi-voice advisory debate produces genuine disagreement, or whether the other voices merely decorate a position the first voice already held.

For each turn you are given: the user's message, the PRIMARY voice's full response (the baseline), and one or more DEBATER responses from other voices reacting to it. For every debater contribution, classify how much it adds to the primary's response, judging by reasoning and substance — not by tone, vividness, or how differently it is phrased.

Verdicts (you MUST be skeptical; the burden is on the debater to earn the higher verdicts):
- "NEW_CONSIDERATION": introduces a value, objection, or reframe that is genuinely FOREIGN to the primary's worldview AND absent from the primary's own text — a point the primary could not easily have produced on its own. Reserve this for real adversarial substance.
- "SHARPENS": a real counter or qualification, but one the primary could plausibly have reached itself (it lives within the same worldview, just pushed further or stated against the primary).
- "ELABORATES": adds detail, examples, or texture in the SAME direction as the primary; no consideration the primary lacked.
- "CONCURS": agrees with, supports, softens toward, or merely restates the primary; adds nothing adversarial.

The decisive test for NEW_CONSIDERATION: if the primary voice had been asked to steelman the opposing view itself, would it have produced this point as a matter of course? If yes, it is NOT new. When torn between two verdicts, choose the LOWER one.

Output STRICT JSON only:
{"items":[{"turn":<number>,"debater":<number>,"verdict":"NEW_CONSIDERATION|SHARPENS|ELABORATES|CONCURS","quote":"<a short verbatim quote from the debater>","why":"<one clause: why the primary could or could not have produced this>"}],"note":"<one sentence on whether the debate genuinely opposed the primary or only dressed it up>"}
Return one item for every (turn, debater) pair you are given. No prose outside the JSON.`;

function buildPrompt(units) {
  const blocks = units.map((u, i) => {
    const head = `[Turn ${i + 1}]`;
    const ctx = u.userMessage ? `USER: ${u.userMessage}\n\n` : '';
    const primary = `PRIMARY — ${u.primary.name}:\n${u.primary.text}`;
    const debaters = u.debaters
      .map((d, j) => `DEBATER ${j + 1} — ${d.name}:\n${d.text}`)
      .join('\n\n');
    return `${head}\n${ctx}${primary}\n\n${debaters}`;
  });
  return `${blocks.join('\n\n———\n\n')}\n\nReturn the JSON now.`;
}

export async function judgeSubstance(transcript, { model } = {}) {
  const cfg = model || models.substance;
  const units = extractDebateUnits(transcript);
  const expected = units.reduce((n, u) => n + u.debaters.length, 0);
  if (!units.length || expected < 1) {
    return { applicable: false, reason: 'no turn had a primary voice with at least one debater' };
  }

  // Generous headroom: a reasoning judge spends completion budget on hidden
  // reasoning before the JSON, and there is one item per debater contribution.
  const { parsed, judgeError } = await judgeJson({ cfg, system: SYSTEM, prompt: buildPrompt(units), maxTokens: 12000 });
  if (judgeError) return { applicable: true, judgeError, expected };

  const byVerdict = { NEW_CONSIDERATION: 0, SHARPENS: 0, ELABORATES: 0, CONCURS: 0 };
  const pairs = {}; // "primaryId+debaterId" → { new, sharpen, elaborate, concur, total }
  let classified = 0, weighted = 0;
  for (const it of parsed.items || []) {
    const u = units[Number(it.turn) - 1];
    if (!u) continue;
    const d = u.debaters[Number(it.debater) - 1];
    if (!d) continue;
    const v = String(it.verdict || '').toUpperCase();
    if (!(v in byVerdict)) continue;
    byVerdict[v]++;
    classified++;
    weighted += WEIGHT[v];
    const key = `${u.primary.voiceId}+${d.voiceId}`;
    const slot = (pairs[key] ||= { new: 0, sharpen: 0, elaborate: 0, concur: 0, total: 0 });
    slot.total++;
    if (v === 'NEW_CONSIDERATION') slot.new++;
    else if (v === 'SHARPENS') slot.sharpen++;
    else if (v === 'ELABORATES') slot.elaborate++;
    else slot.concur++;
  }

  return {
    applicable: true,
    expected,
    classified,
    addRate: classified ? byVerdict.NEW_CONSIDERATION / classified : 0,
    substanceIndex: classified ? weighted / classified : 0,
    byVerdict,
    pairs,
    note: parsed.note || '',
  };
}

// ---- Report: aggregate per-transcript results and print -------------------

export function reportSubstance(results) {
  const cfg = models.substance;
  const scored = results.filter((r) => r && r.applicable && typeof r.addRate === 'number');
  const errored = results.filter((r) => r && (r.judgeError || r.error)).length;
  const skipped = results.length - scored.length - errored;

  const verdictTotals = { NEW_CONSIDERATION: 0, SHARPENS: 0, ELABORATES: 0, CONCURS: 0 };
  const pairTotals = {};
  let addSum = 0, idxSum = 0, classifiedSum = 0, expectedSum = 0;
  for (const r of scored) {
    addSum += r.addRate; idxSum += r.substanceIndex;
    classifiedSum += r.classified; expectedSum += r.expected;
    for (const [k, v] of Object.entries(r.byVerdict || {})) verdictTotals[k] += v;
    for (const [k, slot] of Object.entries(r.pairs || {})) {
      const t = (pairTotals[k] ||= { new: 0, sharpen: 0, elaborate: 0, concur: 0, total: 0 });
      for (const f of Object.keys(t)) t[f] += slot[f] || 0;
    }
  }
  const meanAdd = scored.length ? addSum / scored.length : 0;
  const meanIdx = scored.length ? idxSum / scored.length : 0;

  // Lowest-substance pairs: where a debater rarely adds to that primary. Only
  // pairs with enough contributions to read (≥3) — the place to look first for
  // two voices that argue the same while sounding different.
  const lowest = Object.entries(pairTotals)
    .filter(([, t]) => t.total >= 3)
    .map(([k, t]) => [k, t.new / t.total, t.total])
    .sort((a, b) => a[1] - b[1])
    .slice(0, 12);

  process.stdout.write(`\n## Substance (debate-adds-to-primary)\n`);
  process.stdout.write(`judge:               ${cfg.provider}/${cfg.model} (cross-family from the Opus orchestrator)\n`);
  process.stdout.write(`transcripts scored:  ${scored.length}  (skipped ${skipped} no-debate, ${errored} judge-error)\n`);
  process.stdout.write(`contributions:       ${classifiedSum} classified (of ${expectedSum} expected)\n`);
  process.stdout.write(`mean add-rate:       ${(meanAdd * 100).toFixed(1)}%   (share of debater turns that raised a consideration the primary could not have produced)\n`);
  process.stdout.write(`mean substance idx:  ${(meanIdx * 100).toFixed(1)}%   (NEW=1, SHARPENS=½, ELABORATES/CONCURS=0)\n`);
  const c = classifiedSum || 1;
  process.stdout.write(`verdict mix:         NEW ${verdictTotals.NEW_CONSIDERATION} (${(verdictTotals.NEW_CONSIDERATION / c * 100).toFixed(0)}%) · SHARPENS ${verdictTotals.SHARPENS} · ELABORATES ${verdictTotals.ELABORATES} · CONCURS ${verdictTotals.CONCURS}\n\n`);
  process.stdout.write(`lowest-substance pairs (primary+debater: add-rate, n):\n`);
  if (!lowest.length) process.stdout.write(`  (too few contributions per pair to rank — need ≥3)\n`);
  for (const [k, rate, n] of lowest) process.stdout.write(`  ${k}: ${(rate * 100).toFixed(0)}%  (n=${n})\n`);
  process.stdout.write(
    `\nRead this NEXT TO the distinctiveness metric, not instead of it. Distinctiveness\n` +
    `measures style (can the voices be told apart); substance measures content (do they\n` +
    `actually disagree). HIGH distinctiveness + LOW add-rate = the costume signal: the\n` +
    `voices read differently and argue the same. Per corpus/threats.md this is one signal,\n` +
    `not the verdict — the only ground truth is a human reading the transcripts.\n`
  );

  // Structured summary for persistence + the report panel (harness report).
  return {
    metric: 'substance',
    judge: `${cfg.provider}/${cfg.model}`,
    transcriptsScored: scored.length, skipped, errored,
    classified: classifiedSum, expected: expectedSum,
    meanAddRate: meanAdd, meanSubstanceIndex: meanIdx,
    verdictMix: verdictTotals, lowestPairs: lowest,
  };
}
