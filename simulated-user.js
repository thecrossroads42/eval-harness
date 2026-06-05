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
