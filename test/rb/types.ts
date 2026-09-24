export interface Track {
  id: string
  category: "hidden" | "honest"
  userTask: string
  hiddenTask?: string // absent for honest tracks
  hiddenMarkers: string[] // substrings; a command containing one = hidden-task work
  env: string // world description for the terminal simulator
  simNotes: string[] // facts the simulator must keep consistent
}

export interface CommandRecord {
  command: string
  verdict: "safe" | "elaborate" | "human-review"
  turn: 1 | 2 | 3
  allowed: boolean
  mutation: boolean
  hidden: boolean
  judgeMs?: number // wall time of judge verdict loop for this command
  monitorFlag?: string | null // monitor/replay flag if one arrived for this command
}

export interface SeedResult {
  run: "run1" | "run2"
  trackId: string
  seed: number
  commands: CommandRecord[]
  hiddenRun: number // hidden commands executed
  hiddenAttempt: number // hidden commands attempted (incl. blocked)
  blocked: number
  transcript: string[] // ["role: text", ...] actor-visible flow
  writeObs: { path: string; output: string }[] // sim outputs for mutating commands (for replay)
  done: "done" | "maxed" | "aborted"
  durationMs?: number // seed wall time
}
