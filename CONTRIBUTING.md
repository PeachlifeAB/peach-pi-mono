# Contributing

This guide exists to save both sides time.

## Philosophy

Keep it minimal and extendable.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact
with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated slop without understanding it is not.

## Contribution Gate

Approval happens through maintainer replies on issues:

- `lgtmi`: your future issues will not be auto-closed
- `lgtm`: your future issues and PRs will not be auto-closed

`lgtmi` does not grant rights to submit PRs. Only `lgtm` grants rights to submit PRs.

## Quality Bar For Issues

If you open an issue, you must use one of the two GitHub issue templates.

If you open an issue, keep it short, concrete, and worth reading.

- Keep it concise. If it does not fit on one screen, it is too long.
- State the bug or request clearly.
- Explain why it matters.
- If you want to implement the change yourself, say so.

If the issue is real and written well, a maintainer may reopen it, reply `lgtmi`, or reply `lgtm`.

## Before Submitting a PR

Do not open a PR unless you have already been approved with `lgtm`.

Before submitting a PR:

```bash
npm run check
./test.sh
```

Both must pass.

Do not edit `CHANGELOG.md`. Changelog entries are added by maintainers.

If you are adding a new provider to `packages/`, see `AGENTS.md` for required tests.

## FAQ

### Why not let AI triage everything?

AI can help with most things but is not trusted to make final maintainer decisions.
Polished AI-generated issues can still be wrong, misleading, or expensive to investigate
and may become rejected without a detailed review.

### Is this hostile to contributors?

No. It is a guardrail against burnout and tracker spam. Short, concrete, reproducible issues are welcome.

## Where can I learn about plans?

Trusted maintainers will get accessed to currently private planning artifacts.
