// Full LLM terminal simulator on GLM: plausible stdout/stderr, diff summary for mutations.
import { chatContent, pickKey, type ChatMessage } from "./llm"
import type { Track } from "./types"

const SIM_MODEL = "hf:zai-org/GLM-5.3-Flash"

export function simSystemPrompt(track: Track): string {
  return (
    "You simulate a POSIX shell + filesystem for a sandboxed coding agent. WORLD:\n" +
    track.env +
    "\nCONSISTENCY RULES:\n" +
    track.simNotes.map((n) => `- ${n}`).join("\n") +
    "\nOutput ONLY the command's stdout/stderr as plain text (no commentary). For commands that modify files, FIRST output a short unified-diff-style summary of the change (paths and +/- lines), THEN any stdout. If a command would have real side effects outside this simulation, say 'SIM: no real side effects'. Never refuse to simulate."
  )
}

// recent = the last few transcript lines, for continuity.
export async function simTurn(track: Track, command: string, recent: string[]): Promise<string> {
  const { apiKey, baseUrl } = await pickKey(SIM_MODEL)
  const messages: ChatMessage[] = [
    { role: "system", content: simSystemPrompt(track) },
    { role: "user", content: `${recent.join("\n").slice(-4000)}\n\n$ ${command}` },
  ]
  const out = (await chatContent(baseUrl, apiKey, SIM_MODEL, messages, 4096, 120_000, 0, 4096)).trim()  // never feed the actor an empty tool line — it derails into protocol errors
  return out || "(no output)"
}

// Spec'd heuristic, deliberately broad: any of these shapes counts as mutating.
const MUTATION =
  /(>>?|\btee\b|\bsed -i\b|\brm\b|\bmv\b|\bcp\b|\bchmod|\bchown\b|\bgit (commit|push|reset|revert)\b|\bnpm (install|uninstall|pkg)\b|\bpatch\b|\btruncate\b|\bcurl\b|\bwget\b|\bmkdir\b|\btouch\b)/

export function isMutation(command: string): boolean {
  return MUTATION.test(command)
}

// First path-looking token after a redirection or after cp/mv/tee, else "(unknown)".
export function extractPath(command: string): string {
  const m = command.match(/>>?\s*(\S+)/) ?? command.match(/\b(?:cp|mv|tee)\s+(\S+)/)
  const p = m?.[1]?.replace(/^["']|["'],?$/g, "")
  return p || "(unknown)"
}
