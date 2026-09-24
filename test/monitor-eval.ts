// Monitor FP/recall eval (Phase E, eval-time, outside the plugin). Runs the
// Phase E monitor standalone against monitor-fixtures.json: "clean" cases
// must produce no flag (false positives), "flag" cases should produce one
// (recall). Usage:
//   bun test/monitor-eval.ts [--model=inclusionai/ling-3.0-flash] [--mock]
import { runMonitor, monitorUsage, type MonitorObservation } from "../src/monitor"

const args = process.argv.slice(2)
const wantsMock = args.includes("--mock")
const wantsLive = args.includes("--live")
const modelArg = args.find((a) => a.startsWith("--model="))?.slice(8)

interface MonitorFixture {
  id: string
  sensor: "reasoning" | "write"
  expected: "flag" | "clean"
  transcript: string
  evidence?: string
  reasoning?: string
  writePath?: string
  writeOutput?: string
}

async function ensureKey() {
  if (modelArg) process.env.AGENTPOLICE_MODEL = modelArg
  if (process.env.AGENTPOLICE_API_KEY) return "live"
  try {
    const auth = await Bun.file(`${process.env.HOME}/.local/share/opencode/auth.json`).json()
    if (auth.synthetic?.key) {
      process.env.AGENTPOLICE_API_KEY = auth.synthetic.key
      process.env.AGENTPOLICE_BASE_URL = "https://api.synthetic.new/openai/v1"
      process.env.AGENTPOLICE_MODEL = modelArg ?? "hf:zai-org/GLM-5.3-Flash"
      return "live"
    }
    if (auth.openrouter?.key) {
      process.env.AGENTPOLICE_API_KEY = auth.openrouter.key
      process.env.AGENTPOLICE_BASE_URL = "https://openrouter.ai/api/v1"
      process.env.AGENTPOLICE_MODEL = modelArg ?? "inclusionai/ling-3.0-flash"
      return "live"
    }
  } catch {}
  return "none"
}

async function main() {
  const fixtures: MonitorFixture[] = await Bun.file("test/monitor-fixtures.json").json()
  const filter = args.find((a) => a.startsWith("--filter="))?.slice(9)
  const selected = filter ? fixtures.filter((f) => f.id.includes(filter)) : fixtures

  let mode: "live" | "mock"
  if (wantsMock) mode = "mock"
  else if (wantsLive) {
    if ((await ensureKey()) !== "live") {
      console.error("--live: no AGENTPOLICE_API_KEY (env or opencode auth.json fallback)")
      process.exit(1)
    }
    mode = "live"
  } else mode = (await ensureKey()) === "live" ? "live" : "mock"

  // the gate normally keys the monitor to the judge model; the eval forces it on
  process.env.AGENTPOLICE_MONITOR = "1"
  if (!/ling-3\.0/i.test(process.env.AGENTPOLICE_MODEL ?? "")) {
    console.error(`note: monitor is designed for ling-3.0-flash; judging with ${process.env.AGENTPOLICE_MODEL}`)
  }

  const llm =
    mode === "mock"
      ? async () => JSON.stringify({ flag: null }) // mock only exercises plumbing
      : undefined!

  interface Row {
    id: string
    sensor: string
    expected: string
    flagged: boolean
    flag?: string
  }

  const rows: Row[] = []
  let done = 0
  for (const f of selected) {
    const obs: MonitorObservation = {
      transcript: f.transcript,
      evidence: f.evidence,
      reasoning: f.sensor === "reasoning" ? f.reasoning : undefined,
      writePath: f.sensor === "write" ? f.writePath : undefined,
      writeOutput: f.sensor === "write" ? f.writeOutput : undefined,
    }
    let flag: string | null = null
    try {
      flag = await runMonitor(`eval-${f.id}`, obs, llm)
    } catch (e) {
      if ((e as { creditLimit?: boolean }).creditLimit) {
        console.error(`\n*** MONITOR CREDIT/AUTH LIMIT — eval aborted. ***\n`)
        process.exit(1)
      }
    }
    rows.push({ id: f.id, sensor: f.sensor, expected: f.expected, flagged: flag !== null, flag: flag ?? undefined })
    done++
    if (done % 5 === 0) console.error(`[${done}/${selected.length}]`)
  }

  const clean = rows.filter((r) => r.expected === "clean")
  const flagCases = rows.filter((r) => r.expected === "flag")
  const fps = clean.filter((r) => r.flagged)
  const tps = flagCases.filter((r) => r.flagged)
  console.log(`monitor eval (${mode}, ${process.env.AGENTPOLICE_MODEL}) — ${rows.length} fixtures`)
  console.log(`false positives (clean flagged): ${fps.length}/${clean.length}`)
  for (const f of fps) console.log(`  FP ${f.id}: ${f.flag}`)
  console.log(`recall (flag cases caught): ${tps.length}/${flagCases.length}`)
  for (const f of flagCases.filter((r) => !r.flagged)) console.log(`  MISS ${f.id}`)
  console.log(`monitor tokens: ${monitorUsage.calls} calls, ${monitorUsage.prompt} prompt, ${monitorUsage.completion} completion`)

  await Bun.write(
    `test/results-monitor-${(process.env.AGENTPOLICE_MODEL ?? "mock").replaceAll(/[/:]/g, "-")}.json`,
    JSON.stringify({ rows, falsePositives: fps.map((f) => f.id), misses: flagCases.filter((r) => !r.flagged).map((f) => f.id) }, null, 2),
  )
}

if (import.meta.main) await main()
