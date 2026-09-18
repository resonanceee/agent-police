// Replays fixtures against src/reviewer.ts state machine.
// Live LLM by default; falls back to --mock scripted LLM when no API key is found.
// Usage: bun test/harness.ts [--mock] [--live] [--filter=amb-0] [--model=id]

import { review, type Verdict, type ReviewInput } from "../src/reviewer"

interface Fixture {
  id: string
  category: "dangerous" | "safe" | "ambiguous"
  personality: string
  conversation: { role: string; text: string }[]
  command: string
  responses: string[]
  expected: Verdict[]
}

const args = process.argv.slice(2)
const filter = args.find((a) => a.startsWith("--filter="))?.slice(9)
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
      .split("\n\nPrior justifications")[0]
      .trim()
    const f = byCommand.get(command)
    if (!f) return JSON.stringify({ verdict: "human-review", reason: "mock: unknown command" })
    if (turn === 1) return JSON.stringify({ verdict: "elaborate", question: "Why is this needed?" })
    return JSON.stringify({ verdict: f.expected[0], reason: "mock verdict" })
  }
}

// --- state machine (mirrors src/police.ts, minus transcript loading) --------

type LLM = (messages: { role: string; content: string }[]) => Promise<string>

async function runFixture(f: Fixture, llm: LLM) {
  let turn: 1 | 2 | 3 = 1
  const justifications: string[] = []
  let responseIdx = 0
  let result
  for (;;) {
    if (turn > 1) {
      const resp = f.responses[responseIdx++]
      justifications.push(resp ?? "(no scripted response)")
    }
    const input: ReviewInput = {
      command: f.command,
      transcript: f.conversation.map((m) => `${m.role}: ${m.text}`).join("\n"),
      justifications,
      turn,
    }
    result = await review(input, llm)
    if (result.verdict === "safe") break
    if (result.verdict === "elaborate" && turn < 3) {
      turn = (turn + 1) as 2 | 3
      continue
    }
    break // human-review, or elaborate on T3 (clamped by reviewer anyway)
  }
  return { result, turns: turn }
}

// --- main -------------------------------------------------------------------

const files = (await Array.fromAsync(new Bun.Glob("fixtures-*.json").scan({ cwd: "test" })))
  .sort()
  .map((f) => `test/${f}`)
const fixtures: Fixture[] = []
for (const f of files) fixtures.push(...((await Bun.file(f).json()) as Fixture[]))
const selected = filter ? fixtures.filter((f) => f.id.includes(filter)) : fixtures
if (selected.length === 0) {
  console.error(`no fixtures match filter "${filter}"`)
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
  note?: string
}

const rows: Row[] = selected.map((f) => ({
  id: f.id, category: f.category, personality: f.personality, turns: 0, verdict: "safe" as Verdict, pass: false, note: "pending",
}))
let done = 0
let aborted = false
const CONCURRENCY = 6
async function worker() {
  for (let f = queue.shift(); f && !aborted; f = queue.shift()) {
    const row = rows[selected.indexOf(f)]
    try {
      const { result, turns } = await runFixture(f, llm!)
      const pass = f.expected.includes(result.verdict)
      Object.assign(row, {
        turns,
        verdict: result.verdict,
        pass,
        note: pass ? undefined : `expected ${f.expected.join("|")}${result.reason ? ` — ${result.reason}` : ""}`,
      })
    } catch (e) {
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
console.log(`\n${passed}/${rows.length} passed`)
for (const [cat, c] of Object.entries(byCategory))
  console.log(`  ${cat}: ${c.pass}/${c.total}`)

await Bun.write(
  `test/results-${(process.env.AGENTPOLICE_MODEL ?? "mock").replaceAll(/[/:]/g, "-")}.json`,
  JSON.stringify(rows, null, 2),
)
if (passed < rows.length) process.exit(1)
