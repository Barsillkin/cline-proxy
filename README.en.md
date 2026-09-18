> **Note:** the main documentation is in Russian: [`README.md`](README.md).
> This file is the English variant.

# cline-proxy

A local proxy that turns your Cline account into a regular **OpenAI-compatible
API** (`/v1/chat/completions`, `/v1/models`), so any client that speaks OpenAI
can use it: opencode, Zed, Continue, your own scripts, etc.

```
any client ──►  http://127.0.0.1:8787/v1/chat/completions
                   │  proxy injects your Cline credentials
                   ▼
          https://api.cline.bot/api/v1/chat/completions
              Authorization: Bearer workos:<your token>
```

- **Single file**, zero dependencies, Node >= 18.
- Reads the OAuth tokens Cline already stores on disk (`providers.json`),
  refreshes them before expiry, and writes rotated tokens back.
- Works with Cline's HTTP flow: streaming (SSE) and non-streaming,
  tools/function-calling, automatic token refresh.

> ⚠️ **Disclaimer.** This is an unofficial tool. You are effectively using your
> Cline subscription through a third-party client, which may violate Cline's
> Terms of Service and lead to rate limits or suspension. Everything runs
> locally on your machine, uses only your own data, and nothing is sent to Cline
> except requests to `api.cline.bot`. The decision to use it is yours.

## Quick start

```powershell
node proxy.mjs
```

The proxy listens on `http://127.0.0.1:8787/v1` by default. Change the port with
the `PROXY_PORT` environment variable.

```powershell
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

`/health` shows the token fingerprint (first 12 hex chars of its SHA-256), the
expiry time and the `accountId` — the token itself is never logged.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | proxy status, token fingerprint/expiry, account id |
| GET | `/v1/models` | model list from the Cline feed, with tier metadata and availability |
| POST | `/v1/chat/completions` | chat: streaming (SSE) and non-streaming, tools/function-calling |

## Models

`/v1/models` returns entries like:

```json
{
  "id": "deepseek-v4.1-flash@cline-free",
  "object": "model",
  "owned_by": "cline",
  "tier": "free",
  "free": true,
  "requires_cline_pass": false
}
```

- `tier` comes from Cline's live feed
  (`https://api.cline.bot/api/v1/ai/cline/recommended-models`):
  `recommended / free / clinePass / clineCloud`. **Nothing is hardcoded.**
- `id` is a slash-free alias so clients that split on `/` keep working. When the
  same name exists in several tiers, the alias gets an `@origin` suffix, e.g.
  `glm-5.3-flash@z-ai`, `deepseek-v4.1-flash@cline-free`,
  `deepseek-v4.1-flash@cline-pass`. Full Cline ids such as
  `z-ai/glm-5.3-flash` also work as the request `model`.
- The proxy **remembers** real gateway rejections per model and annotates the
  list: `"available": false, "reason": "requires cline-pass subscription"` or
  `"reason": "free limit reached, resets in 21h 59m"` (in-memory, per process).
- Set `PROXY_EXPOSE_FULL_IDS=1` to also list the full Cline gateway ids.

## Error passthrough

The proxy never swallows or rewrites gateway errors. The original message (which
usually contains the reset time) is passed through verbatim, and structured
fields are extracted on top:

```json
{
  "error": {
    "message": "Error 429: Daily free limit reached on model deepseek/deepseek-v4.1-flash. Try again in 22h 4m",
    "type": "cline_gateway_error",
    "code": "INFERENCE_CAP_ERROR",
    "limit_reset_in": "22h 4m",
    "limit_reached": true
  }
}
```

Recognized markers (the same ones Cline uses in
`sdk/packages/llms/src/providers/errors.ts`):
- `INFERENCE_CAP_ERROR` — daily free-tier limit for a specific model,
- `ENTITLEMENT_ERROR` — no active ClinePass subscription,
- ClinePass period limit ("The limit resets in 7d..."),
- `MODEL_NOT_FOUND`,
- `region_blocked` — "not available in your region",
- `empty response content` — `max_tokens` too small for a reasoning model.

HTTP status and headers (`Retry-After`, ...) are forwarded unchanged.

## Client configuration

### opencode

See [`examples/opencode.json`](examples/opencode.json):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "cline": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cline (local proxy)",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "local-proxy"
      },
      "models": {
        "gpt-6-astra": { "name": "GPT-6 Astra (Cline)" },
        "glm-5.3-flash@z-ai": { "name": "GLM 5.3 Flash (free)" }
      }
    }
  },
  "model": "cline/gpt-6-astra"
}
```

### Any other OpenAI-compatible client

- Base URL: `http://127.0.0.1:8787/v1`
- API key: anything (or your `PROXY_API_KEY`, see below)
- Model: any `id` from `/v1/models`

## Configuration (environment variables)

Works out of the box on a machine where Cline is installed.

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_PORT` | `8787` | listen port |
| `PROXY_HOST` | `127.0.0.1` | bind address (keep it local!) |
| `PROXY_API_KEY` | unset | if set, clients must send `Authorization: Bearer <key>` |
| `CLINE_PROVIDERS_PATH` | `%USERPROFILE%\.cline\data\settings\providers.json` | credentials file |
| `CLINE_DATA_DIR` | `%USERPROFILE%\.cline\data` | alternative to the path above |
| `CLINE_API_BASE` | `https://api.cline.bot/api/v1` | gateway base URL (`apiBase`) |
| `CLINE_CLIENT_TYPE` | `cline-desktop` | `X-CLIENT-TYPE` header sent to the gateway |
| `CLINE_REFRESH_BUFFER_MS` | `300000` | refresh the access token this long before expiry |
| `PROXY_EXPOSE_FULL_IDS` | `0` | `1` — also list full Cline gateway ids |
| `PROXY_REQUEST_TIMEOUT_MS` | `0` | upstream timeout (0 = none, needed for streams) |

## Good to know

- **Reasoning models.** Free models (`cline-free/*`, `z-ai/glm-5.3-flash`, ...)
  emit reasoning tokens first (`delta.reasoning`) and the visible answer after
  (`delta.content`). A tiny `max_tokens` (e.g. 16) is consumed by reasoning, the
  content stays empty and the gateway returns `empty response content`; the proxy
  annotates that error with a hint. Use `max_tokens >= 512` or omit it.
  For OpenAI reasoning-era models (o1/o3/o4, gpt-5) the proxy renames
  `max_tokens` to `max_completion_tokens`, exactly like Cline.
- **Free-tier limits are per model.** The error reads "Daily free limit reached
  **on model** ...", so when one free model is capped you can switch to another
  (for example from `cline-free/deepseek-v4.1-flash` to `z-ai/glm-5.3-flash`).
- **Single-use refresh tokens.** Cline rotates the refresh token on every
  refresh. The proxy re-reads `providers.json` right before refreshing and writes
  the new tokens back, so it coexists with the app/CLI. If both refresh at the
  same moment, the session can still be invalidated — re-login fixes it.
- **Gateway errors are visible.** Nothing is retried into silence: you always see
  the real reason, including the reset time.

## Security

- Listens on `127.0.0.1` only; remote connections are refused.
- The Cline token is never logged (only a short fingerprint) and is not accepted
  from clients — clients authenticate with any key, or with `PROXY_API_KEY`.
- Without `PROXY_API_KEY`, **any local process** can spend your credits. Set a key
  for daily use.
- Logs, test `body*.json` files and `providers.json` are never committed.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ENTITLEMENT_ERROR` / "not subscribed to required model plan" | the model needs ClinePass — pick a `free: true` model |
| `INFERENCE_CAP_ERROR` with `limit_reset_in` | daily free-tier limit for that model — wait for the reset or switch to another free model |
| `empty response content` | `max_tokens` too small for a reasoning model — raise it (>= 512) or drop it |
| `Token refresh failed (401)` | the refresh token was rotated elsewhere — sign in to Cline again |
| Proxy starts but clients get connection refused | another service is on the port, or a local firewall blocks localhost |

## Repository structure

```
cline-proxy\
├── proxy.mjs               # the proxy itself (single logic file)
├── README.md               # main README (Russian)
├── README.en.md            # English variant of the README
├── LICENSE                 # MIT
├── .gitignore              # logs, test body*.json, providers.json, node_modules
└── examples/
    └── opencode.json       # example opencode configuration
```

## License

[MIT](LICENSE)

