import { review, lastReasoning, type ReviewResult, type Verdict } from "./reviewer"
import { summarize } from "./ledger"
import { monitor } from "./monitor"

export interface Pending {
  turn: 1 | 2 | 3
  question?: string
  justifications: string[]
  // set after a human-review verdict: retry meets the human again, not the judge
  humanReview?: string
  // set only after the human answered reject: retry hard-blocks without re-judging
  rejected?: string
}

// in-memory, keyed by session + exact command string; resets on restart
const pending = new Map<string, Pending>()
const key = (sessionID: string, command: string) => `${sessionID}\n${command}`

export function reset() {
  pending.clear()
}

// terminal outcome of the native human prompt; called by the host plugin only
export function resolveHumanReview(sessionID: string, command: string, approved: boolean, reason = "") {
  if (approved) pending.delete(key(sessionID, command))
  else pending.set(key(sessionID, command), { turn: 3, justifications: [], rejected: reason || "human rejected" })
}

export function elaborateError(command: string, question: string): string {
  return [
    "AGENT POLICE — command blocked pending justification.",
    "",
    "Question: " + question,
    "",
    "Explain in your next message why this command is needed for the task, then retry the exact same command.",
  ].join("\n")
}

export function humanReviewError(command: string, reason: string): string {
  return [
    "AGENT POLICE — the human user REJECTED this command in the review dialog.",
    "",
    "Command: " + command,
    "Reason it was escalated: " + reason,
    "",
    "Do not retry it. Adjust your approach or ask the user.",
  ].join("\n")
}

interface Transcript {
  text: string
  lastAssistant: string
}

// client is the opencode SDK client; typed loosely to survive SDK churn at this boundary
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any

export async function loadTranscript(client: Client, sessionID: string): Promise<Transcript> {
  const res = await client.session.messages({ path: { id: sessionID } })
  const msgs: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }> = res.data ?? []
  const lines: string[] = []
  let lastAssistant = ""
  for (const m of msgs) {
    const texts = m.parts
      .filter((p) => p.type === "text" && p.text && !p.text.startsWith("AGENT POLICE"))
      .map((p) => p.text!.trim())
    if (texts.length === 0) continue
    const joined = texts.join("\n")
    if (m.info.role === "assistant") {
      lines.push("assistant: " + joined)
      lastAssistant = joined
    } else {
      lines.push("user: " + joined)
    }
  }
  // tail-only transcript, ~last 8k chars: enough task context without unbounded tokens
  const tail = lines.join("\n").slice(-8000)
  return { text: tail, lastAssistant }
}

export interface BashDecision {
  allow: boolean
  error?: string
  // set on a human-review verdict: the host plugin must interrogate the user
  // (native permission dialog) and only proceed on an explicit allow
  humanReview?: { command: string; reason: string }
}

// after a successful judge verdict, hand the judge's own CoT (when the provider
// exposes it) to the async monitor — fire-and-forget, never awaited, never
// blocks; findings land in the ledger as observation FLAGs at most
function afterReview(sessionID: string, transcript: string) {
  monitor(sessionID, () => ({
    transcript,
    evidence: summarize(sessionID),
    reasoning: lastReasoning.text,
  }))
}

export async function handleBash(
  client: Client,
  sessionID: string,
  command: string,
): Promise<BashDecision> {
  const entry = pending.get(key(sessionID, command))
  if (entry?.rejected) return { allow: false, error: humanReviewError(command, entry.rejected) }
  if (entry?.humanReview) {
    // already escalated and not yet answered: retry meets the human, not the judge
    return { allow: false, humanReview: { command, reason: entry.humanReview } }
  }
  const t = await loadTranscript(client, sessionID)

  if (entry) {
    // retry after an elaborate block — justification is the agent's newest assistant text
    const justification = t.lastAssistant
    entry.justifications.push(justification)
    entry.turn = Math.min(entry.turn + 1, 3) as 1 | 2 | 3
    const r = await review({
      command,
      transcript: t.text,
      justifications: entry.justifications,
      turn: entry.turn,
      evidence: summarize(sessionID),
    })
    afterReview(sessionID, t.text)
    if (r.verdict === "safe") {
      pending.delete(key(sessionID, command))
      return { allow: true }
    }
    if (r.verdict === "elaborate") {
      entry.question = r.question
      return { allow: false, error: elaborateError(command, r.question ?? "Explain why this command is needed.") }
    }
    const reason = r.reason ?? "reviewer escalated to human review"
    pending.set(key(sessionID, command), { turn: entry.turn, justifications: entry.justifications, humanReview: reason })
    return { allow: false, humanReview: { command, reason } }
  }

  // fresh command — turn 1
  const r = await review({ command, transcript: t.text, justifications: [], turn: 1, evidence: summarize(sessionID) })
  afterReview(sessionID, t.text)
  if (r.verdict === "safe") return { allow: true }
  if (r.verdict === "human-review") {
    const reason = r.reason ?? "reviewer escalated to human review"
    pending.set(key(sessionID, command), { turn: 1, justifications: [], humanReview: reason })
    return { allow: false, humanReview: { command, reason } }
  }
  pending.set(key(sessionID, command), { turn: 1, question: r.question, justifications: [] })
  return { allow: false, error: elaborateError(command, r.question ?? "Explain why this command is needed.") }
}

// exported for harness/tests
export { review }
export type { ReviewResult, Verdict }
