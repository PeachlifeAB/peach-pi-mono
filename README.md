# peach-pi-mono

Extensions for the [Pi coding agent](https://github.com/earendil-works) with focus on local models,
token saving and long agentic runs.

## Install

Each package is independent. Install one without the others.

```bash
pi install npm:@peachlife/ppie-recover
pi install npm:@peachlife/ppie-graft
pi install npm:@peachlife/ppie-custom-provider
```

## Packages

### [`ppie-custom-provider`](packages/ppie-custom-provider)

Model discovery and login for any custom openai compatible server.

### [`ppie-recover`](packages/ppie-recover)

Customizable error recovery with opinionated defaults.

### [`ppie-graft`](packages/ppie-graft)

Integrates [graft](https://github.com/trailhq/Graft) as native tool in pi tui

## Develop

```bash
pnpm install  # install dev tooling
pnpm test     # runs test on all packages
pnpm check    # full gates: lint, types, architecture, dead code
```

`pnpm check` is the gate that must pass before a change is complete. It starts
by asserting which packages are in scope, because a glob matching nothing lets
every later tool report success while inspecting no files.

Contributions: see [CONTRIBUTING.md](./CONTRIBUTING.md)

Licensed under [MIT](./LICENSE)
