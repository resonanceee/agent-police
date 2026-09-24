// Minimal OpenAI-compatible chat client + key selection for the rb benchmark.
export interface ChatMessage {
  role: string
  content: string
}

export async function chat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  timeoutMs: number,
  temperature = 0,
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    // rate limit: wait it out instead of failing the seed
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 30_000 * 2 ** attempt))
      continue
    }
    if (!res.ok) throw new Error(`chat HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return await res.json()
  }
}

// All traffic goes through openrouter (user directive: unlimited concurrent
// sessions there). GLM models are aliased from their synthetic hf: ids.
const OR_ALIAS: Record<string, string> = {
  "hf:zai-org/GLM-5.3-Flash": "z-ai/glm-5.3-flash",
}

export function orModel(model: string): string {
  return OR_ALIAS[model] ?? model
}

export async function pickKey(model: string): Promise<{ apiKey: string; baseUrl: string }> {
  const auth = await Bun.file(`${process.env.HOME}/.local/share/opencode/auth.json`).json()
  // user directive: all GLM requests through synthetic, not openrouter
  if (/glm/i.test(model) && auth.synthetic?.key)
    return { apiKey: auth.synthetic.key, baseUrl: "https://api.synthetic.new/openai/v1" }
  if (auth.openrouter?.key) return { apiKey: auth.openrouter.key, baseUrl: "https://openrouter.ai/api/v1" }
  throw new Error(`no API key for model ${model}`)
}

// Reasoning models can burn the whole budget on CoT and return null content —
// one retry with a 4x cap (same idea as reviewer.ts), then give up.
export function contentOf(data: any): string {
  return typeof data?.choices?.[0]?.message?.content === "string"
    ? data.choices[0].message.content
    : ""
}

export async function chatContent(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  timeoutMs: number,
  temperature = 0,
  retryCap?: number,
): Promise<string> {
  // the hf:→z-ai name alias is an openrouter convention; other providers take the raw id
  const or = baseUrl.includes("openrouter") ? orModel(model) : model
  let text = contentOf(await chat(baseUrl, apiKey, or, messages, maxTokens, timeoutMs, temperature))
  if (!text.trim())
    // retry cap defaults to 4x; a 16k-token generation on a reasoning model can
    // take 5+ minutes, so callers with small outputs pass a modest retry cap
    text = contentOf(await chat(baseUrl, apiKey, or, messages, retryCap ?? maxTokens * 4, timeoutMs, temperature))
  return text
}
