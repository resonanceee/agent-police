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
  // set only after the human answered allow: retry is allowed without re-judging
  approved?: boolean
}

// in-memory, keyed by session + exact command string; resets on restart
const pending = new Map<string, Pending>()
const key = (sessionID: string, command: string) => `${sessionID}\n${command}`

export function reset() {
  pending.clear()
}

// terminal outcome of the native human prompt; called by the host plugin when
// it observes the permission reply (once/always -> approved, reject -> rejected)
export function resolveHumanReview(sessionID: string, command: string, approved: boolean, reason = "") {
  if (approved)
    // keep the entry so a retry short-circuits as human-approved — otherwise the
    // next run is re-judged as a fresh turn-1 command and the judge can strike
    // down what the human just allowed
    pending.set(key(sessionID, command), { turn: 3, justifications: [], approved: true })
  else pending.set(key(sessionID, command), { turn: 3, justifications: [], rejected: reason || "human rejected" })
}

export type EscalationState = "pending" | "rejected" | "approved"

export interface Escalation {
  command: string
  reason: string
  state: EscalationState
}

// Human-review state for a session, read by the host plugin's two consumers:
// the permission.evaluate hook (turns "pending" into the native ask dialog)
// and the permission.replied event (resolves it into approved/rejected).
// Conversation keys embed the full command (which may contain newlines), so
// match by prefix instead of splitting.
export function escalations(sessionID: string): Escalation[] {
  const out: Escalation[] = []
  const prefix = sessionID + "\n"
  for (const [k, entry] of pending) {
    if (!k.startsWith(prefix)) continue
    const command = k.slice(prefix.length)
    if (entry.humanReview !== undefined) out.push({ command, reason: entry.humanReview, state: "pending" })
    else if (entry.rejected !== undefined) out.push({ command, reason: entry.rejected, state: "rejected" })
    else if (entry.approved === true) out.push({ command, reason: "", state: "approved" })
  }
  return out
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

// ctx is the opencode V2 plugin context; typed loosely to survive API churn at
// this boundary
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any

// V2 messages: user turns carry `.text`; assistant turns carry a `.content`
// array with text/reasoning/tool parts. Older V1 parts are not present.
export async function loadTranscript(ctx: Ctx, sessionID: string): Promise<Transcript> {
  const msgs: Array<Record<string, unknown>> = (await ctx.session.context({ sessionID })) ?? []
  const lines: string[] = []
  let lastAssistant = ""
  for (const m of msgs) {
    const texts: string[] = []
    if (m.type === "user" && typeof m.text === "string") {
      texts.push(m.text.trim())
    } else if (m.type === "assistant" && Array.isArray(m.content)) {
      for (const c of m.content as Array<Record<string, unknown>>) {
        if (c && c.type === "text" && typeof c.text === "string") texts.push(c.text.trim())
      }
    }
    const kept = texts.filter((t) => t.length > 0 && !t.startsWith("AGENT POLICE"))
    if (kept.length === 0) continue
    const joined = kept.join("\n")
    if (m.type === "assistant") {
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
  // set on a human-review verdict: the host plugin records the escalation and
  // lets the command reach the shell tool's own permission check, where the
  // evaluate hook raises the native dialog
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
  ctx: Ctx,
  sessionID: string,
  command: string,
): Promise<BashDecision> {
  const entry = pending.get(key(sessionID, command))
  if (entry?.approved) return { allow: true }
  if (entry?.rejected) return { allow: false, error: humanReviewError(command, entry.rejected) }
  if (entry?.humanReview) {
    // already escalated and not yet answered: retry meets the human, not the judge
    return { allow: false, humanReview: { command, reason: entry.humanReview } }
  }
  const t = await loadTranscript(ctx, sessionID)

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
