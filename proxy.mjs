#!/usr/bin/env node
/**
 * Local OpenAI-compatible proxy for the Cline gateway.
 *
 * Reads the Cline OAuth credentials that the Cline app/CLI keeps in
 * providers.json, refreshes them when needed, and forwards
 * /v1/chat/completions to https://api.cline.bot/api/v1/chat/completions
 * with the same auth + client headers the desktop app sends.
 *
 * Zero dependencies. Node >= 18 (global fetch + web streams).
 */
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function defaultProvidersPath() {
	if (process.env.CLINE_PROVIDERS_PATH) return process.env.CLINE_PROVIDERS_PATH;
	const dataDir =
		process.env.CLINE_DATA_DIR ||
		join(process.env.USERPROFILE || process.env.HOME || homedir(), ".cline", "data");
	return join(dataDir, "settings", "providers.json");
}

const CONFIG = {
	host: process.env.PROXY_HOST || "127.0.0.1",
	port: Number(process.env.PROXY_PORT || 8787),
	apiBase: (process.env.CLINE_API_BASE || "https://api.cline.bot/api/v1").replace(/\/+$/, ""),
	providersPath: defaultProvidersPath(),
	clientType: process.env.CLINE_CLIENT_TYPE || "cline-desktop",
	clientVersion: process.env.CLINE_CLIENT_VERSION || "proxy",
	platform: process.env.CLINE_PLATFORM || "Cline Desktop",
	platformVersion: process.env.CLINE_PLATFORM_VERSION || "proxy",
	coreVersion: process.env.CLINE_CORE_VERSION || "proxy",
	refreshBufferMs: Number(process.env.CLINE_REFRESH_BUFFER_MS || 5 * 60_000),
	exposeFullIds: process.env.PROXY_EXPOSE_FULL_IDS === "1",
	/** Optional: require clients to send this as "Authorization: Bearer <key>". */
	apiKey: process.env.PROXY_API_KEY || "",
	requestTimeoutMs: Number(process.env.PROXY_REQUEST_TIMEOUT_MS || 0), // 0 = no timeout (streams)
};

const WORKOS_PREFIX = "workos:";

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// Credentials (providers.json)
// ---------------------------------------------------------------------------

function readProvidersFile() {
	if (!existsSync(CONFIG.providersPath)) {
		throw new Error(`providers.json not found: ${CONFIG.providersPath}`);
	}
	return JSON.parse(readFileSync(CONFIG.providersPath, "utf8"));
}

function findClineEntry(providers) {
	const bucket = providers?.providers;
	if (!bucket || typeof bucket !== "object") return undefined;
	// "cline" and "cline-pass" share the same stored credentials.
	for (const key of ["cline", "cline-pass"]) {
		const entry = bucket[key];
		if (entry?.settings?.auth?.accessToken) return { key, entry };
	}
	for (const [key, entry] of Object.entries(bucket)) {
		if (entry?.settings?.auth?.accessToken) return { key, entry };
	}
	return undefined;
}

function readCredentials() {
	const providers = readProvidersFile();
	const found = findClineEntry(providers);
	if (!found) throw new Error("No Cline OAuth credentials found in providers.json");
	const auth = found.entry.settings.auth;
	const raw = String(auth.accessToken || "").trim();
	return {
		providers,
		entryKey: found.key,
		accessToken: raw,
		/** Header value exactly as Cline itself sends it. */
		bearer: raw.toLowerCase().startsWith(WORKOS_PREFIX) ? raw : `${WORKOS_PREFIX}${raw}`,
		refreshToken: auth.refreshToken ? String(auth.refreshToken) : undefined,
		expiresAt: Number(auth.expiresAt || 0),
		accountId: auth.accountId,
	};
}

function writeCredentials(creds, next) {
	const auth = creds.providers.providers[creds.entryKey].settings.auth;
	if (next.accessToken) {
		auth.accessToken = next.accessToken.toLowerCase().startsWith(WORKOS_PREFIX)
			? next.accessToken
			: `${WORKOS_PREFIX}${next.accessToken}`;
	}
	if (next.refreshToken) auth.refreshToken = next.refreshToken;
	if (next.expiresAt) auth.expiresAt = next.expiresAt;
	if (next.accountId) auth.accountId = next.accountId;
	writeFileSync(CONFIG.providersPath, JSON.stringify(creds.providers, null, 2));
}

function fingerprint(token) {
	return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

async function refreshCredentials(creds) {
	if (!creds.refreshToken) throw new Error("No refresh token stored; re-login in Cline");
	// Cline rotates refresh tokens (single use). Another process (the app/CLI) may
	// have refreshed in the meantime: if so, just adopt its fresh credentials.
	let latest;
	try {
		latest = readCredentials();
	} catch {
		latest = undefined;
	}
	if (latest && latest.accessToken !== creds.accessToken) {
		log("auth: another Cline process already refreshed the token, reusing it");
		return latest;
	}

	const url = `${CONFIG.apiBase}/auth/refresh`;
	log("auth: refreshing access token");
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refreshToken: creds.refreshToken, grantType: "refresh_token" }),
	});
	const text = await res.text();
	let json;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		json = undefined;
	}
	if (!res.ok || !json?.success || !json?.data?.accessToken) {
		const detail = json?.error || text?.slice(0, 200) || res.status;
		throw new Error(`Token refresh failed (${res.status}): ${detail}`);
	}
	const data = json.data;
	writeCredentials(creds, {
		accessToken: data.accessToken,
		refreshToken: data.refreshToken,
		expiresAt: data.expiresAt ? Date.parse(data.expiresAt) : Date.now() + 3600_000,
		accountId: data.userInfo?.clineUserId ?? creds.accountId,
	});
	log("auth: refreshed, expires", data.expiresAt);
	return readCredentials();
}

// ---------------------------------------------------------------------------
// Cline gateway client
// ---------------------------------------------------------------------------

function clineHeaders(creds, extra = {}) {
	return {
		Authorization: `Bearer ${creds.bearer}`,
		"Content-Type": "application/json",
		"HTTP-Referer": "https://cline.bot",
		"X-Title": "Cline",
		"X-IS-MULTIROOT": "false",
		"X-CLIENT-TYPE": CONFIG.clientType,
		"X-CLIENT-VERSION": CONFIG.clientVersion,
		"X-PLATFORM": CONFIG.platform,
		"X-PLATFORM-VERSION": CONFIG.platformVersion,
		"X-CORE-VERSION": CONFIG.coreVersion,
		"X-Task-ID": `proxy-${Date.now()}`,
		"User-Agent": `Cline/${CONFIG.clientVersion}`,
		...extra,
	};
}

/** Only a real auth failure should trigger a token refresh (403 can mean "not subscribed"). */
function isAuthFailure(status, text) {
	if (status === 401) return true;
	try {
		const json = JSON.parse(text);
		const code = String(json?.error?.code ?? json?.error?.message ?? json?.error ?? "");
		return /unauthor|unauthenticated|invalid.?token|token.?expired|session.?expired/i.test(code);
	} catch {
		return false;
	}
}

/** POST to the gateway, retrying once after a forced token refresh on a real 401. */
async function callCline(path, { method = "POST", body } = {}) {
	let creds = await getBearer();
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const res = await fetch(`${CONFIG.apiBase}${path}`, {
			method,
			headers: clineHeaders(creds),
			body,
			...(CONFIG.requestTimeoutMs > 0
				? { signal: AbortSignal.timeout(CONFIG.requestTimeoutMs) }
				: {}),
		});
		if (res.status !== 401 && res.status !== 403) return res;

		// Buffer the (small) error payload so it can be inspected and still returned.
		const text = await res.text();
		if (attempt === 0 && isAuthFailure(res.status, text)) {
			log(`gateway ${res.status} on ${path} -> refreshing token and retrying`);
			try {
				creds = await getBearer(true);
			} catch (error) {
				log("auth: forced refresh failed:", error.message);
			}
			continue;
		}
		return new Response(text, {
			status: res.status,
			headers: {
				"content-type": res.headers.get("content-type") || "application/json",
			},
		});
	}
	throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const FALLBACK_MODEL_IDS = ["cline-pass/deepseek-v4.1-flash"];
let modelCache = { at: 0, data: [] };

/** Learned availability, keyed by the real gateway model id (not hardcoded). */
const modelAvailability = new Map();

async function loadModels() {
	if (Date.now() - modelCache.at < 5 * 60_000 && modelCache.data.length) return modelCache.data;
	const ids = new Map();
	const push = (id, name, tier) => {
		if (typeof id === "string" && id.trim() && !ids.has(id)) {
			ids.set(id, {
				id,
				name: typeof name === "string" ? name : id,
				tier: typeof tier === "string" ? tier : "unknown",
			});
		}
	};
	try {
		const res = await fetch(`${CONFIG.apiBase}/ai/cline/recommended-models`);
		if (res.ok) {
			const json = await res.json();
			for (const tier of ["recommended", "free", "clinePass", "clineCloud"]) {
				for (const model of json?.[tier] ?? []) push(model.id, model.name, tier);
			}
		}
	} catch (error) {
		log("models: feed failed:", error.message);
	}
	for (const id of FALLBACK_MODEL_IDS) push(id, undefined, "clinePass");
	const data = [...ids.values()];
	modelCache = { at: Date.now(), data };
	return data;
}

function aliasFor(id) {
	return id.split("/").filter(Boolean).at(-1) || id;
}

/**
 * Build the client-facing alias index. Tails (e.g. "deepseek-v4.1-flash") can
 * collide across tiers (cline-free vs cline-pass), so ambiguous ones get a
 * "tail@firstSegment" alias ("deepseek-v4.1-flash@cline-free").
 */
function buildAliasIndex(models) {
	const tailCount = new Map();
	for (const model of models) {
		const tail = aliasFor(model.id);
		tailCount.set(tail, (tailCount.get(tail) || 0) + 1);
	}
	const byAlias = new Map();
	const byId = new Map();
	for (const model of models) {
		const tail = aliasFor(model.id);
		const alias =
			tailCount.get(tail) > 1 ? `${tail}@${model.id.split("/")[0]}` : tail;
		if (!byAlias.has(alias)) byAlias.set(alias, model);
		byId.set(model.id, model);
	}
	return { byAlias, byId };
}

function availabilityFields(realId) {
	const state = modelAvailability.get(realId);
	if (!state) return {};
	if (state.regionBlocked) {
		return { available: false, reason: "not available in your region" };
	}
	if (state.requiresSubscription) {
		return { available: false, reason: "requires cline-pass subscription" };
	}
	if (state.freeLimitResetIn) {
		return {
			available: false,
			reason: `free limit reached, resets in ${state.freeLimitResetIn}`,
		};
	}
	return {};
}

/** Client-facing model list: slash-free aliases (some clients split on "/"). */
async function modelsPayload() {
	const models = await loadModels();
	const { byAlias } = buildAliasIndex(models);
	const out = new Map();
	for (const [alias, model] of byAlias) {
		out.set(alias, { id: alias, name: model.name, model });
	}
	if (CONFIG.exposeFullIds) {
		for (const model of models) {
			out.set(model.id, { id: model.id, name: model.name, model });
		}
	}
	return [
		...[...out.values()].map((m) => ({
			id: m.id,
			object: "model",
			created: 0,
			owned_by: "cline",
			name: m.name,
			tier: m.model.tier,
			free: m.model.tier === "free" || m.model.tier === "recommended",
			requires_cline_pass: m.model.tier === "clinePass",
			...availabilityFields(m.model.id),
		})),
		// Models the client actually used but the feed does not list (e.g.
		// cline-free/* ids) - surface them with whatever we learned.
		...[...modelAvailability.entries()]
			.filter(([id]) => !models.some((m) => m.id === id))
			.map(([id, state]) => ({
				id,
				object: "model",
				created: 0,
				owned_by: "cline",
				name: id,
				tier: "unknown",
				free: false,
				requires_cline_pass: state.requiresSubscription === true,
				...availabilityFields(id),
			})),
	];
}

/** Map whatever the client asked for back to a real Cline model id. */
async function resolveModel(requested) {
	if (!requested) return undefined;
	const models = await loadModels();
	const { byAlias, byId } = buildAliasIndex(models);
	return byId.get(requested)?.id ?? byAlias.get(requested)?.id ?? requested;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}

function passthroughHeaders(upstream) {
	const out = {};
	for (const [key, value] of upstream.headers) {
		if (["content-encoding", "content-length", "transfer-encoding"].includes(key)) continue;
		out[key] = value;
	}
	return out;
}

/**
 * Gateway error classification вЂ” mirrors the markers the Cline SDK uses in
 * `sdk/packages/llms/src/providers/errors.ts`. The reset time is embedded in
 * the message text ("... free limit reached on model ... try again in 2h"),
 * there is no dedicated field, so we extract it into `limit_reset_in`.
 */
function classifyGatewayMessage(message) {
	const text = String(message || "").toLowerCase();
	const out = {};
	if (
		text.includes("the user is not subscribed to required model plan") ||
		text.includes("no access to clinepass subscription models yet")
	) {
		out.code = "ENTITLEMENT_ERROR";
		out.requiresSubscription = true;
	}
	if (
		text.includes("you have reached your") &&
		text.includes("clinepass limit") &&
		text.includes("please try again later.")
	) {
		out.code = "CLINE_PASS_LIMIT";
		out.limitReached = true;
	}
	if (text.includes("free limit reached on model")) {
		out.code = "CLINE_FREE_MODEL_LIMIT";
		out.limitReached = true;
		const marker = "try again in ";
		const idx = text.indexOf(marker);
		if (idx !== -1) {
			out.limitResetIn = String(message).slice(idx + marker.length).trim();
		}
	}
	if (text.includes("model not found")) {
		out.code = "MODEL_NOT_FOUND";
	}
	if (text.includes("not available in your region")) {
		out.code = "REGION_BLOCKED";
		out.regionBlocked = true;
	}
	if (/empty response content/i.test(text)) {
		out.emptyContent = true;
	}
	return out;
}

/** Remember what a failed model told us, to annotate /v1/models. */
function learnFromError(realModelId, message) {
	if (!realModelId) return;
	const cls = classifyGatewayMessage(message);
	if (cls.regionBlocked) {
		modelAvailability.set(realModelId, { regionBlocked: true });
	} else if (cls.requiresSubscription) {
		modelAvailability.set(realModelId, { requiresSubscription: true });
	} else if (cls.limitResetIn) {
		modelAvailability.set(realModelId, { freeLimitResetIn: cls.limitResetIn });
	}
}

/**
 * The Cline gateway wraps non-streaming responses in its API envelope
 * (`{success, data}` / `{success:false, error}`), while streaming responses are
 * plain OpenAI SSE. Unwrap it so ordinary OpenAI clients can read the result.
 * Returns { body, json } вЂ” `json` is the raw upstream payload for learning.
 */
function normalizeJsonBody(text) {
	try {
		const json = JSON.parse(text);
		if (json && typeof json === "object" && !Array.isArray(json)) {
			// Gateway errors arrive in two shapes: wrapped (`{success:false, error}`)
			// and direct (`{error:{code,message}}`). Handle both. Note the direct
			// shape is what the gateway returns for free-limit (INFERENCE_CAP_ERROR)
			// and entitlement errors.
			if (json.error !== undefined && !json.choices && !json.data) {
				const upstream = json.error;
				let message =
					typeof upstream === "string" ? upstream : (upstream?.message ?? JSON.stringify(upstream));
				const cls = classifyGatewayMessage(message);
				// Seen with reasoning models (e.g. cline-free/deepseek-v4.1-flash) when
				// max_tokens is so small that the whole budget goes into reasoning.
				if (cls.emptyContent) {
					message +=
						" вЂ” the gateway returned no visible text. This usually means max_tokens was" +
						" too small for a reasoning model (raise it to >= 512, or drop it entirely).";
				}
				const err = { message, type: "cline_gateway_error" };
				// Preserve every structured field the gateway sent (code, limits, ...).
				if (typeof upstream === "object" && upstream !== null) {
					for (const [key, value] of Object.entries(upstream)) {
						if (value !== undefined && value !== null && !(key in err)) err[key] = value;
					}
				}
				if (cls.code && !err.code) err.code = cls.code;
				if (cls.limitResetIn) err.limit_reset_in = cls.limitResetIn;
				if (cls.limitReached) err.limit_reached = true;
				if (cls.requiresSubscription) err.requires_subscription = true;
				if (cls.regionBlocked) err.region_blocked = true;
				return { body: JSON.stringify({ error: err }), json };
			}
			if (
				json.data &&
				typeof json.data === "object" &&
				(json.data.choices || json.data.object || json.data.id)
			) {
				return { body: JSON.stringify(json.data), json };
			}
		}
	} catch {
		// Not JSON (or already unwrapped): return as-is.
	}
	return { body: text, json: undefined };
}

async function pipeUpstream(upstream, res) {
	const headers = passthroughHeaders(upstream);
	const contentType = String(upstream.headers.get("content-type") || "");
	const isJson = contentType.includes("application/json") && !contentType.includes("event-stream");
	if (isJson && upstream.body) {
		const text = await upstream.text();
		const { body, json } = normalizeJsonBody(text);
		res.writeHead(upstream.status, {
			...headers,
			"content-type": "application/json",
			"content-length": Buffer.byteLength(body),
		});
		res.end(body);
		return json;
	}
	res.writeHead(upstream.status, headers);
	if (!upstream.body) {
		res.end();
		return undefined;
	}
	for await (const chunk of upstream.body) res.write(chunk);
	res.end();
	return undefined;
}

/**
 * OpenAI's reasoning-era models (o1/o3/o4, gpt-5 family) reject `max_tokens`
 * with a 400 and require `max_completion_tokens`. Cline does the same rename in
 * `withMaxCompletionTokensForReasoningModels`.
 */
function isOpenAIReasoningModelId(modelId) {
	const normalized = String(modelId || "").toLowerCase();
	if (!normalized) return false;
	return (
		/(^|[^a-z0-9])o[134](?=$|[^a-z0-9])/.test(normalized) ||
		/(^|[^a-z0-9])gpt-?5(?=$|[^a-z0-9])/.test(normalized)
	);
}

async function handleChat(body, res) {
	let payload;
	try {
		payload = JSON.parse(body.toString("utf8") || "{}");
	} catch {
		sendJson(res, 400, {
			error: { message: "Invalid JSON body", type: "invalid_request_error" },
		});
		return;
	}
	const realModel = await resolveModel(payload.model);
	if (realModel && realModel !== payload.model) log(`model: ${payload.model} -> ${realModel}`);
	if (realModel) payload.model = realModel;
	if (payload.stream && payload.stream_options === undefined) {
		payload.stream_options = { include_usage: true };
	}
	// Mirror Cline: OpenAI reasoning-era models take max_completion_tokens.
	if (
		payload.max_tokens !== undefined &&
		payload.max_completion_tokens === undefined &&
		isOpenAIReasoningModelId(payload.model)
	) {
		payload.max_completion_tokens = payload.max_tokens;
		delete payload.max_tokens;
		log(`request: ${payload.model} -> max_tokens renamed to max_completion_tokens`);
	}

	const started = Date.now();
	const upstream = await callCline("/chat/completions", { body: JSON.stringify(payload) });
	log(
		`chat: model=${payload.model} stream=${payload.stream === true} status=${upstream.status} ${Date.now() - started}ms`,
	);
	const parsed = await pipeUpstream(upstream, res);
	if (parsed?.error?.message) {
		learnFromError(payload.model, parsed.error.message);
		log(`gateway error for ${payload.model}: code=${parsed.error.code ?? "none"} message=${parsed.error.message}`);
	}
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function route(req, res) {
	const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
	const path = url.pathname;

	if (req.method === "GET" && (path === "/health" || path === "/")) {
		try {
			const creds = readCredentials();
			sendJson(res, 200, {
				ok: true,
				apiBase: CONFIG.apiBase,
				providersPath: CONFIG.providersPath,
				clientType: CONFIG.clientType,
				tokenFingerprint: fingerprint(creds.bearer),
				tokenExpiresAt: creds.expiresAt ? new Date(creds.expiresAt).toISOString() : null,
				accountId: creds.accountId ?? null,
			});
		} catch (error) {
			sendJson(res, 500, { ok: false, error: error.message });
		}
		return;
	}

	if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
		try {
			sendJson(res, 200, { object: "list", data: await modelsPayload() });
		} catch (error) {
			sendJson(res, 500, { error: { message: error.message, type: "proxy_error" } });
		}
		return;
	}

	if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
		try {
			await handleChat(await readBody(req), res);
		} catch (error) {
			log("chat error:", error.message);
			if (!res.headersSent) {
				sendJson(res, 502, { error: { message: error.message, type: "proxy_error" } });
			} else {
				res.end();
			}
		}
		return;
	}

	sendJson(res, 404, {
		error: {
			message: `Unsupported path ${path}. Use POST /v1/chat/completions or GET /v1/models.`,
			type: "invalid_request_error",
		},
	});
}

const server = http.createServer((req, res) => {
	// Local tool: remote callers are refused; the optional key keeps other local
	// processes from silently spending your Cline credits.
	const remote = req.socket.remoteAddress || "";
	if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) {
		sendJson(res, 403, { error: { message: "Local connections only", type: "proxy_error" } });
		return;
	}
	if (CONFIG.apiKey && req.url !== "/health") {
		const auth = String(req.headers.authorization || "");
		if (auth !== `Bearer ${CONFIG.apiKey}`) {
			sendJson(res, 401, {
				error: { message: "Invalid proxy API key", type: "invalid_request_error" },
			});
			return;
		}
	}
	route(req, res).catch((error) => {
		log("unhandled:", error.stack || error.message);
		if (!res.headersSent) sendJson(res, 500, { error: { message: error.message } });
	});
});

server.listen(CONFIG.port, CONFIG.host, async () => {
	log(`cline-proxy listening on http://${CONFIG.host}:${CONFIG.port}/v1`);
	log(`apiBase=${CONFIG.apiBase} client=${CONFIG.clientType}`);
	try {
		const creds = await getBearer();
		const expires = creds.expiresAt ? new Date(creds.expiresAt).toISOString() : "unknown";
		log(
			`auth ok: token=${fingerprint(creds.bearer)} expires=${expires} account=${creds.accountId ?? "unknown"}`,
		);
	} catch (error) {
		log("auth error:", error.message);
	}
});


async function getBearer(forceRefresh = false) {
	let creds = readCredentials();
	const expiredSoon =
		creds.expiresAt > 0 && creds.expiresAt - Date.now() <= CONFIG.refreshBufferMs;
	if ((forceRefresh || expiredSoon) && creds.refreshToken) {
		try {
			creds = await refreshCredentials(creds);
		} catch (error) {
			if (forceRefresh) throw error;
			log("auth: proactive refresh failed, using current token:", error.message);
		}
	}
	return creds;
}