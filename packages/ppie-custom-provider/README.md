# ppie-custom-provider

```bash
pi install npm:@peachlife/ppie-custom-provider
```

A pi extension registering a generic OpenAI-compatible provider with dynamic model
discovery. Point it at any server speaking the OpenAI Chat Completions API: llama.cpp,
LM Studio, vLLM, Ollama's compatible endpoint, or a hosted gateway.

## Setup

```
/login ppie-custom-provider
```

Prompts for a server URL and an optional API key. Neither is validated or probed, so a
server that is not running yet is fine. The key goes to pi's credential store, never to a
config file. The URL is stored with the credential, and discovery only contacts a server
login configured, so a session that never logged in makes no network request.

## Commands

| Command | Effect |
| --- | --- |
| `/login ppie-custom-provider` | Set the server URL and API key |

No refresh command of its own. pi's `/model` picker refreshes every provider catalog
through `refreshModels`, as does login, logout, config reload, runtime key change, and
startup. No background polling.

## Configuration

Optional. Global config at `~/.pi/agent/openai-provider.json`, overridable per project at
`.pi/openai-provider.json`. Keys merge per field, project over global over defaults.
`openai-provider.example.json` lists every knob at its default value.

| Key | Meaning |
| --- | --- |
| `baseUrl` | Server URL used until `/login` overrides it. Also the login prompt's placeholder. |
| `discovery.enabled` | Fetch the catalog from the server. Off registers no models. |
| `discovery.path` | Catalog path appended to `baseUrl`. |
| `overflowPattern` | Extra context-overflow phrase to recognize. |
| `compat` | Per-field overrides on top of pi's compat detection. |
| `log.enabled` | Write provider wire traffic to `.pi/provider-payload.log`. |
| `log.maxBytes` | Rotate the log past this size. |

A malformed file warns and falls back to defaults rather than blocking startup.

### Deliberately not configurable

- `contextWindow` / `maxTokens`. The server reports them. A contradicting config value
  produces untraceable silent truncation. Correct a misreporting server through pi's
  `models.json` per-model overrides.
- API key. Belongs in the credential store via `/login`, which is mode-restricted.
  Config files are not.
- Timeouts. pi's `httpIdleTimeoutMs` governs. A deadline invented here would sever
  legitimate long-running local generations.
- Headers. pi's `models.json` owns them, with `$VAR` interpolation and `!command` support.

## Compat detection

pi derives request-shape compatibility flags from the provider id and base URL, encoding
the quirks of roughly ten hosted gateways (OpenRouter, Together, DeepSeek, z.ai, Cerebras,
xAI, Moonshot, Chutes, Cloudflare, NVIDIA). This extension ships an empty `compat` block,
leaving that detection untouched.

Detection matches on hostname. Reaching a recognized gateway through a corporate proxy or
custom domain gives pi an unfamiliar hostname and the generic profile. Requests still
work, but gateway-specific routing preferences, cache-control format, and thinking format
are lost. State the flags yourself:

```json
{
  "baseUrl": "https://ai-proxy.internal.example.com/v1",
  "compat": {
    "thinkingFormat": "openrouter",
    "maxTokensField": "max_tokens",
    "supportsStrictMode": false
  }
}
```

Each field set here wins over detection. Setting flags you do not need is worse than
setting none, because a blanket block overrides correct detection for every gateway to fix one.

## Context overflow

pi recognizes common "context length exceeded" phrasings and responds by compacting and
retrying. For a server that words it differently, `overflowPattern` adds one more
case-insensitive phrase.

```json
{ "overflowPattern": "prompt exceeds maximum context" }
```

Additive. pi's own detection keeps working. An invalid expression is reported once at load
and ignored.

## Logging

Off by default, because provider payloads contain prompt content. Enable per-run with
`pi --ppie-custom-provider-log` or persistently with `log.enabled`. Output goes to
`.pi/provider-payload.log` with credential headers and prompt-bearing fields redacted.

## Reference material

`src/examples/api-coverage.ts` and `src/delegating-provider.ts` are unregistered. They
describe a fictional gateway and exist to keep pi's wider extension API surface visible
and typechecked. That covers every `thinkingFormat` value, every `Api` type, the legacy and canonical
OAuth surfaces, and a delegating `streamSimple`. Read the notes at the top of each file
before copying them into a real provider.

Design decisions are recorded in `docs/adr/`.
