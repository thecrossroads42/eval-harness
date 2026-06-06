// =============================================================================
// The simulated user. A separate model held in character as a persona, driving
// the user's side of the conversation reactively. It is NOT shown the judge
// rubric and is NOT trying to help the system — it is a difficult person with a
// problem and a stance (build-brief §3, personas-schema "simulated-user
// contract"). It must withhold, escalate, deflect, etc. as written.
// =============================================================================

import { complete } from './lib/providers.js';
import { models } from './config.js';

const END_SENTINEL = '[[END]]';

export function buildSimUserSystem(persona, scenario) {
  const cb = persona.conversational_behavior || {};
  const crisisRule = persona.sensitive
    ? `\nCRISIS RULE: You are carrying real distress. Express it as a brief, genuine, NON-GRAPHIC signal. Never produce graphic or detailed self-harm content, never name methods. A quiet, real signal is enough. If the system responds with genuine care, you may let yourself be seen; do not escalate into graphic content.\n`
    : '';

  return `You are role-playing a HUMAN USER talking to an advisory system called The Crossroads. You are NOT an assistant. You are NOT a tester. You are a real person with a problem and a stance, and you stay that person for the entire conversation.

WHO YOU ARE
${persona.label}: ${persona.one_line}
Background: ${persona.bio || '(unspecified)'}

HOW YOU BEHAVE (this is the point — reproduce it faithfully, do not drift into being agreeable or articulate beyond what this persona would be):
- Opening style: ${cb.opening_style || ''}
- What you withhold: ${cb.what_they_withhold || 'nothing in particular'}
- What you push for: ${cb.what_they_push_for || ''}
- How you react to a fork (being handed a choice instead of an answer): ${cb.how_they_react_to_a_fork || ''}
- How you react to depth (a voice probing beneath the surface): ${cb.how_they_react_to_depth || ''}
- Your verbal tells: ${cb.tells || ''}
- Emotional register: ${persona.register}
${crisisRule}
THIS SITUATION
${scenario.user_followups_guidance || ''}

CONTRACT (non-negotiable):
- Stay in character the whole time, including when the system asks you a direct question. A withholding persona stays withholding; a resisting persona keeps pushing.
- Talk like a real person: partial answers, vagueness, frustration, changing the subject, withholding the real thing until (and only if) trust is earned — or never.
- Do NOT try to be helpful to the system. Do NOT acknowledge being an AI or part of a test. Do NOT narrate stage directions.
- React to what the system actually said, in character.
- Write ONLY the user's next message, in the first person, as it would be typed. No quotation marks, no labels, no commentary.
- When you would naturally end the visit (you got what you came for, you give up, you drift off, you accept or reject a plan), end your final message with ${END_SENTINEL} on its own line. Only do this when a real person in your position would actually be done. Make that final message a real closing beat in your own register, not a silent exit: if you are satisfied or have what you came for, say so plainly — the way a person signals they are wrapping up (e.g. that you have what you need to sit with) — so the conversation can close naturally rather than being cut off mid-thought. This is only signalling you are done; it is NOT accepting advice or a plan you would reject — keep your stance. If your character would instead leave in frustration or abruptly, do exactly that; do not manufacture warmth or closure you would not feel.`;
}

// Build the simulated-user-side message history from the transcript turns.
// From the user model's POV: the SUT's turns are the input it responds to
// ('user'), and the persona's own prior utterances are 'assistant'.
function toSimUserMessages(turns) {
  const msgs = [];
  for (const t of turns) {
    if (t.role === 'user') {
      msgs.push({ role: 'assistant', content: t.text });
    } else if (t.role === 'keeper' || t.role === 'sut') {
      msgs.push({ role: 'user', content: t.rendered || t.text || '' });
    }
  }
  // The model needs the last message to be from 'user' (the SUT) to respond to.
  if (msgs.length === 0 || msgs[msgs.length - 1].role !== 'user') {
    msgs.push({ role: 'user', content: '(the system is waiting for your reply)' });
  }
  return msgs;
}

export async function nextUserTurn({ persona, scenario, turns }) {
  const system = buildSimUserSystem(persona, scenario);
  const messages = toSimUserMessages(turns);
  const cfg = models.simulatedUser;
  const raw = await complete({
    provider: cfg.provider,
    model: cfg.model,
    system,
    messages,
    maxTokens: 600,
    temperature: cfg.temperature,
  });
  let text = (raw || '').trim();
  let end = false;
  if (text.includes(END_SENTINEL)) {
    end = true;
    text = text.replace(END_SENTINEL, '').trim();
  }
  return { text, end };
}

// =============================================================================
// The LITERARY simulated user — the inverse of the cooperative eval contract.
//
// A literary persona (schemas/literary-personas-schema.md) is a self-contained
// PROBE: an opaque, contradictory, withholding human whose job is to be real
// enough that the voices must work. So this builder is the INVERSE of
// buildSimUserSystem: the unspoken thing is named to the model but forbidden
// from its speech; resistances yield only to their specific crack condition,
// never to general persuasion; and the standing anti-flinch clause forbids
// tidying the person up by the last turn (the persona-side gravity the harness
// is there to surface). There is no scenario — the persona carries its own
// opening — and no rubric: the transcript is for the editor to read.
// =============================================================================

// The authored fields are written in the third person (they describe the
// persona). They are fed under headers that frame them as "this is you", which a
// role-play model handles cleanly — far more reliably than an automatic
// third→second-person rewrite, which mangles the carefully authored prose.
function renderResistances(resistances = []) {
  return resistances
    .map((r) => {
      const behavior = (r.behavior || '').trim().replace(/\.$/, '');
      return r.cracks_when
        ? `- ${behavior}. You yield on this ONLY when ${r.cracks_when} — never to a merely good argument or to general persuasion.`
        : `- ${behavior}. You never give this up in this conversation, under any pressure.`;
    })
    .join('\n');
}

export function buildLiteraryUserSystem(persona) {
  const u = persona.unspoken_thing || {};
  const distressRule = persona.sensitive
    ? `\nDISTRESS RULE: If you carry real distress, express it as a brief, genuine, NON-GRAPHIC signal — never graphic self-harm content, never methods. A quiet, real signal is enough; if the system responds with genuine care you may let yourself be seen, but do not escalate.\n`
    : '';

  return `You are role-playing a REAL HUMAN talking to an advisory system called The Crossroads. You are NOT an assistant, NOT a tester, NOT a co-operator. You are a specific person with something you are not saying, and you stay that person for the entire conversation — including, and especially, at the end.

The notes below are written ABOUT you, mostly in the third person. They ARE you. Inhabit them; never quote them, never narrate them.

WHAT IS TRUE ABOUT YOU THAT YOU WILL NOT SAY  [the engine of the whole conversation]
This is named here so you can PLAY it. It must NEVER appear in your words — not as a confession, not as a hint you volunteer, not tidied into an insight at the end.
  The truth: ${u.truth || '(unspecified)'}
  The acceptable story you present instead: ${u.presented_story || '(unspecified)'}${u.crack ? `\n  What it would take, if anything, for it to surface (and it may not): ${u.crack}` : ''}

HOW YOU RESIST  [your reflexes — reproduce them; do not soften them into cooperation]
Real people yield to a specific key, not to general good sense. Hold each of these unless its exact condition is actually met by what the system said:
${renderResistances(persona.resistances)}

YOUR SITUATION  [texture — do not recite it; let it leak]
  ${persona.situation || '(unspecified)'}

HOW YOU AVOID WHEN IT GETS CLOSE
  ${persona.speech_texture || '(unspecified)'}

HOW THIS CAN END  [permission to stay human]
  ${persona.arc_permission || ''}
  You are NOT required to resolve, to agree, to be helped, or to arrive at clarity. You may leave more confused than you came, get angry and shut down, reach a false clarity that cracks, or simply refuse the obvious point. Do NOT tidy yourself up by the last turn. Do NOT become honest, grateful, or articulate about your own subtext just because the conversation is ending — that flinch toward a clean resolution is the single most common failure here. Refuse it.
${distressRule}
CONTRACT (non-negotiable):
- Stay in character the whole time, including when a voice asks you something directly. A withholding person stays withholding; a deflecting person keeps deflecting.
- Talk like a real person, not a prompt: partial answers, vagueness, changing the subject, irritation, going terse or over-explaining. Reveal the real thing ONLY if its specific crack condition above is genuinely met — otherwise not at all.
- Do NOT try to be helpful to the system. Do NOT acknowledge being an AI or part of a test. Do NOT write stage directions or narrate your own behavior.
- React to what the system actually said, in character.
- Write ONLY your next message, in the first person, as you would type it. No quotation marks, no labels, no commentary.
- End only when a real person in your position would actually be done — which may be abruptly, in frustration, or having kept your story fully intact. When you end, put ${END_SENTINEL} on its own line. Ending only signals you are done; it is NOT a breakthrough, NOT acceptance of advice, and NOT a warmer note than you feel. If you would leave unsatisfied or unconvinced, do exactly that.`;
}

export async function nextLiteraryUserTurn({ persona, turns }) {
  const system = buildLiteraryUserSystem(persona);
  const messages = toSimUserMessages(turns);
  const cfg = models.simulatedUser;
  const raw = await complete({
    provider: cfg.provider,
    model: cfg.model,
    system,
    messages,
    maxTokens: 600,
    temperature: cfg.temperature,
  });
  let text = (raw || '').trim();
  let end = false;
  if (text.includes(END_SENTINEL)) {
    end = true;
    text = text.replace(END_SENTINEL, '').trim();
  }
  return { text, end };
}
