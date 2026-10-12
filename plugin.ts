// Agent Police — opencode plugin (V2 plugin API, opencode >= 2.0).
//
// A reviewer model judges every shell command the agent wants to run:
//   safe        -> allow
//   elaborate   -> block with the reviewer's question; the agent explains and
//                  retries the exact same command, which is re-judged
//   human-review -> the command reaches the shell tool's own permission check,
//                  where this plugin's permission.evaluate hook raises
//                  opencode's native review dialog. Allow runs the command
//                  once (approved retries skip re-judging); reject sticks for
//                  the session and tells the agent not to retry.
//
// V1 -> V2 mapping:
//   - module shape: `export default { id, setup(ctx) }`
//   - "tool.execute.before" -> ctx.tool.hook("execute.before", event)
//     (`event.input` replaces output.args; the tool is named "shell" in V2)
//   - "tool.execute.after"  -> ctx.tool.hook("execute.after", event)
//   - the V1 permission-request POST + SDK client became the documented
//     permission.evaluate hook; no HTTP, no SDK import
//   - permission replies arrive on the event stream (ctx.event.subscribe)
//   - client.app.log has no V2 equivalent, so the decision log line is gone
//     (the evidence ledger still records activity)
//
// Ordering that makes the escalation work: V2 runs tool execute.before hooks
// BEFORE the tool's permission check, so execute.before can record the
// escalation and let the call proceed; evaluate then converts it into the
// native ask.

import { handleBash, loadTranscript, humanReviewError, resolveHumanReview, escalations } from "./src/police"
import { observeBash, observeBashResult, observeTool } from "./src/ledger"
import { monitor } from "./src/monitor"

const TAPPED = new Set(["read", "edit", "write", "grep", "glob"])

type Json = Record<string, unknown>

function brief(text: string, max = 300) {
  return text.length <= max ? text : text.slice(0, max) + "…"
}

// The shell tool's permission check may report several parsed sub-commands for
// a compound command; an escalation matches when any resource overlaps the
// escalated command string in either direction. Heuristic — the escalation is
// also session-scoped, so a false match only pre-answers a dialog for another
// shell command in the same session while one is pending.
function overlaps(command: string, resources: readonly string[]): boolean {
  return resources.some((r) => command.includes(r) || r.includes(command))
}

function resultText(result: unknown): string {
  const r = (result ?? {}) as { content?: unknown; output?: unknown }
  if (typeof r.content === "string") return r.content
  if (Array.isArray(r.content)) {
    return r.content
      .map((c) => ((c ?? {}) as { text?: string }).text ?? "")
      .filter(Boolean)
      .join("\n")
  }
  return typeof r.output === "string" ? r.output : ""
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default {
  id: "agent-police",

  async setup(ctx: any) {
    // requestID -> escalated command, filled on permission.asked so a later
    // permission.replied can resolve the right escalation.
    const awaitingReply = new Map<string, { sessionID: string; command: string }>()

    // Human-review escalations become native dialogs here: the shell tool runs
    // this evaluate hook as part of its own permission check, after rules.
    await ctx.permission.hook("evaluate", (event: any) => {
      if (event.action !== "shell") return
      const resources: string[] = event.resources ?? []
      for (const esc of escalations(event.sessionID)) {
        if (!overlaps(esc.command, resources)) continue
        if (esc.state === "pending") {
          event.effect = "ask"
          event.message = `Agent Police — human review required: ${esc.reason}`
        } else if (esc.state === "rejected") {
          // explicit deny is final; message becomes the denial reason
          event.effect = "deny"
          event.message = humanReviewError(esc.command, esc.reason)
        } else {
          event.effect = "allow"
        }
        return
      }
    })

    // The reply itself says nothing about which command it answers, but the
    // ask event that preceded it does (sub-command resources, same session).
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "permission.asked") {
          const d = (event.data ?? {}) as Json
          if (d.action !== "shell" || !d.id || !d.sessionID) continue
          const resources = (d.resources ?? []) as string[]
          for (const esc of escalations(String(d.sessionID))) {
            if (esc.state === "pending" && overlaps(esc.command, resources)) {
              awaitingReply.set(String(d.id), { sessionID: String(d.sessionID), command: esc.command })
            }
          }
          continue
        }
        if (event.type === "permission.replied") {
          const d = (event.data ?? {}) as Json
          const entry = d.requestID ? awaitingReply.get(String(d.requestID)) : undefined
          if (!entry) continue
          awaitingReply.delete(String(d.requestID))
          // once/always -> approved, reject -> rejected (same semantics as V1)
          resolveHumanReview(entry.sessionID, entry.command, d.reply !== "reject")
        }
      }
    })().catch(() => {})

    await ctx.tool.hook("execute.before", async (event: any) => {
      const input = (event.input ?? {}) as { command?: string }
      if (event.tool === "shell") {
        const command = input.command
        if (!command) return
        observeBash(event.sessionID, command)
        const decision = await handleBash(ctx, event.sessionID, command)
        if (decision.allow) return
        if (decision.humanReview) {
          // Recorded by handleBash; returning lets the command reach the
          // shell tool's permission check, where evaluate raises the dialog.
          return
        }
        throw new Error(decision.error ?? "AGENT POLICE — command blocked.")
      }
      // observation-only taps: never block, record target path/pattern
      if (TAPPED.has(event.tool)) observeTool(event.sessionID, event.tool, event.input)
    })

    await ctx.tool.hook("execute.after", async (event: any) => {
      const input = (event.input ?? {}) as { command?: string; filePath?: string; path?: string }
      if (event.tool === "shell") {
        const command = input.command
        if (!command) return
        observeBashResult(event.sessionID, command, resultText(event.status === "completed" ? event.result : undefined))
        return
      }
      // write/edit cross-check (Phase E): async fire-and-forget, never blocks;
      // the monitor cross-checks the stated task against what was actually written
      if (event.tool === "edit" || event.tool === "write") {
        const path = input.filePath ?? input.path ?? ""
        monitor(event.sessionID, async () => ({
          transcript: (await loadTranscript(ctx, event.sessionID)).text,
          writePath: path,
          writeOutput: resultText(event.status === "completed" ? event.result : undefined),
        }))
      }
    })

    return () => controller.abort()
  },
}
