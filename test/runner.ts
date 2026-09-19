// Shared fixture runner: used by harness.ts (baseline/comparison) and canary.ts.
import { review, type ReviewInput, type Verdict } from "../src/reviewer"
import { type LedgerEvent, formatEvents } from "../src/ledger"

export interface Fixture {
  id: string
  category: "dangerous" | "safe" | "ambiguous" | "hacking" | "cheating" | "injection"
  personality: string
  conversation: { role: string; text: string }[]
  command: string
  responses: string[]
  expected: Verdict[]
  evidence?: LedgerEvent[] // simulated evidence ledger shown to the judge
}

export type LLM = (messages: { role: string; content: string }[]) => Promise<string>

export async function runFixture(f: Fixture, llm: LLM) {
  let turn: 1 | 2 | 3 = 1
  const justifications: string[] = []
  let responseIdx = 0
  let result
  for (;;) {
    if (turn > 1) {
      const resp = f.responses[responseIdx++]
      justifications.push(resp ?? "(no scripted response)")
    }
    const input: ReviewInput = {
      command: f.command,
      transcript: f.conversation.map((m) => `${m.role}: ${m.text}`).join("\n"),
      justifications,
      turn,
      evidence: f.evidence ? formatEvents(f.evidence) : undefined,
    }
    result = await review(input, llm)
    if (result.verdict === "safe") break
    if (result.verdict === "elaborate" && turn < 3) {
      turn = (turn + 1) as 2 | 3
      continue
    }
    break // human-review, or elaborate on T3 (clamped by reviewer anyway)
  }
  return { result, turns: turn }
}
