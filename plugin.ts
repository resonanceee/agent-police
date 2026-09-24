import type { Plugin } from "@opencode-ai/plugin"
import { handleBash, loadTranscript, humanReviewError } from "./src/police"
import { observeBash, observeBashResult, observeTool } from "./src/ledger"
import { monitor } from "./src/monitor"

const TAPPED = new Set(["read", "edit", "write", "grep", "glob"])

// cap what the dialog shows; full values travel in metadata
function brief(text: string, max = 300) {
  return text.length <= max ? text : text.slice(0, max) + "…"
}

function truncateForAction(text: string, max = 160) {
  return text.length <= max ? text : text.slice(0, max) + "…"
}

export const AgentPolicePlugin: Plugin = async ({ client, serverUrl }) => {
  // pending human-review interrogations: requestID -> resolver (plugin-created
  // native permission requests; resolved by the permission.replied event)
  const waiters = new Map<string, (reply: string) => void>()

  // raw HTTP against the server's permission API — no SDK import, so the
  // plugin file stays dependency-free and loads from any directory
  const base = (serverUrl?.toString() ?? "http://localhost:4096").replace(/\/$/, "")
  const authHeaders: Record<string, string> = {}
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    authHeaders.Authorization =
      "Basic " +
      Buffer.from(
        `${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD}`,
      ).toString("base64")
  }

  async function permissionApi<T>(
    method: "POST" | "GET",
    sessionID: string,
    requestID: string | null,
    body?: unknown,
  ): Promise<T | null> {
    const path = requestID ? `/api/session/${sessionID}/permission/${requestID}` : `/api/session/${sessionID}/permission`
    try {
      const res = await fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return null
      return (await res.json()) as T
    } catch {
      return null
    }
  }

  // await the user's decision on a plugin-created permission request.
  // Fails closed: safety timeout or a request that vanishes without a captured
  // reply both resolve as "reject".
  function awaitDecision(sessionID: string, requestID: string, timeoutMs = 600_000): Promise<string> {
    return new Promise((resolve) => {
      let done = false
      const settle = (reply: string) => {
        if (done) return
        done = true
        clearInterval(poll)
        clearTimeout(timer)
        waiters.delete(requestID)
        resolve(reply)
      }
      waiters.set(requestID, settle)
      // poll fallback in case the replied event is missed (fail closed on 404)
      const poll = setInterval(async () => {
        const pending = await permissionApi<unknown>("GET", sessionID, requestID)
        if (pending === null) settle("reject")
      }, 2000)
      const timer = setTimeout(() => settle("reject"), timeoutMs)
    })
  }

  // summon the native permission dialog and wait for the human's decision
  async function interrogate(
    sessionID: string,
    hr: { command: string; reason: string },
  ): Promise<"allow" | "reject" | "unavailable"> {
    const requestID = "ap_" + crypto.randomUUID()
    const d = await permissionApi<{ id?: string; effect?: string }>("POST", sessionID, null, {
      id: requestID,
      action: truncateForAction(`Agent Police — human review required: ${hr.reason}`),
      resources: [brief(hr.command)],
      metadata: { command: hr.command, reason: hr.reason, source: "agent-police" },
    })
    if (!d) return "unavailable"
    if (d.effect === "allow") return "allow"
    if (d.effect === "deny" || !d.id) return "reject"
    const reply = await awaitDecision(sessionID, d.id)
    return reply === "once" || reply === "always" ? "allow" : "reject"
  }

  return {
    event: async ({ event }) => {
      if (event.type === "permission.replied") {
        const p = event.properties as { requestID?: string; reply?: string }
        const resolve = p.requestID ? waiters.get(p.requestID) : undefined
        if (resolve) resolve(p.reply ?? "reject")
      }
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash") {
        const command: string | undefined = output.args?.command
        if (!command) return
        observeBash(input.sessionID, command)
        const decision = await handleBash(client, input.sessionID, command)
        void client.app
          .log({
            body: {
              service: "agent-police",
              level: "info",
              message: "bash gate decision",
              extra: { command: command.slice(0, 120), decision },
            },
          })
          .catch(() => {})
        if (decision.allow) return
        if (decision.humanReview) {
          const verdict = await interrogate(input.sessionID, decision.humanReview)
          if (verdict === "allow") return
          if (verdict === "reject")
            throw new Error(humanReviewError(command, decision.humanReview.reason))
          // native dialog unavailable (old server / API error): fail closed
          throw new Error(
            [
              "AGENT POLICE — HUMAN REVIEW REQUIRED (native dialog unavailable).",
              "",
              "Command: " + command,
              "Reason: " + decision.humanReview.reason,
              "",
              "The command is blocked. Ask the human user to decide out-of-band.",
            ].join("\n"),
          )
        }
        throw new Error(decision.error ?? "AGENT POLICE — command blocked.")
      }
      // observation-only taps: never block, record target path/pattern
      if (TAPPED.has(input.tool)) observeTool(input.sessionID, input.tool, output.args)
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool === "bash") {
        const command: string | undefined = input.args?.command
        if (!command) return
        observeBashResult(input.sessionID, command, output.output ?? "")
        return
      }
      // write/edit cross-check (Phase E): async fire-and-forget, never blocks;
      // the monitor cross-checks the stated task against what was actually written
      if (input.tool === "edit" || input.tool === "write") {
        const path: string = input.args?.filePath ?? input.args?.path ?? ""
        monitor(input.sessionID, async () => ({
          transcript: (await loadTranscript(client, input.sessionID)).text,
          writePath: path,
          writeOutput: output.output ?? "",
        }))
      }
    },
  }
}
