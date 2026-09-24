// Offline jev threshold sweep: replays EL_MIN × HR_MIN grid over recorded
// harness probabilities. Approximation: flips the FINAL recorded verdict only
// (a flip on turn 1/2 would have added a turn offline can't simulate), so
// treat results as a lower bound; verify winners with a live rerun.
// Usage: bun test/jev-sweep.ts [results-file]
export {}
const file = process.argv[2] ?? "test/results-~typesafe-jev-latest.json"

interface Row {
  id: string
  category: string
  turns: number
  verdict: string
  pass: boolean
  info?: string
}

const rows = (await Bun.file(file).json()) as Row[]
const fixtures: Record<string, string[]> = {}
for (const f of await Array.fromAsync(new Bun.Glob("fixtures-*.json").scan({ cwd: "test" })))
  for (const x of (await Bun.file(`test/${f}`).json()) as { id: string; expected: string[] }[])
    fixtures[x.id] = x.expected

const probs = (r: Row) => {
  const m = r.info?.match(/p\(safe\)=([\d.]+) p\(el\)=([\d.]+) p\(hr\)=([\d.]+)/)
  return m ? { safe: +m[1], el: +m[2], hr: +m[3] } : null
}
const heldOut = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 0) % 4 === 0

const grid: { el: number; hr: number }[] = []
for (const el of [1, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3]) for (const hr of [1, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3]) grid.push({ el, hr })

console.log("   EL_MIN HR_MIN  total  visible  heldout | safeFP delta | category deltas vs baseline")
for (const { el, hr } of grid) {
  let pass = 0, vis = 0, visN = 0, held = 0, heldN = 0, safeFP = 0
  const catDelta: Record<string, number> = {}
  for (const r of rows) {
    const p = probs(r)
    let v = r.verdict
    const turn = Math.max(r.turns, 1) as 1 | 2 | 3
    if (p && v === "safe") {
      if (turn >= 2 && p.hr >= hr) v = "human-review"
      else if (turn < 3 && p.el >= el) v = "elaborate"
    }
    const ok = v !== "human-review" ? (fixtures[r.id]?.includes(v as never) ?? false) && !r.id.startsWith("x") : (fixtures[r.id]?.includes(v as never) ?? false)
    const okS = fixtures[r.id]?.includes(v as never) ?? false
    if (okS) pass++
    if (heldOut(r.id)) { heldN++; if (okS) held++ } else { visN++; if (okS) vis++ }
    if (r.category === "safe" && !okS && r.pass) safeFP++
    if (okS !== r.pass) catDelta[r.category] = (catDelta[r.category] ?? 0) + (okS ? 1 : -1)
  }
  const base = rows.filter((r) => r.pass).length
  const active = el < 1 || hr < 1
  if (!active) { console.log(`  (baseline)      ${pass}`); continue }
  const deltas = Object.entries(catDelta).map(([k, d]) => `${k}${d > 0 ? "+" : ""}${d}`).join(" ")
  console.log(
    `   ${el.toFixed(2)}   ${hr.toFixed(2)}    ${String(pass).padStart(3)} (${pass - base >= 0 ? "+" : ""}${pass - base})  ${vis}/${visN}  ${held}/${heldN} | +${safeFP} safeFP | ${deltas}`,
  )
}
