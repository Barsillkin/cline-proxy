> **Note:** the main documentation is in Russian — [`README.md`](README.md).
> This file is the English variant.
﻿# cline-proxy

A tiny local proxy that exposes your **Cline account** as a plain
**OpenAI-compatible API** (`/v1/chat/completions`, `/v1/models`), so any client
that speaks OpenAI вЂ” opencode, Zed, Continue, your own scripts вЂ” can use the
models available to your Cline login.

```
any OpenAI client в”Ђв”Ђв–є  http://127.0.0.1:8787/v1/chat/completions
                          в”‚  proxy injects your Cline credentials
                          в–ј
                 https://api.cline.bot/api/v1/chat/completions
                     Authorization: Bearer workos:<your token>
```

- **Zero dependencies**, single file, Node >= 18.
- Reads the OAuth tokens Cline already stores on disk (`providers.json`),
  refreshes them automatically, and writes rotated tokens back.
- Handles Cline gateway quirks: `{success,data}` response envelope, reasoning
  models, `max_tokens` в†’ `max_completion_tokens`, per-model free-tier limits.

> [!WARNING]
> This tool drives your own Cline subscription through third-party clients.
> That may violate the Cline Terms of Service and can lead to rate limits or
> account suspension. Everything runs locally on your machine, uses your own
> credentials, and sends nothing anywhere except `api.cline.bot` вЂ” but the
> decision to use it is yours.

## Requirements

- Node.js >= 18 (no `npm install` needed)
- A Cline account logged in via the Cline desktop app or CLI
  (the proxy reads `%USERPROFILE%\.cline\data\settings\providers.json`)

## Quick start

```powershell
node proxy.mjs            # listens on http://127.0.0.1:8787/v1
```

```powershell
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

`/health` shows the token fingerprint (first 12 hex chars of its SHA-256), the
expiry time and the account id вЂ” never the token itself.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | status, token fingerprint/expiry, account id |
| GET | `/v1/models` | model list from the Cline feed, with tier metadata |
| POST | `/v1/chat/completions` | chat, streaming (SSE) and non-streaming, tools |

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

- `tier` comes from the live Cline recommended-models feed
  (`recommended` / `free` / `clinePass` / `clineCloud`) вЂ” nothing is hardcoded.
- Ids are slash-free aliases so clients that split on `/` keep working. When the
  same name exists in several tiers, the alias is suffixed with the origin:
  `deepseek-v4.1-flash@cline-free` vs `deepseek-v4.1-flash@cline-pass`.
  Full gateway ids also work as request `model` values.
- The proxy remembers real gateway rejections per model and annotates the list:
  `"available": false, "reason": "requires cline-pass subscription"` or
  `"reason": "free limit reached, resets in 21h 59m"` (in-memory, per process).
- Set `PROXY_EXPOSE_FULL_IDS=1` to also list the full gateway ids.

## Error passthrough

Gateway errors are never swallowed. The message (which embeds the reset time)
is passed through verbatim, plus structured fields are extracted:

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

Recognized markers (from the Cline SDK's own `providers/errors.ts`):
`INFERENCE_CAP_ERROR` (free-tier limit), `ENTITLEMENT_ERROR` (no ClinePass
subscription), ClinePass period limits ("The limit resets in 7dвЂ¦"),
`model not found`. HTTP status and headers (`Retry-After`, вЂ¦) are forwarded
unchanged.

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
- Model: any id from `/v1/models`

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PROXY_PORT` | `8787` | listen port |
| `PROXY_HOST` | `127.0.0.1` | bind address (keep it local!) |
| `PROXY_API_KEY` | unset | if set, clients must send it as `Authorization: Bearer <key>` |
| `CLINE_PROVIDERS_PATH` | `%USERPROFILE%\.cline\data\settings\providers.json` | credentials file |
| `CLINE_DATA_DIR` | `%USERPROFILE%\.cline\data` | alternative to the path above |
| `CLINE_API_BASE` | `https://api.cline.bot/api/v1` | gateway base URL (e.g. staging) |
| `CLINE_CLIENT_TYPE` | `cline-desktop` | `X-CLIENT-TYPE` sent to the gateway |
| `CLINE_REFRESH_BUFFER_MS` | `300000` | refresh the access token this long before expiry |
| `PROXY_EXPOSE_FULL_IDS` | `0` | `1` = also list full gateway ids in `/v1/models` |
| `PROXY_REQUEST_TIMEOUT_MS` | `0` | upstream timeout (0 = none, needed for streams) |

## Good to know

- **Reasoning models.** Free models (`cline-free/*`, `z-ai/glm-5.3-flash`, вЂ¦)
  emit reasoning tokens first (`delta.reasoning`), then the visible answer
  (`delta.content`). A tiny `max_tokens` (e.g. 16) gets consumed by reasoning
  and the gateway returns `empty response content` вЂ” use `max_tokens >= 512` or
  omit it. The proxy annotates that error with a hint.
  For OpenAI reasoning-era models (o1/o3/o4, gpt-5) it renames
  `max_tokens` в†’ `max_completion_tokens`, exactly like Cline does.
- **Free-tier limits are per model.** The error reads "Daily free limit reached
  **on model** вЂ¦", so when one free model is capped you can switch to another.
- **Single-use refresh tokens.** Cline rotates the refresh token on every
  refresh. The proxy re-reads `providers.json` right before refreshing and
  writes new tokens back, so it coexists with the app/CLI вЂ” but a simultaneous
  refresh from both sides can still invalidate the session (re-login fixes it).
- **Gateway errors are visible.** Nothing is retried into silence; you always
  see the real reason, including the reset time.

## Security

- Listens on `127.0.0.1` only; remote connections are refused.
- The Cline token never appears in logs (only a SHA-256 fingerprint) and is not
  accepted from clients вЂ” clients authenticate with any key, or with
  `PROXY_API_KEY` if you set one.
- Without `PROXY_API_KEY`, **any local process** can spend your credits. Set a
  key for daily use.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ENTITLEMENT_ERROR` / "not subscribed to required model plan" | the model needs a ClinePass subscription вЂ” pick a `free: true` model |
| `INFERENCE_CAP_ERROR` with `limit_reset_in` | daily free-tier limit for that model; wait for the reset or switch to another free model |
| `empty response content` | `max_tokens` too small for a reasoning model вЂ” raise it (>= 512) or drop it |
| `Token refresh failed (401)` | the refresh token was rotated elsewhere вЂ” re-login in the Cline app |
| Proxy starts but clients get connection refused | another instance is running on the port, or a firewall blocks localhost |

## Disclaimer

This is an unofficial community tool, not affiliated with or endorsed by Cline.
Use at your own risk and in accordance with the Cline Terms of Service.

## License

[MIT](LICENSE)

