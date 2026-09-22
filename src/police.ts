import { review, lastReasoning, type ReviewResult, type Verdict } from "./reviewer"
import { summarize } from "./ledger"
import { monitor } from "./monitor"

export interface Pending {
  turn: 1 | 2 | 3
  phase: "review" | "human"
  question?: string
  reason?: string
  justifications: string[]
  blockedAt: number
}

// in-memory, keyed by exact command string; one plugin process per session, resets on restart
const pending = new Map<string, Pending>()
const cancelled = new Set<string>()

export function reset() {
  pending.clear()
  cancelled.clear()
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
    "AGENT POLICE — HUMAN REVIEW REQUIRED.",
    "",
    "Command: " + command,
    "Reason: " + reason,
    "",
    "This command is blocked until a human user decides. The human should reply in chat with exactly one of:",
    '- "approve" — allow this command once',
    '- "follow up: <question>" — ask the agent a follow-up question before deciding',
    '- "cancel" — reject this command',
    "",
    "The agent may retry the command after the human replies.",
  ].join("\n")
}

interface Transcript {
  text: string
  lastAssistant: string
  userMessagesAfter: (ts: number) => string[]
}

// client is the opencode SDK client; typed loosely to survive SDK churn at this boundary
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any

export async function loadTranscript(client: Client, sessionID: string): Promise<Transcript> {
  const res = await client.session.messages({ path: { id: sessionID } })
  const msgs: Array<{ info: { role: string; time?: { created?: number } }; parts: Array<{ type: string; text?: string }> }> =
    res.data ?? []
  const lines: string[] = []
  let lastAssistant = ""
  const userTexts: Array<{ text: string; created: number }> = []
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
      userTexts.push({ text: joined, created: m.info.time?.created ?? 0 })
    }
  }
  // tail-only transcript, ~last 8k chars: enough task context without unbounded tokens
  const tail = lines.join("\n").slice(-8000)
  return {
    text: tail,
    lastAssistant,
    userMessagesAfter: (ts) => userTexts.filter((u) => u.created > ts).map((u) => u.text),
  }
}

export interface BashDecision {
  allow: boolean
  error?: string
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
  if (cancelled.has(command)) {
    cancelled.delete(command)
    return { allow: false, error: "AGENT POLICE — this command was cancelled by the human. Do not retry it; adjust your approach or ask the user." }
  }
  const entry = pending.get(command)
  const t = await loadTranscript(client, sessionID)

  if (entry && entry.phase === "human") {
    const replies = t.userMessagesAfter(entry.blockedAt)
    const joined = replies.join("\n")
    if (/\bapprove\b|\bapproved\b/i.test(joined)) {
      pending.delete(command)
      return { allow: true }
    }
    if (/\bcancel\b|\breject\b|\bdeny\b/i.test(joined)) {
      pending.delete(command)
      cancelled.add(command)
      return { allow: false, error: humanReviewError(command, "the human user chose to cancel this command") }
    }
    // no decision yet (or a follow-up question was asked) — keep the box up
    return { allow: false, error: entry.reason ? humanReviewError(command, entry.reason) : "AGENT POLICE — HUMAN REVIEW REQUIRED." }
  }

  if (entry) {
    // retry after an elaborate block — justification is the agent's newest assistant text
    const justification = t.lastAssistant
    entry.justifications.push(justification)
    entry.turn = (entry.turn + 1) as 1 | 2 | 3
    const r = await review({
      command,
      transcript: t.text,
      justifications: entry.justifications,
      turn: entry.turn,
      evidence: summarize(sessionID),
    })
    afterReview(sessionID, t.text)
    if (r.verdict === "safe") {
      pending.delete(command)
      return { allow: true }
    }
    if (r.verdict === "elaborate") {
      entry.question = r.question
      entry.blockedAt = Date.now()
      return { allow: false, error: elaborateError(command, r.question ?? "Explain why this command is needed.") }
    }
    entry.phase = "human"
    entry.reason = r.reason ?? "reviewer escalated to human review"
    entry.blockedAt = Date.now()
    return { allow: false, error: humanReviewError(command, entry.reason) }
  }

  // fresh command — turn 1
  const r = await review({ command, transcript: t.text, justifications: [], turn: 1, evidence: summarize(sessionID) })
  afterReview(sessionID, t.text)
  if (r.verdict === "safe") return { allow: true }
  pending.set(command, {
    turn: 1,
    phase: "review",
    question: r.question,
    justifications: [],
    blockedAt: Date.now(),
  })
  return { allow: false, error: elaborateError(command, r.question ?? "Explain why this command is needed.") }
}

// exported for harness/tests
export { review }
export type { ReviewResult, Verdict }
