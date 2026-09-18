# AGENTS.md — контекст для AI-ассистентов (Cline/Claude/Codex)

Этот файл читается автоматически в новой сессии. Держите его актуальным.

## Что это

`proxy.mjs` — локальный OpenAI-совместимый прокси, который подставляет OAuth-креды
установленного Cline (desktop/CLI) в запросы любых OpenAI-клиентов и пересылает их
в шлюз `https://api.cline.bot/api/v1`. Один файл, Node >= 18, без зависимостей.

```
клиент ──► http://127.0.0.1:8787/v1/chat/completions
             │  Authorization: Bearer workos:<token> из providers.json
             ▼
           https://api.cline.bot/api/v1/chat/completions
```

## Файлы

- `proxy.mjs` — вся логика. Читайте перед изменениями.
- `README.md` (русский, основной) / `README.en.md` — документация.
- `examples/opencode.json` — пример подключения opencode.
- `start-proxy.cmd` — запуск на Windows.

## Запуск и проверка

```powershell
node proxy.mjs
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

Токены лежат в `%USERPROFILE%\.cline\data\settings\providers.json`
(структура: `providers.<id>.settings.auth.{accessToken,refreshToken,expiresAt,accountId}`).
Access-токен уходит в заголовке **с префиксом**: `Authorization: Bearer workos:<jwt>`.
Прокси сам обновляет токен (`POST /auth/refresh`) и пишет новые обратно в providers.json.
Refresh-токены **single-use** — если обновят одновременно Cline и прокси, возможен logout.

## Проверенный тест-сценарий (обязателен после правок)

```powershell
# 1. синтаксис
node --check proxy.mjs
# 2. перезапуск прокси и health
# 3. non-stream
# body.json = {"model":"gpt-6-astra","messages":[{"role":"user","content":"Reply with the single word: pong"}],"max_tokens":512}
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions -H "Content-Type: application/json" -d @body.json
# 4. стрим: то же + "stream":true — ожидаем SSE-чанки и data: [DONE]
# 5. tools: добавить tools + tool_choice:auto — ожидаем finish_reason "tool_calls"
```

Тестовые body-файлы (`body*.json`) в gitignore — не коммитить.

## Ключевые знания о шлюзе Cline (проверено вживую)

- Шлюз — OpenAI-совместимый `POST {base}/chat/completions`, SSE для стрима.
- Non-stream ответы приходят в конверте `{success:true,data:{choices...}}` или
  ошибкой `{success:false,error}` / напрямую `{error:{code,message}}` — прокси
  разворачивает в обычный `{choices:[...]}`.
- Модели: фид `GET https://api.cline.bot/api/v1/ai/cline/recommended-models`
  (тиры `recommended/free/clinePass/clineCloud`). Прокси строит алиасы без `/`;
  коллизии получают суффикс `@origin` (`glm-5.3-flash@z-ai`).
- Free-лимит **per model**: `INFERENCE_CAP_ERROR` + текст «Try again in 22h 4m» →
  прокси извлекает `limit_reset_in`. Переключение на другую free-модель даёт новый бюджет.
- `ENTITLEMENT_ERROR` = нужен ClinePass (`cline-pass/*` модели). 403 при этом —
  НЕ auth-ошибка, refresh не делать.
- `region_blocked`: «not available in your region» (бывает у free-моделей).
- Reasoning-модели (`cline-free/*`, `z-ai/glm-5.3-flash`) сначала отдают
  `delta.reasoning`. Мелкий `max_tokens` (16) съедается reasoning → шлюз вернёт
  `empty response content`. Использовать `max_tokens >= 512` или не указывать.
  Для o1/o3/o4/gpt-5 прокси переименовывает `max_tokens` → `max_completion_tokens`.
- Ошибки классифицируются в `classifyGatewayMessage` по маркерам из
  `sdk/packages/llms/src/providers/errors.ts` репозитория cline/cline
  (sparse-клон с `--depth 1 --filter=blob:none` — самый быстрый способ смотреть код).

## Ограничения / осторожность

- Использование подписки через сторонний клиент может нарушать ToS Cline.
- Прокси слушает только 127.0.0.1. Без `PROXY_API_KEY` любой локальный процесс
  может тратить кредиты.
- В репозиторий не коммитить: логи, `body*.json`, `providers.json`, секреты.

## Идеи на будущее

- GitHub Actions: `node --check` + smoke `/health` на push.
- `examples/zed.json`, `examples/continue.json`.
- `PROXY_MIN_MAX_TOKENS` (пол для reasoning-моделей).
- `GET /v1/models?tier=free` фильтр.
- Автозапуск через Task Scheduler при логине.
