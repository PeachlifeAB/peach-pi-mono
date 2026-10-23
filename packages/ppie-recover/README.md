# ppie-recover

Automatic recovery for context overflow, memory guards, and provider errors.

`@peachlife/ppie-recover` provides unattended auto-healing for the [Pi coding
agent](https://pi.dev). It intercepts, classifies, and automatically recovers
from typical API/provider failures—preventing aborted sessions during
long-running or overnight tasks.

It classifies failures, applies the retry table (defaults plus ordered
smart overrides), and only exits when the matched row's attempt budget is
exhausted — without disrupting active session forks or reloads.

## Recovery capabilities

* **Retry table:** Pacing fields directly under `retry`, plus ordered `retry.smart_overrides` (every matching row contributes; later rows win). `max_attempts: 0` never retries, and also stops Pi's own auto-retry for that error; `"unlimited"` never gives up.

* **Memory overflow protection:** `memory_overflow_protection.compaction` and `.prune` are sibling recovery domains. Compaction is on by default: when Pi's own compaction does not resolve an overflow or provider memory error, ppie-recover compacts, up to twice. Preventive (`dynamic`) compaction and pruning are off by default: Pi already compacts at its own threshold, and pruning makes the model see less context on that retry.

* **Setting tips:** when recovery stops and a disabled setting would have let it continue, ppie-recover shows one tip after the stop reason, naming the setting and why it is off by default.

* **Warnings:** advisory-only `provider_silence_seconds` (`0` disables). The compaction warning lives at `memory_overflow_protection.compaction.forced.warn_after_seconds`.
* **Hooks:** a trusted `hooks.provider_silent` command can react to a silent provider without ppie-recover mutating recovery state.
* **Debug:** `debug: false | { path }` — sink failures are non-fatal.

## 📦 Install


```bash
# Install permanently to your agent environment
pi install npm:@peachlife/ppie-recover

# Execute in-memory without a permanent install
pi -e npm:@peachlife/ppie-recover

# Run locally from repository root
pi -e ./src/retry.ts
```

## ⚙️ Configuration

Defaults live in `config.default.json` (generated from `DEFAULT_CONFIG`). ppie-recover deep-merges its global config at `~/.pi/agent/extensions/ppie-recover/config.json` with a trusted project's `.pi/ppie-recover.json`; arrays replace wholesale. Project config is ignored outside a trusted project. Group- or world-writable files are refused with a warning.

Shipped defaults retry with a 16s ×2 curve (cap 1000s, 5 attempts). Transport failures such as `fetch failed`, `connection reset` or a `500` use that curve. The shipped smart overrides then adjust specific errors:

| Row | Matches | Behavior |
| --- | --- | --- |
| 1 | Cloud account and rate limits: codes 401, 402, 403, 429; `insufficient_quota`, `billing`, `rate limit`, … | Not retried: a human has to act |
| 2 | Configuration errors: code 404; `invalid api key`, `model not found`, `aborted by user`, … | Not retried |
| 3 | Context overflow: `too long`, `context length`, `overflow` | Compaction after 5s, up to 3 attempts |
| 4 | Provider memory pressure: `prefill_memory_exceeded`, `physical cap`, `out of memory`, … | Compaction after 30s, up to 3 attempts |
| 5 | Wedged local model: code 409, `unload is pending` | Not retried |

The 5s overflow wait gives Pi's own compaction the first chance, so the two never compact the same overflow twice. Smart overrides are applied in declaration order: all matching rows contribute, and later explicit properties win. A specific rule should therefore follow a broad rule. A configured `smart_overrides` array replaces the shipped rows, so copy them from `config.default.json` before editing.

To retry rate limits again, add a later row:

```json
{ "when": { "error_codes": [429], "words": ["rate limit"] }, "max_attempts": 2, "seconds_before_first_retry": 60 }
```

To turn off ppie-recover's compaction entirely, set `memory_overflow_protection.compaction.enabled` to `false`; Pi's own compaction still runs.

Document difficult values with underscore-prefixed metadata. Metadata accepts any JSON value, is ignored at runtime, and does not weaken validation of normal properties:

```json
{
  "retry": {
    "max_attempts": 5,
    "_comment": "Provider-specific rules are documented inline.",
    "smart_overrides": [
      {
        "when": {
          "_error_codes": "Codes can mean different things by provider.",
          "error_codes": [401, 403, 429]
        },
        "max_attempts": 1,
        "seconds_before_first_retry": 60,
        "multiplier_between_attempts": 2,
        "max_seconds_between_attempts": 300
      }
    ]
  }
}
```

Properties without the `_` prefix remain strictly declared and type-checked.
A provider-silence hook is independent of the advisory warning threshold and runs at most once per silent request stretch:

```json
{
  "hooks": {
    "provider_silent": {
      "after_seconds": 120,
      "command": "launchctl kickstart -k gui/$UID/local.llm-server",
      "timeout_seconds": 30
    }
  }
}
```

Hooks use the same trusted global/project layers as configuration; an untrusted project's hook is never read. The command runs from the user's home directory with only `PATH`, `HOME`, `PI_RECOVER_EVENT`, `PI_RECOVER_SILENT_SECONDS`, and `PI_RECOVER_MODEL` in its environment. Its stdin receives one CloudEvents 1.0 JSON envelope: `type` is `dev.peachlife.ppie-recover.provider_silent`, `source` is `urn:pi:recover`, and `data` contains `silent_seconds` and `model`. Success is silent; a non-zero exit or timeout shows one warning.
Enable ordered model fallback for a matched terminal error:

```json
{
  "model_fallback": { "enabled": true, "max_hops": 4 },
  "retry": {
    "smart_overrides": [
      {
        "when": { "words": ["model unavailable"] },
        "max_attempts": 0,
        "fallback_models": ["openai/gpt-5", "anthropic/claude-sonnet-4-5"]
      }
    ]
  }
}
```

Model references use canonical `provider/modelId` form. Fallback is disabled by default; `max_hops` is clamped to `1..10` only when enabled.

### Three budgets, three domains

Each domain owns its own errors and its own attempt counter. They do not draw from each other.

| Domain | Owns | Budget |
|---|---|---|
| `retry` | provider returned nothing — network, 5xx, stream death, rate limits. The request is resent unchanged. | `retry.max_attempts` |
| `compaction` | overflow persists and compaction attempts remain | `compaction.forced.max_attempts` |
| `prune` | overflow persists after compaction, or compaction is disabled | `memory_overflow_protection.prune.max_attempts` |

Compaction, dynamic compaction, and pruning have separate responsibilities:

| Switch | Default | Effect |
| --- | ---: | --- |
| `compaction.enabled` | `true` | Master; off lets Pi handle compaction. |
| `compaction.dynamic.enabled` | `false` | At settled, compact at ratio `0.8`. |
| `compaction.forced.enabled` | `true` | Overflow fallback; budget 2 attempts. |
| `prune.enabled` | `false` | Independent; pruning removes context. |

These paths are relative to `memory_overflow_protection`. Typical combinations:

| Intent | Master | Dynamic | Forced | Prune |
| --- | --- | --- | --- | --- |
| Master off, pruning on | off | — | — | on |
| Dynamic only | on | on (`0.8`) | off | off |
| Forced only (shipped) | on | off | on (2 attempts) | off |
| Dynamic + forced | on | on (`0.8`) | on (2 attempts) | off |

The dynamic ratio must be greater than `0` and less than `1`. Pi retains
ownership of native `reserveTokens` and `keepRecentTokens` in
`~/.pi/agent/settings.json`.

During `wait_seconds_before_first_attempt`, if Pi core or another compaction
extension starts a compaction, ppie-recover cancels its own and defers without
consuming an attempt.

With dynamic compaction enabled and forced attempts disabled, a fallback
compaction can be granted when a stop reaches the configured ratio. A newer
successful, non-error tool result re-arms one grant; the next stop must still
reach the ratio. Each completed fallback compaction advances the boundary.
Failed tool results, repeated stops without successful tool progress, and stops
below the ratio do not re-arm it. Configured forced attempts keep their own cap
and are not reset by this behavior.

Pi's extension API cannot compact and resume an active continuous tool-use
loop. If that loop crosses the ratio before `agent_settled`, ppie-recover leaves
it running; Pi-core's native overflow and compaction behavior remains the
fallback. Evaluation happens at `agent_settled`, not `agent_end`.

### Manual Commands

* `/retry` — Manually trigger an invisible retry of the last failed turn.
* `/retry:list-unclassified` — List unrecognized transient error signatures.

## Recovery Decision Flow

```txt
Provider Error
 ├── User abort / never-retry override  ➔ Pass-through
 ├── Overflow                         ➔ compaction if enabled, then prune if enabled
 ├── Smart override match               ➔ That row's pacing and retry budget
 └── Default row                        ➔ Geometric backoff from retry

Overflow, in detail:
 ├── wait_seconds_before_first_attempt   ➔ another compactor acts? defer, no attempt spent
 ├── force compaction                    ➔ until forced.max_attempts is spent
 └── prune                             ➔ until prune.max_attempts is spent; never returns to compaction
```

## Testing

```bash
npm run check          # Lint, typecheck, schema drift, tests, and coverage floor
npm run test           # Run node:test and real-interface Vitest suites
npm run test:coverage  # Run both suites through c8 and enforce the committed baseline
npm run trace:once     # Snapshot provider and extension diagnostics into .dog/trace.log
```

> **Observation Caveat:** Core compaction and detached retry loops are
> bypassed during pipeline printing. To inspect recovery in action, run in
> interactive mode or fork a live session. See [`docs/smoke-testing.md`](./docs/smoke-testing.md).

## 📄 License

MIT. See [`LICENSE`](./LICENSE).

[![npm](https://img.shields.io/npm/v/@peachlife/ppie-recover)](https://www.npmjs.com/package/@peachlife/ppie-recover)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
