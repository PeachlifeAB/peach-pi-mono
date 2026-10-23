#!/usr/bin/env bash
set -euo pipefail

# Generic forked real-settings smoke runner.
#
# This script contains ZERO live target values: no session id, no project
# directory, no model, no prompt, no skill, no extension, no fork-mode, no
# timeout. Every launch fact comes from exactly ONE local, ignored config
# file that lives in the OWNING PROJECT WORKING DIRECTORY. The directory the
# config lives in IS the cwd pi runs from; there is intentionally no
# projectDir field, so no path can disagree with the session being forked.
#
#   smoke-real-settings-compaction.sh --config <path-to-local-config>
#
# The config is gitignored (see .gitignore) and never read by any test.
# Behavioral tests use a fake `pi` on PATH and assert this script's child
# argv + cwd without launching a real session (see test/smoke-launcher.test.ts).
#
# The smoke runs in RPC mode. After sending the one configured prompt it
# keeps RPC stdin open and runs until a semantic result:
#   - successful recovery (a post-recovery assistant completion), or
#   - an explicit non-retryable external failure (reported inconclusive for
#     recovery, not a pass), or
#   - operator cancellation, or
#   - a proven recovery failure (a repeated identical overflow with no
#     payload reduction).
# There is NO invented timeout, no sleep-based stdin close, no grace period.
# An operator may interrupt a manual run; that interruption is not evidence
# that recovery passed or failed.
#
# Ownership is NEVER inferred from Pi's session-store layout. The runner runs
# from the config directory and relies on Pi's actual fork resolution; if
# that fails, the smoke fails. No path encoding is parsed, scanned, printed,
# or guessed.
#
# Exit codes: 0 = pass, 1 = fail or a prerequisite was missing.
# Prerequisites: a real local model server reachable via OMLX_API_KEY /
# OMLX_BASE_URL, and a config whose owning project + fork session exist on
# this machine. Not run by `npm test` / CI.

usage() {
  cat >&2 <<'EOF'
usage: smoke-real-settings-compaction.sh --config <path-to-local-config>

Options:
  --config <path>   Required. Local, ignored config in the owning project root.
                    This is the ONLY input; no target overrides exist.
  -h, --help        Print this help and exit.

The config is the sole source of all launch facts (fork session, prompt,
mode, disable flags, and the ordered load list of skills/extensions). The
config directory is the cwd pi runs from and the root for relative skill
paths. Ownership is never inferred from Pi's storage layout.
EOF
}

config_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || { echo "--config requires a path argument" >&2; exit 1; }
      config_path="$2"; shift 2 ;;
    # Independent target overrides are rejected on purpose: they would permit
    # an invalid cross-project composition (a session forked from one project
    # driven by another project's skills/extensions/prompt). Only --config is
    # accepted.
    --session-id|--project-dir|--skill|--extension|--model|--prompt|--mode|--fork)
      echo "rejected: '$1' is an independent target override — only --config is accepted" >&2
      exit 1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

[[ -n "$config_path" ]] || { usage; exit 1; }
# Resolve the config to an absolute path WITHOUT tilde expansion of its
# configured string values (none happen here — the path itself comes from
# the operator's shell, which already expanded any ~). The config directory
# is the project working directory.
config_path="$(cd "$(dirname "$config_path")" && pwd)/$(basename "$config_path")"
[[ -f "$config_path" ]] || { echo "config not found: $config_path" >&2; exit 1; }

project_root="$(dirname "$config_path")"
[[ -d "$project_root" ]] || { echo "project working directory (config dir) not found: $project_root" >&2; exit 1; }

# Validate the single atomic config using scripts/smoke-config-validate.js.
# The script reads schemas/smoke-config.schema.json directly and is the
# single source of truth for the version=1 / mode="rpc" / UUID / load-item
# rules. test/smoke-launcher.test.ts imports the same script. Both the
# structural schema validation AND the JSON parsing live in JS, not bash,
# so script-level NPM-style evolutions cannot drift past the schema.
#
# Stdout is a newline-delimited record: line 1 = forkSessionId,
# line 2 = prompt, line 3 = disableGlobalSkills, line 4 =
# disableGlobalExtensions, line 5 = model (or empty), line 6..N+1 = load
# entries as "kind<TAB>value".
# Bash cannot store NUL in variables, but JSON string values never contain
# literal newlines (JSON.stringify escapes them), so newline-delimiting is
# safe here.
#
# Validation is structural only (schema-level). Behavioral assertions on
# the resulting argv live in test/smoke-launcher.test.ts against a fake pi.
parse_config() {
  # pi runs from the TARGET repo's cwd, which has no ppie-recover node_modules,
  # so `--import tsx` (a bare specifier resolved from cwd) would fail there.
  # Resolve tsx's loader to an absolute path from THIS script's directory
  # instead. The validator's own `zod` import resolves from the script file's
  # location via NodeNext, so only the loader needs an absolute path.
  local script_dir
  script_dir="$(dirname "${BASH_SOURCE[0]:-$0}")"
  local tsx_loader
  tsx_loader="$(node -e "process.stdout.write(require.resolve('tsx', { paths: [process.argv[1]] }))" "${script_dir}")"
  node --import "${tsx_loader}" "${script_dir}/smoke-config-validate.ts" "$config_path" || exit 1
}

parsed="$(parse_config)"
# Read the newline-delimited records into bash variables. Lines 1-4 are the
# scalars; lines 5..N are load entries (one "kind<TAB>value" per line).
fork="$(printf '%s\n' "$parsed" | sed -n '1p')"
prompt="$(printf '%s\n' "$parsed" | sed -n '2p')"
no_skills="$(printf '%s\n' "$parsed" | sed -n '3p')"
no_extensions="$(printf '%s\n' "$parsed" | sed -n '4p')"
model="$(printf '%s\n' "$parsed" | sed -n '5p')"
load_block="$(printf '%s\n' "$parsed" | sed -n '6,$p')"

# Build pi's argv as a real bash array. Configured values flow in verbatim;
# no eval, no string concatenation. Order is: global-disable flags first
# (matching the spec's invocation), then the ordered load list, then --fork,
# then --mode rpc. The ordered load list is preserved exactly as configured.
pi_args=()
[[ "$no_skills" == "true" ]] && pi_args+=(--no-skills)
[[ "$no_extensions" == "true" ]] && pi_args+=(--no-extensions)

if [[ -n "$load_block" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    kind="${line%%$'\t'*}"
    value="${line#*$'\t'}"
    if [[ "$kind" == "extension" ]]; then
      pi_args+=(--extension "$value")
    else
      pi_args+=(--skill "$value")
    fi
  done <<< "$load_block"
fi

[[ -n "$model" ]] && pi_args+=(--model "$model")
pi_args+=(--fork "$fork" --mode rpc)

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
persist_dir="$repo_root/log/smoke"
mkdir -p "$persist_dir"
run_id="$(date +%Y%m%dT%H%M%S)"
stdout_file="$(mktemp -t "ppie-recover-smoke-$run_id.stdout.XXXXXX.log")"
stderr_file="$(mktemp -t "ppie-recover-smoke-$run_id.stderr.XXXXXX.log")"

[[ -n "${OMLX_API_KEY:-}" ]] || { echo "OMLX_API_KEY not set in environment" >&2; exit 1; }
if ! curl -fsS -m 3 -o /dev/null \
  -H "Authorization: Bearer ${OMLX_API_KEY}" \
  "${OMLX_BASE_URL:-http://localhost:8008}/v1/models"; then
  echo "model server not reachable at ${OMLX_BASE_URL:-http://localhost:8008}" >&2; exit 1
fi

# Run manifest written BEFORE launching, self-describing without re-reading
# the private config into shared logs. Configured local paths and the prompt
# are redacted; only structural facts and a content hash are recorded.
manifest_file="$persist_dir/$run_id.manifest.json"
{
  printf '{"launchedAt":"%s","projectRoot":"<redacted>","forkSessionId":"%s","mode":"rpc","model":"%s","disableGlobalSkills":%s,"disableGlobalExtensions":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$fork" "${model:-<inherited>}" "$no_skills" "$no_extensions"
  printf 'loadCount=%s\n' "$(printf '%s\n' "$load_block" | grep -c . || true)"
  printf 'profileHash=%s\n' "$(shasum -a 256 "$config_path" | awk '{print $1}')"
} > "$manifest_file"

echo "Mode:           rpc (stays open until a semantic result)" >&2
echo "Fork session:   $fork" >&2
echo "Project cwd:    $project_root (config directory)" >&2
echo "Prompt:         (redacted; see local config)" >&2
if [[ -n "$model" ]]; then echo "Model:          $model" >&2; else echo "Model:          (inherited)" >&2; fi
echo "argv:" >&2
for a in "${pi_args[@]}"; do echo "    $a" >&2; done
echo "stdout log:     $stdout_file" >&2
echo "stderr log:     $stderr_file" >&2
echo "manifest:       $manifest_file" >&2
echo "---" >&2
echo "ppie-recover must appear as loaded in the forked run. If it does not, the" >&2
echo "smoke is invalid, not a pass. Verify via pi's own loaded-extension info" >&2
echo "or the extension_ui_request stream in stdout." >&2
echo "---" >&2

# Send the single configured prompt, then KEEP STDIN OPEN. There is no sleep,
# no timeout, no fixed stdin close. The run ends when pi ends: a semantic
# result (recovery completion / non-retryable failure / proven recovery
# failure) or operator interruption (Ctrl-C / kill). stdin stays open by
# feeding pi the prompt and then blocking on the launcher's own inherited
# stdin (the operator's terminal in a manual run). When stdin is closed
# (e.g. </dev/null) the pipe EOFs and pi's RPC loop ends on its own terms.
# This is a manual, interactive smoke; it is not designed to run unattended.
prompt_json="$(node --input-type=module -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$prompt")"

set +e
(
  cd -- "$project_root"
  { printf '{"type":"prompt","message":%s}\n' "$prompt_json"; cat; } | \
    pi "${pi_args[@]}" >"$stdout_file" 2>"$stderr_file"
)
pi_status=$?
set -e

cp "$stdout_file" "$persist_dir/$run_id.stdout.log" 2>/dev/null || true
cp "$stderr_file" "$persist_dir/$run_id.stderr.log" 2>/dev/null || true
echo "Persisted logs: $persist_dir/$run_id.{stdout,stderr,manifest}.{log,json}" >&2

echo "---" >&2
echo "RPC stream event-type histogram (stdout):" >&2
grep -oE '"type":"[a-z_]+"' "$stdout_file" 2>/dev/null | sort | uniq -c >&2 || echo "(none)" >&2

retry_crashed=$({ grep -c 'Extension error (.*src/retry\.ts)' "$stderr_file" "$stdout_file" 2>/dev/null || true; } | awk -F: '{s+=$2} END{print s+0}')
if [[ "$retry_crashed" -gt 0 ]]; then
  echo "FAIL: retry.ts threw an uncaught error (see 'Extension error' above)." >&2; exit 1
fi

# The pass/fail decision for a real forked smoke is semantic and operator-
# reviewed from the redacted event timeline above. This script does not
# pattern-match a single status string into a pass: a real pass requires the
# full evidence chain (fork used the configured cwd/skills/extensions; source
# session forked not mutated; no double compaction; retry only after the
# compaction outcome; reduced payload on prune fallback; meaningful
# completion). See docs/smoke-testing.md for the expected event ordering.
echo "---" >&2
echo "Run ended (pi_status=$pi_status). Review the event timeline above against" >&2
echo "the expected ordering: overflow -> session_before_compact -> (compaction in" >&2
echo "progress) -> session_compact -> one recovery retry. A repeated overflow" >&2
echo "with an unchanged/growing payload is a failure, not 'recovery attempted'." >&2
