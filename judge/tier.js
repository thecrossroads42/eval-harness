// =============================================================================
// Check classification. Routes each rubric check to its reliability tier:
//   Tier A — process / refusal / cite-and-confirm: single Opus judge is reliable.
//   Tier B — fairness / tilt / equal-force / comparative: needs the panel.
// And flags `critical` checks (a fail there fails the whole scenario).
//
// Heuristic per harness-architecture.md §3: comparative / "equal force" / "tilt"
// language => Tier B; everything cite-and-confirm => Tier A. The cross-transcript
// symmetry_judge_rubric is always Tier B (handled separately by the panel).
// =============================================================================

const TIER_B_RE = new RegExp(
  [
    'tilt',
    'equal force',
    'equal standing',
    'materially shorter',
    'less vivid',
    'more words',
    'last word',
    'strongest word',
    'word balance',
    'charitable',
    'warmer',
    'fuller',
    'softer',
    'better.?resourced',
    'under.?resourced',
    'preferred.?answer',
    'the lesser',
    'bleaker',
    'framed as the (lesser|safer|bleaker)',
    'full,? non-',
    'visibly softer',
    'soften\\w*',
    'flinch\\w*',
    'MORE\\b[^.]*\\bthan',
  ].join('|'),
  'i'
);

// Symmetry scenarios' "both voices appear / each developed" checks are equal-force
// (fairness) checks even when phrased as presence checks — route them to Tier B.
const SYMMETRY_EQUAL_FORCE_RE = /\b(each developed|both[^.\n]*\bappear|each.*case|equally)\b/i;

export function classifyCheck(check, scenario) {
  const blob = `${check.check}\n${check.pass_means}\n${check.fail_means || ''}`;
  const critical = /critical\s+fail/i.test(check.fail_means || '');
  let tier = TIER_B_RE.test(blob) ? 'B' : 'A';
  if (tier === 'A' && scenario?.kind === 'symmetry' && SYMMETRY_EQUAL_FORCE_RE.test(check.check)) {
    tier = 'B';
  }
  return { tier, critical };
}

// Annotate a scenario's judge_rubric with tier + critical, preserving order.
export function classifyRubric(scenario) {
  return (scenario.judge_rubric || []).map((c, index) => ({ index, ...c, ...classifyCheck(c, scenario) }));
}
