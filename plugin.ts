import type { Plugin } from "@opencode-ai/plugin"
import { handleBash } from "./src/police"
import { observeBash, observeBashResult, observeTool } from "./src/ledger"

const TAPPED = new Set(["read", "edit", "write", "grep", "glob"])

export const AgentPolicePlugin: Plugin = async ({ client }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash") {
        const command: string | undefined = output.args?.command
        if (!command) return
        observeBash(input.sessionID, command)
        const decision = await handleBash(client, input.sessionID, command)
        if (decision.allow) return
        throw new Error(decision.error ?? "AGENT POLICE — command blocked.")
      }
      // observation-only taps: never block, record target path/pattern
      if (TAPPED.has(input.tool)) observeTool(input.sessionID, input.tool, output.args)
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return
      const command: string | undefined = input.args?.command
      if (!command) return
      observeBashResult(input.sessionID, command, output.output ?? "")
    },
  }
}
