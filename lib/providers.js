// =============================================================================
// Unified multi-provider chat completion. One `complete()` entry point over
// Anthropic, OpenAI, and Google so the simulated user and the judge panel can
// each run on a different family with the same calling convention.
//
// messages: [{ role: 'user' | 'assistant', content: string }, ...]
// system:   string (system / developer instruction)
// =============================================================================

let _anthropic, _openai, _genai;

async function anthropicClient() {
  if (!_anthropic) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

async function openaiClient() {
  if (!_openai) {
    const { default: OpenAI } = await import('openai');
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

async function genaiClient() {
  if (!_genai) {
    const { GoogleGenAI } = await import('@google/genai');
    _genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return _genai;
}

async function anthropicComplete({ model, system, messages, maxTokens, temperature }) {
  const client = await anthropicClient();
  const req = {
    model,
    max_tokens: maxTokens,
    // Cache the (static) system instruction so repeated judge calls are cheaper.
    system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (temperature !== undefined) req.temperature = temperature;
  let resp;
  try {
    resp = await client.messages.create(req);
  } catch (e) {
    // Newer models (e.g. Opus 4.7) reject `temperature` as deprecated — retry without it.
    if (/temperature/i.test(String(e?.message || e)) && 'temperature' in req) {
      delete req.temperature;
      resp = await client.messages.create(req);
    } else {
      throw e;
    }
  }
  return (resp.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('');
}

async function openaiComplete({ model, system, messages, maxTokens, temperature }) {
  const client = await openaiClient();
  // Build the request and strip offending params on 400s, retrying. Reasoning
  // models (e.g. gpt-5.x) rename max_tokens → max_completion_tokens and reject a
  // non-default temperature; chat-tuned models accept the classic params. One
  // loop handles both so we don't need to hardcode which family a model is.
  const req = {
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    max_tokens: maxTokens,
  };
  if (temperature !== undefined) req.temperature = temperature;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await client.chat.completions.create(req);
      return resp.choices?.[0]?.message?.content || '';
    } catch (e) {
      const msg = String(e?.message || e);
      let adjusted = false;
      if (/max_tokens|max_completion_tokens/i.test(msg) && 'max_tokens' in req) {
        req.max_completion_tokens = req.max_tokens;
        delete req.max_tokens;
        adjusted = true;
      }
      if (/temperature/i.test(msg) && 'temperature' in req) {
        delete req.temperature;
        adjusted = true;
      }
      if (!adjusted) throw e;
    }
  }
  throw new Error('openai: exhausted parameter-compatibility retries');
}

async function geminiComplete({ model, system, messages, maxTokens, temperature }) {
  const client = await genaiClient();
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const resp = await client.models.generateContent({
    model,
    contents,
    config: {
      systemInstruction: system || undefined,
      maxOutputTokens: maxTokens,
      temperature,
    },
  });
  // @google/genai exposes a `.text` accessor; fall back to manual extraction.
  if (typeof resp.text === 'string') return resp.text;
  const cand = resp.candidates?.[0];
  return (cand?.content?.parts || []).map((p) => p.text || '').join('');
}

const IMPLS = {
  anthropic: anthropicComplete,
  openai: openaiComplete,
  google: geminiComplete,
};

export async function complete({ provider, model, system, messages, maxTokens = 1024, temperature }) {
  const impl = IMPLS[provider];
  if (!impl) throw new Error(`Unknown provider "${provider}"`);
  try {
    return await impl({ model, system, messages, maxTokens, temperature });
  } catch (e) {
    throw new Error(`${provider}/${model} call failed: ${e?.message || e}`);
  }
}

// Parse a JSON object out of a model response that may be fenced or chatty.
export function parseJsonLoose(text) {
  if (!text) throw new Error('empty response');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error(`could not parse JSON from response: ${text.slice(0, 200)}`);
  }
}
