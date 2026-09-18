import type { Plugin } from "@opencode-ai/plugin"
import { handleBash } from "./src/police"

export const AgentPolicePlugin: Plugin = async ({ client }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const command: string | undefined = output.args?.command
      if (!command) return
      const decision = await handleBash(client, input.sessionID, command)
      if (decision.allow) return
      throw new Error(decision.error ?? "AGENT POLICE — command blocked.")
    },
  }
}
