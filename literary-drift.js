// =============================================================================
// Cooperative-drift POINTER for literary probes (spec Part A, A3).
//
// The predicted gravity acts on the PROBE too: a withholding persona tends to
// start helpfully articulating its own subtext in later turns (the persona
// "forgetting" to withhold). This flags when a persona's later user turns become
// markedly longer / more self-aware than its early ones, so the editor knows
// WHERE to look.
//
// It is deliberately a TRANSPARENT HEURISTIC, not a model judge: a model scoring
// "is this persona good" inherits a flattened prior on the very human texture
// being checked (A3), and a billable judge call would dress a pointer up as a
// verdict. And it is a POINTER, never a verdict: a flag can mean the persona
// drifted OR that the voices genuinely earned the opening. The editor decides by
// reading. There is no automated probe-quality judgment here, by design.
// =============================================================================

// Late-turn "I'm being cooperative/self-aware now" language. Catching the
// persona narrating its own subtext, conceding, or thanking the room — the
// articulate-resolution drift, not ordinary conversation.
const INSIGHT_MARKERS = [
  /\bi (realize|realise|admit|recognize|recognise)\b/i,
  /\bi (see|get) (it|that|now)\b/i,
  /\b(the truth is|what'?s really going on|if i'?m honest|to be honest|deep down|i guess i)\b/i,
  /\byou'?re right\b/i,
  /\bi'?ve been (avoiding|hiding|lying|fooling|telling myself|kidding myself)\b/i,
  /\bi (need|have) to (admit|face|own)\b/i,
  /\bthank you\b/i,
  /\bthat (makes sense|helps|really helps|hits home)\b/i,
];

function round(n) {
  return Math.round(n * 100) / 100;
}

function scoreTurn(text, idx) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const markers = INSIGHT_MARKERS.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
  return { idx, words, markers, text };
}

// `transcript.turns` user turns, 1-based; the opening (turn 1) is authored
// verbatim, not generated, so it can't drift — we drop it before assessing.
export function analyzeDrift(transcript) {
  const all = (transcript.turns || [])
    .filter((t) => t.role === 'user')
    .map((t, i) => scoreTurn(t.text || '', i + 1));
  const gen = all.slice(1);
  if (gen.length < 4) {
    return { flagged: false, reason: `only ${gen.length} generated user turn(s) — too few to assess drift` };
  }

  const mid = Math.floor(gen.length / 2);
  const early = gen.slice(0, mid);
  const late = gen.slice(mid);
  const mean = (xs, k) => xs.reduce((s, x) => s + x[k], 0) / xs.length;
  const earlyWords = mean(early, 'words');
  const lateWords = mean(late, 'words');
  const earlyMarkers = mean(early, 'markers');
  const lateMarkers = mean(late, 'markers');
  const lengthRatio = earlyWords > 0 ? lateWords / earlyWords : 1;
  const markerJump = lateMarkers - earlyMarkers;

  // Thresholds tuned to OVER-point, not under-point: a false flag costs the
  // editor a re-read; a missed drift hides the exact failure the probe exists to
  // catch (A3). A markedly longer late half, OR a clear rise in self-aware
  // "insight" language late.
  //
  // The length flag needs an absolute floor on the late half: with very terse
  // early turns (1–2 words — exactly a good withholder), the ratio explodes on
  // noise (2w → 5w is ×2.5 but means nothing). A persona that stays terse
  // throughout is the IDEAL probe and must not flag, so require the late turns to
  // be genuinely elaborated, not merely longer than near-silence.
  const flaggedLength = lengthRatio >= 1.6 && lateWords >= 18;
  const flaggedMarkers = markerJump >= 1.0 || (earlyMarkers === 0 && lateMarkers >= 0.5);
  const reasons = [
    flaggedLength && 'late turns markedly longer / more elaborated',
    flaggedMarkers && 'rise in self-aware "insight" language in later turns',
  ].filter(Boolean);

  // The specific turns to look at first: late turns carrying insight markers or
  // running long relative to the early mean.
  const suspectTurns = late
    .filter((x) => x.markers > 0 || (earlyWords > 0 && x.words >= earlyWords * 1.8))
    .map((x) => ({
      turn: x.idx,
      words: x.words,
      markers: x.markers,
      preview: x.text.replace(/\s+/g, ' ').trim().slice(0, 140),
    }));

  return {
    flagged: reasons.length > 0,
    reasons,
    metrics: {
      earlyWords: round(earlyWords),
      lateWords: round(lateWords),
      lengthRatio: round(lengthRatio),
      earlyMarkers: round(earlyMarkers),
      lateMarkers: round(lateMarkers),
    },
    suspectTurns,
  };
}

// A humility-framed, human-readable block for the transcript file. Says, in so
// many words, that this is where to look — not whether the probe is good.
export function formatDriftPointer(drift) {
  const lines = [
    '## Cooperative-drift pointer (a pointer, NOT a verdict)',
    'A transparent heuristic for the predicted gravity: a withholding persona tends to',
    'start articulating its own subtext in later turns. It points at WHERE to look — it',
    'does NOT say the probe is good or bad. A flag can mean the persona forgot to',
    'withhold OR the voices genuinely earned the opening. You decide, by reading the turns.',
    '',
  ];
  if (drift.reason) {
    lines.push(`(not assessed: ${drift.reason})`);
    return lines.join('\n');
  }
  const m = drift.metrics;
  lines.push(drift.flagged ? `FLAG: ${drift.reasons.join('; ')}` : 'No drift flag.');
  lines.push(
    `metrics: early ≈ ${m.earlyWords}w / late ≈ ${m.lateWords}w (×${m.lengthRatio}); ` +
    `insight markers early ≈ ${m.earlyMarkers} → late ≈ ${m.lateMarkers}`
  );
  if (drift.suspectTurns && drift.suspectTurns.length) {
    lines.push('look first at:');
    for (const s of drift.suspectTurns) {
      lines.push(`  - user turn ${s.turn} (${s.words}w, ${s.markers} marker(s)): ${s.preview}`);
    }
  }
  return lines.join('\n');
}
