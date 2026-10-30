# ppie-trail

```bash
pi install npm:@peachlife/ppie-trail
```

Exposes the [trail](https://github.com/trailhq/Trail-Code) codebase graph to Pi as a
native tool, so the model queries a prebuilt index instead of grepping and
reading whole files.

Trail wires several coding agents. This package integrates its graph with Pi
through Pi's extension events.

| trail's Claude hook | Pi seam used here |
| --- | --- |
| `SessionStart` | `before_agent_start` once/session (orientation, staleness) |
| `UserPromptSubmit` | `before_agent_start` per turn (retrieval, scope) |
| `PostToolUse` (savings, blast radius, scope) | `tool_result` |
| statusline shim | `ctx.ui.setStatus` |

The adapter delegates session, prompt, pre-command, pre-edit, post-tool,
turn-end and shutdown hooks to the installed Trail package. Hooks run in child
processes with piped JSON input; they never read Pi's terminal. Upstream owns
learning retrieval, skill guards, overlap detection and turn-end graph sync.

Three of those behaviors need no prompting: a repository with no graph is
indexed in the background at session start, any file a tool names reports what
depends on it, and retrieval narrows to the sub-project being worked on.

The package also ships the `trail` skill (`skills/trail/SKILL.md`), declared in
`package.json` under `pi.skills`, so enabling the extension puts the skill in
front of the model too — Pi walks all four resource types.

The strength and novelty gates that decide whether a retrieval pack earns its
place are not reimplemented: the extension imports trail's own
`dist/claude/format.js`, so the thresholds cannot drift from upstream.
`hooks.js` runs only in the subprocess adapter. Responses are validated against
JSON Schema 2020-12 before their context, notices or blocking decisions reach Pi.

## Requirements

`trail` on `PATH`, installed from `@trailhq/trail-code`. Ajv validates the hook protocol. The extension resolves Trail's
package root from the binary Pi already runs, preferring the highest version
when several are installed.

Trail's cache resolver selects `.trail/cache/` in initialized repositories and
retains `graft/` for repositories not yet migrated. Cache contents are generated
runtime artifacts, not package source.

### Formatter resolution boundary

The extension inspects every `trail` executable visible on `PATH`. A dispatch
shim contributes nothing unless its resolved package root contains
`dist/claude/format.js`; later usable executables and the existing local, Node,
and npm-global fallbacks remain eligible. Among usable roots, the highest package
version wins—the same rule as trail's own shim.

The executable used by subprocesses can therefore differ from the install that
supplies `format.js`. The extension reads `trail --version` once per session and
adds `formatter <version> / binary <version>` to the footer only when both
versions are readable and differ. It reports skew rather than silently
downgrading the formatter; matching or unreadable versions leave the footer
unchanged.

## Parity limits

Graph context, repo/personal learnings, pre-edit guidance, command guards,
post-edit overlaps, turn-end sync and status rendering delegate to upstream.
A pre-edit learning blocks that tool call with the guidance so the model reads it
before retrying; Pi cannot inject context directly from a tool-call handler.

The extension normalizes Pi's active branch and reuses installed Trail's event
folding in an isolated worker. Interactive-input receipts carry a text digest;
unverified historical, RPC and extension messages are not classified as human input.
Snapshots are rebuilt without accumulating replayed calls. The footer reports tool
calls and failures; this does not enable transcript-dependent skill promotion.

The private folding interface is enabled only for versions listed in
`src/pi-trace.schema.json`. Other versions or invalid reports retain native hooks.
Identity remains `pi`, tier `D`, with learning disabled. No Claude transcript or
trust upgrade is fabricated; automatic learned-skill promotion remains unsupported.

## Upstream

Graph and hook integration target latest Trail without a package version pin;
the optional private folding interface has a tested-version allowlist. Where trail's own behavior is depended on, the source is cited by
`file:line` so a reader can check whether it still says that.

The compatibility workflow, `.github/workflows/trail-nightly.yml`, tests this
package against upstream `main` every Tuesday at 00:00 UTC. It distinguishes an
upstream install failure from extension test failures.

## Test

```bash
pnpm --filter @peachlife/ppie-trail test
```

Tests drive the extension through a fake `pi` object (`test/harness.ts`) that
captures `on`, `exec`, and `registerTool`. The formatter integration tests require an installed `@trailhq/trail-code`.
Most tests capture commands. The real hook test executes the installed upstream
code against a temporary repository and isolated home, with telemetry disabled.

Every case is a defect that reached a live session, because that is where this
package's bugs live. The tool schema is the model's only interface, so a
misleading parameter description is a defect like any wrong branch:

- a description beginning `"ask: …"` made a model call a tool named `trail ask`
- booleans arrive as `"true"` and `"True"`; dropping them silently returned no
  inline source
- `--full` is inert without `--source`, so `full` must imply it
- `pi.exec` inherits Pi's process cwd, so every trail call must name its own
  directory
