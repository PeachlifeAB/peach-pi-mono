# ppie-graft

```bash
pi install npm:@peachlife/ppie-graft
```

Exposes the [graft](https://github.com/trailhq/Graft) codebase graph to Pi as a
native tool, so the model queries a prebuilt index instead of grepping and
reading whole files.

Graft ships first-class wiring for Claude Code only — five hooks plus a
statusline. Pi has no hook contract, so this package reaches the same behavior
through Pi's extension events.

| graft's Claude hook | Pi seam used here |
| --- | --- |
| `SessionStart` | `before_agent_start` once/session (orientation, staleness) |
| `UserPromptSubmit` | `before_agent_start` per turn (retrieval, scope) |
| `PostToolUse` (savings, blast radius, scope) | `tool_result` |
| statusline shim | `ctx.ui.setStatus` |

Nothing rebuilds after edits, so upstream's `Stop` hook has no counterpart here:
every graft query refreshes the graph before answering. That hook exists to
refresh the markdown cards under `graft/`, which this extension never reads.

Three of those behaviors need no prompting: a repository with no graph is
indexed in the background at session start, any file a tool names reports what
depends on it, and retrieval narrows to the sub-project being worked on.

The package also ships the `graft` skill (`skills/graft/SKILL.md`), declared in
`package.json` under `pi.skills`, so enabling the extension puts the skill in
front of the model too — Pi walks all four resource types.

The strength and novelty gates that decide whether a retrieval pack earns its
place are not reimplemented: the extension imports graft's own
`dist/claude/format.js`, so the thresholds cannot drift from upstream.
`hooks.js` is **not** imported: it reads file descriptor 0, which in a TUI is
Pi's own terminal input.

## Requirements

`graft` on `PATH`. The package has no npm dependencies; it resolves graft's
package root from the binary Pi already runs, preferring the highest version
when several are installed.

### Formatter resolution boundary

The extension inspects every `graft` executable visible on `PATH`. A dispatch
shim contributes nothing unless its resolved package root contains
`dist/claude/format.js`; later usable executables and the existing local, Node,
and npm-global fallbacks remain eligible. Among usable roots, the highest package
version wins—the same rule as graft's own shim.

The executable used by subprocesses can therefore differ from the install that
supplies `format.js`. The extension reads `graft --version` once per session and
adds `formatter <version> / binary <version>` to the footer only when both
versions are readable and differ. It reports skew rather than silently
downgrading the formatter; matching or unreadable versions leave the footer
unchanged.

## Upstream

Latest graft is the target; no version is pinned or supported in preference to
another. Where graft's own behavior is depended on, the source is cited by
`file:line` so a reader can check whether it still says that.

Last verified green against graft `05760b0` (0.17.0), the upstream `main` at the
time. That is a record of what was run, not a constraint:
`.github/workflows/graft-nightly.yml` runs this package's suite against upstream
`main` daily at 15:00 UTC — just after upstream's own working day — so a change
that breaks it surfaces the same afternoon, before release. The workflow also
separates "graft did not build" from "our tests failed", because those need
different people.

## Test

```bash
pnpm --filter @peachlife/ppie-graft test
```

Tests drive the extension through a fake `pi` object (`test/harness.ts`) that
captures `on`, `exec`, and `registerTool`. No graft process and no network.

Every case is a defect that reached a live session, because that is where this
package's bugs live. The tool schema is the model's only interface, so a
misleading parameter description is a defect like any wrong branch:

- a description beginning `"ask: …"` made a model call a tool named `graft ask`
- booleans arrive as `"true"` and `"True"`; dropping them silently returned no
  inline source
- `--full` is inert without `--source`, so `full` must imply it
- `pi.exec` inherits Pi's process cwd, so every graft call must name its own
  directory
