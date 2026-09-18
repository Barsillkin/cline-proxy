# cline-proxy

Локальный прокси, который превращает ваш аккаунт Cline в обычный
**OpenAI-совместимый API** (`/v1/chat/completions`, `/v1/models`), чтобы им
мог воспользоваться любой клиент, понимающий OpenAI: opencode, Zed, Continue,
собственные скрипты и т.д.

```
любой клиент ──►  http://127.0.0.1:8787/v1/chat/completions
                   │  прокси подставляет ваши Cline-креды
                   ▼
          https://api.cline.bot/api/v1/chat/completions
              Authorization: Bearer workos:<ваш токен>
```

- **Один файл**, без зависимостей, Node >= 18.
- Читает OAuth-токены, которые Cline уже хранит на диске (`providers.json`),
  обновляет их по истечении и пишет восстановленные токены обратно.
- Работает с HTTP-флоу Cline: стрим (SSE) и без стрима, tools/function-calling,
  автоматическое обновление токена перед истечением.

> ⚠️ **Дисклеймер.** Это неофициальный инструмент. Вы фактически используете
> свою подписку Cline через сторонний клиент, что может нарушать условия
> обслуживания Cline и приводить к лимитам или блокировке. Всё работает на вашей
> машине, используются только ваши данные, и ничего не уходит к Cline, кроме
> запросов к `api.cline.bot`. Решение использовать — ваше.

## Запуск

```powershell
node proxy.mjs
```

Прокси запустится на `http://127.0.0.1:8787/v1` по умолчанию. Порт меняется
переменной окружения `PROXY_PORT`.

На Windows удобнее `start-proxy-gui.cmd` (или ярлык «cline-proxy GUI» на
рабочем столе): он запускает прокси и открывает веб-панель
`http://127.0.0.1:8787/gui` — статус и срок жизни токена, список моделей с
доступностью, живой лог и ping-тест любой модели одним кликом.

Быстрая проверка:

```powershell
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

`/health` показывает отпечаток токена (первые 12 символов SHA-256), время
истечения и `accountId` — сам токен нигде не пишется.

## Эндпоинты

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/health` | статус прокси, отпечаток/срок токена, accountId |
| GET | `/gui` | веб-панель (данные: `/gui/api`) |
| GET | `/v1/models` | список моделей из фида Cline с разметкой тиров и доступности |
| POST | `/v1/chat/completions` | чат: стрим (SSE) и без стрима, tools/function-calling |

## Модели

`/v1/models` отдаёт записи вида:

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

- Тип модели (`tier`) берётся из живого фида Cline
  (`https://api.cline.bot/api/v1/ai/cline/recommended-models`):
  типы `recommended / free / clinePass / clineCloud`. **Ничего не захардкожено.**
- `id` — алиас без слешей, чтобы клиенты, разбивающие модель по слешу, работали.
  Если одно имя встречается в нескольких тирах, к алиасу добавляется суффикс
  `@origin`, например `glm-5.3-flash@z-ai`, `deepseek-v4.1-flash@cline-free`,
  `deepseek-v4.1-flash@cline-pass`. Полные идентификаторы Cline
  (`z-ai/glm-5.3-flash` и т.п.) тоже принимаются как `model` в запросе.
- Прокси **запоминает** реальные отказы шлюза и помечает модель в списке:
  `"available": false, "reason": "requires cline-pass subscription"` или
  `"reason": "free limit reached, resets in 21h 59m"` (хранится в памяти
  процесса, сбрасывается при перезапуске).
- Установите `PROXY_EXPOSE_FULL_IDS=1`, чтобы `/v1/models` дополнительно
  отдавал полные идентификаторы Cline.
## Прозрачная ошибка шлюза

Прокси **не глотает и не подменяет** ответы шлюза. Сообщение проходит целиком
(в нём обычно указано время сброса), а прокси дополнительно вытаскивает
структурированные поля:

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

Распознаются типичные ответы (по маркерам из `sdk/packages/llms/src/providers/errors.ts`
самого Cline):
- `INFERENCE_CAP_ERROR` — дневной free-лимит конкретной модели,
- `ENTITLEMENT_ERROR` — подписка ClinePass не активна,
- лимит ClinePass («The limit resets in 7d…»),
- `MODEL_NOT_FOUND`,
- `empty response content` — слишком маленький `max_tokens` у reasoning-модели.

HTTP-статус и заголовки (`Retry-After` и прочие) передаются без изменений.

## Конфигурация клиентов

### opencode

См. [`examples/opencode.json`](examples/opencode.json):

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

### Любой другой OpenAI-совместимый клиент

- Base URL: `http://127.0.0.1:8787/v1`
- API-ключ: любой (или свой `PROXY_API_KEY` — см. ниже)
- Модель: любой `id` из `/v1/models`

## Конфигурация самого прокси

Всё задаётся переменными окружения. По умолчанию работает «из коробки», если
прокси запускается на машине с установленным Cline.

| Переменная | По умолчанию | Что означает |
|---|---|---|
| `PROXY_PORT` | `8787` | порт сервера |
| `PROXY_HOST` | `127.0.0.1` | адрес (оставляйте локальным!) |
| `PROXY_API_KEY` | не установлено | если задан, клиент обязан отправить `Authorization: Bearer <ключ>` |
| `CLINE_PROVIDERS_PATH` | `%USERPROFILE%\.cline\data\settings\providers.json` | файл с OAuth-данными |
| `CLINE_DATA_DIR` | `%USERPROFILE%\.cline\data` | альтернатива для пути выше |
| `CLINE_API_BASE` | `https://api.cline.bot/api/v1` | база шлюза (`apiBase`) |
| `CLINE_CLIENT_TYPE` | `cline-desktop` | заголовок `X-CLIENT-TYPE`, который прокси шлёт шлюзу |
| `CLINE_REFRESH_BUFFER_MS` | `300000` (5 мин) | обновлять access-токен за столько до истечения |
| `PROXY_EXPOSE_FULL_IDS` | `0` | `1` — дополнительно отдавать полные Cline-идентификаторы в `/v1/models` |
| `PROXY_REQUEST_TIMEOUT_MS` | `0` (нет) | таймаут к шлюзу (0 = без ограничения, нужно для стрима) |

## Важные нюансы

- **Reasoning-модели.** Free-модели (`cline-free/*`, `z-ai/glm-5.3-flash` и др.)
  сначала генерируют reasoning-токены (`delta.reasoning`), потом видимый текст
  (`delta.content`). Если задать очень маленький `max_tokens` (например 16),
  весь бюджет уйдёт на reasoning, `content` останется пустым, шлюз вернёт
  `empty response content`, а прокси добавит в текст ошибки подсказку.
  Рекомендация: `max_tokens >= 512` либо не указывать его вовсе.
  Для моделей эпохи OpenAI reasoning (o1/o3/o4, gpt-5) прокси сам переименовывает
  `max_tokens` → `max_completion_tokens`, как это делает Cline.
- **Free-лимит — на каждую модель отдельно.** Ошибка формулируется
  «Daily free limit reached **on model** …», поэтому когда одна free-модель
  исчерпала дневной бюджет, можно переключиться на другую
  (например с `cline-free/deepseek-v4.1-flash` на `z-ai/glm-5.3-flash`).
- **Single-use refresh-токены.** Cline меняет refresh-токен при каждом обновлении.
  Прокси перед refresh перечитывает `providers.json` и пишет новые токены обратно,
  поэтому совместим с приложением/CLI. Но если обновление произойдёт одновременно
  и в прокси, и в Cline — возможен logout (лечится повторным входом).
- **Ошибки шлюза видны.** Ничто не ретраит в тишину: вы всегда видите реальную
  причину, включая время сброса лимита.

## Безопасность

- Слушает только `127.0.0.1`; удалённые подключения отклоняются.
- Cline-токен нигде не пишется в лог (только усечённый отпечаток) и не принимается
  от клиентов — клиенты аутентифицируются любым ключом или `PROXY_API_KEY`.
- Если `PROXY_API_KEY` **не** задан, любой локальный процесс может тратить ваши
  кредиты. Для постоянного использования задавайте ключ.
- В репозиторий не попадают логи, тестовые `body*.json` и `providers.json`.

## Устранение проблем

| Симптом | Причина / исправление |
|---|---|
| `ENTITLEMENT_ERROR` / «not subscribed to required model plan» | модель требует ClinePass — выберите модель с `free: true` |
| `INFERENCE_CAP_ERROR` + `limit_reset_in` | дневной free-лимит этой модели — подождать сброс или переключиться на другую free-модель |
| `empty response content` | `max_tokens` слишком мал для reasoning-модели — поднимите (>= 512) или уберите |
| `Token refresh failed (401)` | refresh-токен изменили в другом месте — войдите в Cline заново |
| Прокси запустился, но клиент пишет connection refused | на порту висит другой сервис, или локальный фаервол блокирует localhost |

## Структура репозитория

```
cline-proxy\
├── proxy.mjs               # сам прокси (единственный файл логики)
├── README.md               # основной README (русский)
├── README.en.md            # английский вариант README
├── LICENSE                 # MIT
├── .gitignore              # логи, тестовые body*.json, providers.json, node_modules
└── examples/
    └── opencode.json       # пример конфигурации opencode
```

## Английская версия

См. [`README.en.md`](README.en.md) — сжатый, но полный английский вариант той же
информации.

## Лицензия

[MIT](LICENSE)

