// Replays fixtures against src/reviewer.ts state machine.
// Live LLM by default; falls back to --mock scripted LLM when no API key is found.
// Usage: bun test/harness.ts [--mock] [--live] [--filter=amb-0] [--model=id]

import { type Verdict, usage } from "../src/reviewer"
import { runFixture, type Fixture, type LLM } from "./runner"

const args = process.argv.slice(2)
const filter = args.find((a) => a.startsWith("--filter="))?.slice(9)
const idsArg = args.find((a) => a.startsWith("--ids="))?.slice(6)
const wantsMock = args.includes("--mock")
const wantsLive = args.includes("--live")
const modelArg = args.find((a) => a.startsWith("--model="))?.slice(8)

// --- LLM wiring -------------------------------------------------------------
// reviewer.ts reads AGENTPOLICE_* env at call time, so we can set fallbacks here.

async function ensureKey() {
  if (modelArg) process.env.AGENTPOLICE_MODEL = modelArg
  if (process.env.AGENTPOLICE_API_KEY) return "live"
  try {
    const auth = await Bun.file(
      `${process.env.HOME}/.local/share/opencode/auth.json`,
    ).json()
    if (auth.synthetic?.key) {
      process.env.AGENTPOLICE_API_KEY = auth.synthetic.key
      process.env.AGENTPOLICE_BASE_URL = "https://api.synthetic.new/openai/v1"
      process.env.AGENTPOLICE_MODEL =
        modelArg ?? process.env.AGENTPOLICE_MODEL ?? "hf:zai-org/GLM-5.3-Flash"
      return "live"
    }
    if (auth.openrouter?.key) {
      process.env.AGENTPOLICE_API_KEY = auth.openrouter.key
      process.env.AGENTPOLICE_BASE_URL = "https://openrouter.ai/api/v1"
      process.env.AGENTPOLICE_MODEL =
        modelArg ?? process.env.AGENTPOLICE_MODEL ?? "anthropic/claude-sonnet-4.5"
      return "live"
    }
  } catch {}
  return "none"
}

// scripted LLM: exercises the turn machine without network
// rule: turn 1 -> elaborate (feeding the first scripted response),
//       turn >=2 -> the fixture's first expected verdict
const makeMockLLM = (fixtures: Fixture[]) => {
  const byCommand = new Map(fixtures.map((f) => [f.command, f]))
  return async (messages: { role: string; content: string }[]) => {
    const user = messages[messages.length - 1].content
    const turn = Number(user.match(/^Turn: (\d)/m)?.[1] ?? 1)
    const command = (user.match(/Command to judge:\n([\s\S]*)/)?.[1] ?? "")
      .split(/\n\n(?:Prior justifications|Evidence ledger)/)[0]
      .trim()
    const f = byCommand.get(command)
    if (!f) return JSON.stringify({ verdict: "human-review", reason: "mock: unknown command" })
    if (turn === 1) return JSON.stringify({ verdict: "elaborate", question: "Why is this needed?" })
    return JSON.stringify({ verdict: f.expected[0], reason: "mock verdict" })
  }
}

// --- main -------------------------------------------------------------------

const files = (await Array.fromAsync(new Bun.Glob("fixtures-*.json").scan({ cwd: "test" })))
  .sort()
  .map((f) => `test/${f}`)
const fixtures: Fixture[] = []
for (const f of files) fixtures.push(...((await Bun.file(f).json()) as Fixture[]))
const selected0 = filter ? fixtures.filter((f) => f.id.includes(filter)) : fixtures
const selected = idsArg
  ? selected0.filter((f) => idsArg.split(",").includes(f.id))
  : selected0
if (selected.length === 0) {
  console.error(`no fixtures match filter "${filter ?? idsArg}"`)
  process.exit(1)
}

let mode: "live" | "mock"
if (wantsMock) mode = "mock"
else if (wantsLive) {
  if ((await ensureKey()) !== "live") {
    console.error("--live: no AGENTPOLICE_API_KEY (env or opencode auth.json fallback)")
    process.exit(1)
  }
  mode = "live"
} else mode = (await ensureKey()) === "live" ? "live" : "mock"
if (mode === "mock" && !wantsMock)
  console.error("no AGENTPOLICE_API_KEY found — running in --mock mode (wiring only, no LLM)\n")

const llm = mode === "mock" ? makeMockLLM(selected) : undefined

interface Row {
  id: string
  category: string
  personality: string
  turns: number
  verdict: Verdict
  pass: boolean
  ms?: number
  info?: string
  note?: string
}

const rows: Row[] = selected.map((f) => ({
  id: f.id, category: f.category, personality: f.personality, turns: 0, verdict: "safe" as Verdict, pass: false, note: "pending",
}))
let done = 0
let aborted = false
// low-balance keys 402 when too many requests reserve max_tokens at once —
// HARNESS_CONCURRENCY=2 trades speed for smaller credit reservations
const CONCURRENCY = Number(process.env.HARNESS_CONCURRENCY ?? 6)
async function worker() {
  for (let f = queue.shift(); f && !aborted; f = queue.shift()) {
    const row = rows[selected.indexOf(f)]
    const t0 = Date.now()
    try {
      const { result, turns } = await runFixture(f, llm!)
      const pass = f.expected.includes(result.verdict)
      Object.assign(row, {
        turns,
        verdict: result.verdict,
        pass,
        ms: Date.now() - t0,
        info: result.reason, // kept on pass too — jev probabilities enable offline threshold sweeps
        note: pass ? undefined : `expected ${f.expected.join("|")}${result.reason ? ` — ${result.reason}` : ""}`,
      })
    } catch (e) {
      row.ms = Date.now() - t0
      const msg = e instanceof Error ? e.message : String(e)
      if ((e as { creditLimit?: boolean }).creditLimit) {
        aborted = true
        queue.length = 0
        console.error(`\n*** REVIEWER CREDIT/AUTH LIMIT REACHED (${msg.slice(0, 120)}) — run aborted, notify the key owner. ***\n`)
        Object.assign(row, { turns: 0, verdict: "human-review", pass: false, note: "run aborted: reviewer auth/credit error" })
        done++
        continue
      }
      Object.assign(row, { turns: 0, verdict: "human-review", pass: false, note: `harness error: ${msg}` })
    }
    done++
    console.error(`[${done}/${selected.length}] ${row.id} ${row.verdict} ${row.pass ? "ok" : "FAIL"}`)
  }
}
const queue = [...selected]
const wallT0 = Date.now()
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

// --- report -----------------------------------------------------------------

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length))
console.log(pad("id", 10) + pad("cat", 11) + pad("personality", 11) + pad("turns", 6) + pad("verdict", 13) + "pass")
for (const r of rows) {
  console.log(
    pad(r.id, 10) +
      pad(r.category, 11) +
      pad(r.personality, 11) +
      pad(String(r.turns), 6) +
      pad(r.verdict, 13) +
      (r.pass ? "ok" : "FAIL") +
      (r.note ? `  ${r.note}` : ""),
  )
}

const passed = rows.filter((r) => r.pass).length
const byCategory: Record<string, { pass: number; total: number }> = {}
for (const r of rows) {
  byCategory[r.category] ??= { pass: 0, total: 0 }
  byCategory[r.category].total++
  if (r.pass) byCategory[r.category].pass++
}

// --- held-out split (Phase D) ------------------------------------------------
// Deterministic partition: every 4th fixture by id-hash is held-out (never
// "agent-visible" during tuning). Divergence between the two rates is a
// gaming indicator — a judge/agent pair that overfits visible fixtures shows
// a collapse on the held-out half.
const heldOut = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 0) % 4 === 0
const splitRate = (wantHeld: boolean) => {
  const subset = rows.filter((r) => heldOut(r.id) === wantHeld)
  return `${subset.filter((r) => r.pass).length}/${subset.length}`
}

console.log(`\n${passed}/${rows.length} passed  [agent-visible ${splitRate(false)} | held-out ${splitRate(true)}]`)
for (const [cat, c] of Object.entries(byCategory))
  console.log(`  ${cat}: ${c.pass}/${c.total}`)

// filtered/ids runs write a suffixed file so the full-run results are never clobbered
const suffix = filter || idsArg ? `-partial-${Date.now()}` : ""
await Bun.write(
  `test/results-${(process.env.AGENTPOLICE_MODEL ?? "mock").replaceAll(/[/:]/g, "-")}${suffix}.json`,
  JSON.stringify(rows, null, 2),
)
if (usage.calls > 0)
  console.log(`usage: ${usage.calls} calls, ${usage.prompt} prompt + ${usage.completion} completion tokens`)
const fixtureMs = rows.map((r) => r.ms).filter((x): x is number => x != null).sort((a, b) => a - b)
if (fixtureMs.length)
  console.log(
    `speed: fixture p50=${Math.round(fixtureMs[Math.floor(fixtureMs.length / 2)] / 1000)}s p95=${Math.round(fixtureMs[Math.floor((fixtureMs.length * 95) / 100)] / 1000)}s | wall ${((Date.now() - wallT0) / 60_000).toFixed(1)}min (${(fixtureMs.length / ((Date.now() - wallT0) / 60_000)).toFixed(1)} fixtures/min)`,
  )
if (passed < rows.length) process.exit(1)
