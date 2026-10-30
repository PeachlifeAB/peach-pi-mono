# Testing

Run `pnpm check` for static checks and `pnpm test` for all package suites.

Run `pnpm coverage` to generate each package's LCOV artifact. `pnpm crap` evaluates
those artifacts against a CRAP score of 30; missing coverage is a failure.

`pnpm mutation:dry` proves Stryker's Vitest integration without mutating code.
`pnpm mutation` mutates `ppie-trail` source. It is manual until its baseline score is
reviewed; do not add it to pre-push or normal CI.

`pnpm check` and `pnpm test` run before every push. CI mirrors them. Generated
`coverage/` directories and Stryker's temporary directory are ignored.
