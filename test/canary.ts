// Canary perturbation runner (eval-time, outside the plugin).
// Perturbs each fixture's task parameters (identifier renames, constant
// changes, formatting) deterministically, re-runs the judge on original and
// canary, and flags flips. Rationale: real capability transfers across
// surface changes; memorized fixtures and overfit judges do not.
// Usage: bun test/canary.ts [--mock] [--model=id] [--filter=id]
import { review, type Verdict } from "../src/reviewer"
import { runFixture, type Fixture, type LLM } from "./runner"
import { formatEvents, type LedgerEvent } from "../src/ledger"

const args = process.argv.slice(2)
const filter = args.find((a) => a.startsWith("--filter="))?.slice(9)
const wantsMock = args.includes("--mock")
const wantsLive = args.includes("--live")
const modelArg = args.find((a) => a.startsWith("--model="))?.slice(8)

// deterministic PRNG (mulberry32) so canaries are reproducible
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const RENAMES: Record<string, string> = {
  applyDiscount: "computePriceAdjustment",
  isPalindrome: "checkMirrorSymmetry",
  solve: "resolveInput",
  auth: "authentication",
  checkout: "purchaseFlow",
  cache: "memoizationLayer",
  snapshot: "frozenRender",
  grader: "assessor",
  evaluator: "scoringEngine",
  tokenizer: "lexer",
}
const NUM_DELTA = [1, -1, 2, -2]

const NUM_RE = /(^|[^\/\w.-])(\d{1,4})(?=$|[^\/\w.])/g

// Numbers must move COHERENTLY: per-field independent edits used to fabricate
// inconsistencies (conversation port 3335 vs command port 3334) that read as real
// red flags — the judge was right to escalate those variants. Scheme: pick ONE
// anchor number per fixture (most frequent qualifying token across all fields)
// and shift it everywhere with plain \b replacement so URL/path-adjacent
// contexts stay in sync. Qualifying: 3-4 digits (ports, PR numbers, counts),
// not a unix mode (600-799 is semantics-bearing: 600→602 turns "owner-only"
// into "world-writable").
function buildNumberAnchor(texts: string[], rand: () => number): [string, string] | null {
  const freq = new Map<string, number>()
  for (const t of texts) for (const m of t.matchAll(/\b(\d{3,4})\b/g)) {
    const n = m[1]
    if (/^[67]\d\d$/.test(n)) continue
    freq.set(n, (freq.get(n) ?? 0) + 1)
  }
  const candidates = [...freq.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])
  if (candidates.length === 0) return null
  const anchor = candidates[0][0]
  const delta = NUM_DELTA[Math.floor(rand() * NUM_DELTA.length)]
  const next = Math.max(0, Number(anchor) + delta)
  return next === Number(anchor) ? null : [anchor, String(next)]
}

function perturbText(text: string, anchor: [string, string] | null, rand: () => number, prose = true): string {
  let out = text
  // identifier renames (word-boundary, case-sensitive)
  for (const [from, to] of Object.entries(RENAMES)) {
    if (rand() < 0.5) out = out.replaceAll(from, to)
  }
  if (anchor) out = out.replaceAll(new RegExp(`\\b${anchor[0]}\\b`, "g"), anchor[1])
  if (!prose) return out // formatting churn is prose-only; commands must stay runnable
  out = out.replaceAll("  ", " ")
  if (!/[.!?]$/.test(out) && rand() < 0.5) out += "."
  return out
}

export function canarize(f: Fixture): Fixture {
  const seed = [...f.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)
  const rand = rng(Math.abs(seed))
  const texts = [
    f.command,
    ...f.conversation.map((m) => m.text),
    ...f.responses,
    ...(f.evidence ?? []).map((e) => e.detail),
  ]
  const anchor = buildNumberAnchor(texts, rand)
  const pert = (s: string) => perturbText(s, anchor, rand)
  const pertCode = (s: string) => perturbText(s, anchor, rand, false)
  const pertEvent = (e: LedgerEvent): LedgerEvent => ({ ...e, detail: pertCode(e.detail) })
  return {
    ...f,
    conversation: f.conversation.map((m) => ({ role: m.role, text: pert(m.text) })),
    command: pertCode(f.command),
    responses: f.responses.map(pert),
    evidence: f.evidence?.map(pertEvent),
  }
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
      process.env.AGENTPOLICE_MODEL = modelArg ?? "anthropic/claude-sonnet-4.5"
      return "live"
    }
  } catch {}
  return "none"
}

async function main() {
  const files = (await Array.fromAsync(new Bun.Glob("fixtures-*.json").scan({ cwd: "test" })))
    .sort()
    .map((f) => `test/${f}`)
  const fixtures: Fixture[] = []
  for (const f of files) fixtures.push(...((await Bun.file(f).json()) as Fixture[]))
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

  const llm: LLM =
    mode === "mock"
      ? async () => JSON.stringify({ verdict: "human-review", reason: "mock" }) // canary compares flips, mock only exercises plumbing
      : undefined!

  interface Row {
    id: string
    original: Verdict
    canary: Verdict
    originalPass: boolean
    canaryPass: boolean
  }

  const rows: Row[] = []
  let done = 0
  const CONCURRENCY = Number(process.env.HARNESS_CONCURRENCY ?? 4)
  const queue = [...selected]
  let aborted = false
  async function worker() {
    for (let f = queue.shift(); f && !aborted; f = queue.shift()) {
      try {
        const c = canarize(f)
        const [o, k] = await Promise.all([runFixture(f, llm), runFixture(c, llm)])
        rows.push({
          id: f.id,
          original: o.result.verdict,
          canary: k.result.verdict,
          originalPass: f.expected.includes(o.result.verdict),
          canaryPass: f.expected.includes(k.result.verdict),
        })
      } catch (e) {
        if ((e as { creditLimit?: boolean }).creditLimit) {
          aborted = true
          console.error(`\n*** REVIEWER CREDIT/AUTH LIMIT — canary run aborted. ***\n`)
          break
        }
        rows.push({ id: f.id, original: "human-review", canary: "human-review", originalPass: false, canaryPass: false })
      }
      done++
      if (done % 10 === 0) console.error(`[${done}/${selected.length}]`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  const flips = rows.filter((r) => r.original !== r.canary)
  const passDrops = rows.filter((r) => r.originalPass && !r.canaryPass)
  const oRate = `${rows.filter((r) => r.originalPass).length}/${rows.length}`
  const cRate = `${rows.filter((r) => r.canaryPass).length}/${rows.length}`
  console.log(`canary perturbation (${mode}) — original ${oRate} vs canary ${cRate}`)
  console.log(`verdict flips: ${flips.length}/${rows.length}`)
  for (const f of flips) console.log(`  ${f.id}: ${f.original} -> ${f.canary}`)
  console.log(`pass collapses (passed original, failed canary): ${passDrops.length}`)
  for (const f of passDrops) console.log(`  ${f.id}`)
  console.log(`\ninterpretation: cheats that only pass on the original wording show up as pass collapses; an overfit judge shows a high flip rate.`)

  await Bun.write(
    `test/results-canary-${(process.env.AGENTPOLICE_MODEL ?? "mock").replaceAll(/[/:]/g, "-")}.json`,
    JSON.stringify({ rows, flips: flips.map((f) => f.id) }, null, 2),
  )

}

if (import.meta.main) await main()
