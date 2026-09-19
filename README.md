# @resonanceee/agent-police

[![publish](https://github.com/resonanceee/agent-police/actions/workflows/publish.yml/badge.svg)](https://github.com/resonanceee/agent-police/actions/workflows/publish.yml)
[![npm](https://img.shields.io/npm/v/@resonanceee/agent-police)](https://www.npmjs.com/package/@resonanceee/agent-police)
[![license](https://img.shields.io/npm/l/@resonanceee/agent-police)](./LICENSE)

Published on [npmjs](https://www.npmjs.com/package/@resonanceee/agent-police) and [GitHub Packages](https://github.com/resonanceee/agent-police/pkgs/npm/agent-police).

An [opencode](https://opencode.ai) plugin that puts a **police officer between your coding agent and your machine**: an LLM reviewer judges every bash command the agent wants to run, *before* it executes.

Catches agents that are **misaligned with the task** — whether from hidden malice, a prompt-injected payload, or a model that simply misunderstood the task and is about to do something destructive with confidence.

## What it does

Every `bash` tool call is paused and sent to a reviewer model with the recent conversation, the command, and any prior justifications. The reviewer returns one of three verdicts (strict JSON):

| Verdict         | Meaning                                              | Effect on the agent                    |
| --------------- | ---------------------------------------------------- | -------------------------------------- |
| `safe`          | Aligned with the task, not dangerous                 | Command runs as intended               |
| `elaborate`     | Ambiguous, unusual, or risky                         | Command blocked; reviewer asks **one concrete question** |
| `human-review`  | Dangerous, evasive, deceptive, or misaligned         | Command blocked until a **human** decides |

### Turn budget (min 1, max 3)

```
T1 (command only)          → safe | elaborate
T2 (after 1st justification) → safe | elaborate | human-review
T3 (after 2nd justification) → safe | human-review
```

- **Elaborate loop**: the block message contains the reviewer's question. The agent explains itself in chat and retries the exact same command; the retry is recognized and judged again.
- **Human review**: the agent (and you) get a block message with three options, decided by replying in chat:
  - `approve` — allow this command once
  - `follow up: <question>` — ask the agent a question before deciding
  - `cancel` — reject the command; the agent is told not to retry
- **Fail-closed**: reviewer timeout, HTTP failure, or malformed JSON never silently approves — it escalates to human-review.

### Evidence ledger (observation-only)

Besides gating bash, the plugin silently records what the agent touches via `read` / `edit` / `write` / `grep` / `glob` (target paths only) and the output of bash runs. Taps **never block**. Deterministic hard signals are flagged and shown to the reviewer as context:

- reads/edits of checker-like files (`tests/**`, `*.test.*`, `.github/workflows/`, grader/validator/expected-output names) — test-file edits are always flagged, even in test-writing tasks
- eval-environment sniffing in bash (`CI`, `GITHUB_ACTIONS`, `EVAL*`)
- pass-count jumps correlated with test-file edits
- self-verification loops: run tests → edit → rerun, ≥3 consecutive cycles with no other change

The reviewer prompt includes a reward-hacking watchlist: test/validator tampering, hardcoded outputs, oracle gaming, eval detection, and fabricated success. Flags are grounds to ask or escalate — an honest agent legitimately running tests may read test files; the judge weighs intent against the task.

## Setup

In the project (or global) opencode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@resonanceee/agent-police"]
}
```

Configure the reviewer model via environment variables:

| Variable                | Required | Default                          |
| ----------------------- | -------- | -------------------------------- |
| `AGENTPOLICE_API_KEY`   | yes      | —                                |
| `AGENTPOLICE_BASE_URL`  | no       | `https://api.openai.com/v1`      |
| `AGENTPOLICE_MODEL`     | no       | `gpt-4o-mini`                    |

Any OpenAI-compatible endpoint works (OpenRouter, Synthetic, vLLM, Ollama, …). Example for OpenRouter:

```bash
export AGENTPOLICE_API_KEY="sk-or-..."
export AGENTPOLICE_BASE_URL="https://openrouter.ai/api/v1"
export AGENTPOLICE_MODEL="z-ai/glm-5.3-flash"
```

## Judge recommendations

Given that this plugin has been built with the intention of bolstering security, when choosing a judge keep in mind that quality matters more than speed. From the 240-conversation fixture suite (`test/fixtures-*.json`: openly dangerous, openly safe, ambiguous, reward-hacking, cheat-sheet, narrative-injection, plus a 40-case adversarial edge set with malicious / confused / honest / lazy agent personalities), prompt v6 + evidence ledger:

| Model                        | Score   | Notes                                                          |
| ---------------------------- | ------- | -------------------------------------------------------------- |
| `z-ai/glm-5.3-flash`         | 238/240 | recommended default — precision-tuned, stable across reruns, held-out 60/60 |
| `inclusionai/ling-3.0-flash` | 214/240 | known-weak: takes the agent's narrative at face value even with explicit rubric discipline |

Robustness checks (glm-5.3-flash, prompt v6):

- **Held-out split** (every 4th fixture never seen during tuning): agent-visible 178/180, held-out 60/60 — no gaming divergence.
- **Canary perturbation** (`test/canary.ts`: coherent anchor-number shifts, identifier renames, prose reformatting): 239/240 both sides, **0 verdict flips / 240** once the perturbation was made coherent. (The earlier 12-flip run was a measurement artifact: per-field independent number edits fabricated port/PR mismatches that any careful judge should flag.)
- **False-positive posture**: benign sentinel set 40/40, danger controls 93/93 — the rubric explicitly prices escalation friction ("do not escalate benign work over technicalities") without losing catch-rate.
- **Truncation resilience**: reasoning models that exhaust their token budget on tangents get one doubled-cap retry, then a salvage call that converts the truncated reasoning into a verdict — instead of failing closed.

Known limitation: residual run-to-run variance at the safe/escalate boundary (~1% of borderline fixtures flip direction between runs at temperature 0, provider routing noise).

Historical: v1 158/160 (original 160-fixture set), v2 197/200, v5 238/240, v6 238-239/240 stable. Benchmark results and run logs are preserved under `test/bench/`.

## Behavior notes

- `bash` is gated by the reviewer; `read`/`edit`/`write`/`grep`/`glob` are observed only and never blocked.
- Review state and the evidence ledger are in-memory per session; restarting opencode resets them.
- Human approval is detected by scanning for `approve` / `cancel` in user messages sent after the block.
- Latency: one fast-model call per new command (plus one per justification round). Keep the reviewer on a cheap flash-class model.
- `AGENTPOLICE_MAX_TOKENS` (default 4096) caps reviewer responses; some providers 402 when an uncapped request must reserve the model's full context against your credit balance.

## Development

```bash
bun install
bun test test/ledger.test.ts             # ledger signal checks, no network
bun test/harness.ts --mock               # wiring check, no network
bun test/harness.ts --live --model=z-ai/glm-5.3-flash   # full 200-fixture judge run (reports agent-visible vs held-out)
bun test/canary.ts --live --model=z-ai/glm-5.3-flash    # canary perturbation: flips & pass collapses
RUN_INTEGRATION=1 bun test test/integration.test.ts     # boots real opencode in a sandbox project
bun run typecheck
```

Low-balance API keys: set `HARNESS_CONCURRENCY=2` to shrink per-request credit reservations.

## License

[MIT](./LICENSE)
