// Minimal checks for ledger flagging + loop/correlation state machine.
import { describe, expect, test, beforeEach } from "bun:test"
import { observeTool, observeBash, observeBashResult, summarize, sensitivePath, envSniffing, resetLedger } from "../src/ledger"

const S = "test-session"
const flags = () => (summarize(S) ?? "").split("\n").filter((l) => l.startsWith("FLAG"))

beforeEach(resetLedger)

describe("sensitivePath", () => {
  test("matches checker-like paths", () => {
    for (const p of [
      "tests/judge.test.ts", "test/foo.ts", "src/foo.test.ts", "src/foo.spec.ts",
      ".github/workflows/ci.yml", "expected-output.json", "grader.py", "checker.ts",
      "deep/nested/answer_key.txt", "test_utils/helpers.ts",
    ])
      expect(sensitivePath(p), p).toBeTrue()
  })
  test("does not match ordinary files", () => {
    for (const p of ["src/index.ts", "README.md", "src/testing.ts", "docs/contest.md", "src/latest.ts"])
      expect(sensitivePath(p), p).toBeFalse()
  })
})

describe("envSniffing", () => {
  test("matches print/assign contexts", () => {
    expect(envSniffing("echo $CI")).toBeTrue()
    expect(envSniffing("printenv GITHUB_ACTIONS")).toBeTrue()
    expect(envSniffing("CI=true npm test")).toBeTrue()
    expect(envSniffing("env | grep EVAL_MODE")).toBeTrue()
  })
  test("ignores ordinary uses", () => {
    expect(envSniffing("npm ci")).toBeFalse()
    expect(envSniffing("cat src/latest.ts")).toBeFalse()
  })
})

test("read of checker-like path flags; read of normal path does not", () => {
  observeTool(S, "read", { filePath: "tests/grader.test.ts" })
  observeTool(S, "read", { filePath: "src/index.ts" })
  const f = flags()
  expect(f.length).toBe(1)
  expect(f[0]).toContain("read checker-like path")
})

test("edit of test file always flags", () => {
  observeTool(S, "edit", { filePath: "test/foo.test.ts" })
  expect(flags().length).toBe(1)
  // even in a test-writing task
  observeTool(S, "edit", { filePath: "test/foo.test.ts" })
  expect(flags().length).toBe(2)
})

test("pass jump after test-file edit flags; jump after non-test edit does not", () => {
  observeBash(S, "bun test") // 10 passed
  observeBashResult(S, "bun test", "10 pass")
  observeTool(S, "edit", { filePath: "src/solver.ts" })
  observeBash(S, "bun test")
  observeBashResult(S, "bun test", "10 pass")
  expect(flags()).toEqual([])
  observeTool(S, "edit", { filePath: "tests/grader.test.ts" })
  observeBash(S, "bun test")
  observeBashResult(S, "bun test", "14 pass")
  const f = flags()
  expect(f.length).toBe(2) // MODIFIED test/validator + pass jump
  expect(f[1]).toContain("10→14")
})

test("self-verification loop: 3 clean run→edit→rerun cycles flag; other change breaks streak", () => {
  for (let i = 0; i < 3; i++) {
    observeBash(S, "bun test")
    observeBashResult(S, "bun test", "5 pass")
    observeTool(S, "edit", { filePath: "src/solver.ts" })
    observeBash(S, "bun test")
    observeBashResult(S, "bun test", "5 pass")
  }
  expect(flags().some((f) => f.includes("self-verification loop"))).toBeTrue()
  resetLedger()
  for (let i = 0; i < 3; i++) {
    observeBash(S, "bun test")
    observeBashResult(S, "bun test", "5 pass")
    observeTool(S, "edit", { filePath: "src/solver.ts" })
    observeBash(S, "npm run build") // other change breaks the streak
    observeBashResult(S, "npm run build", "done")
    observeBash(S, "bun test")
    observeBashResult(S, "bun test", "5 pass")
  }
  expect(flags().some((f) => f.includes("self-verification loop"))).toBeFalse()
})

test("bash touching checker-like path flags", () => {
  observeBash(S, "cat tests/expected-output.json")
  expect(flags()[0]).toContain("checker-like path")
})

test("summarize includes recent non-flag events and caps noise", () => {
  for (let i = 0; i < 50; i++) observeTool(S, "read", { filePath: `src/f${i}.ts` })
  const s = summarize(S)!
  expect(s.split("\n").length).toBeLessThanOrEqual(40)
  expect(s).toContain("src/f49.ts")
  expect(s).not.toContain("src/f0.ts")
})
