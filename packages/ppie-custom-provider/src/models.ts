/**
 * Model catalog parsing and dimension resolution, shared by both registration paths.
 *
 * Neither path can omit `contextWindow`/`maxTokens` — the legacy
 * `ProviderConfigInput["models"]` and the native `Model` both declare them as
 * required numbers. pi's `?? 128000` / `?? 16384` fill applies only to models
 * declared in `models.json`, whose input type marks them optional; extension
 * registrations never reach it.
 *
 * So a literal is unavoidable, and the rule is to mirror the one pi itself
 * ships — pi's bundled llama.cpp extension — rather than invent a different
 * one. See docs/adr/adr-0001-defer-to-pi-defaults-over-extension-constants.md.
 */

/** llama.cpp's fallback when the server reports no usable context window. */
const FALLBACK_CONTEXT_WINDOW = 128000;

/**
 * llama.cpp's output ceiling, matching pi's own `models.json` fill. The previous
 * value here was 4096, which silently capped every discovered model at a quarter
 * of what pi would have allowed.
 */
const FALLBACK_MAX_TOKENS = 16384;

/**
 * A model entry as reported by an OpenAI-compatible `/models` endpoint.
 *
 * The context window has no single agreed field name: vLLM and the servers that
 * copy it (omlx among them) report `max_model_len`, while others use
 * `context_window` or `context_length`. llama.cpp's own extension reads two
 * candidates for the same reason (`meta.n_ctx ?? meta.n_ctx_train`), so several
 * names are checked in order rather than assuming one.
 */
export interface RemoteModel {
	id: string;
	name?: string;
	context_window?: number;
	context_length?: number;
	max_model_len?: number;
	max_tokens?: number;
}

export interface ModelDimensions {
	contextWindow: number;
	maxTokens: number;
}

/**
 * Resolves the server's reported dimensions, exactly as llama.cpp does: reject
 * non-positive values so a server reporting `0` cannot poison the model, and
 * clamp the output ceiling to the context window so it can never exceed it.
 */
export function resolveDimensions(model: RemoteModel): ModelDimensions {
	const reported = [model.context_window, model.context_length, model.max_model_len].find(
		(value) => value !== undefined && value > 0,
	);
	const contextWindow = reported ?? FALLBACK_CONTEXT_WINDOW;
	const reportedMaxTokens = model.max_tokens;
	const maxTokens = reportedMaxTokens !== undefined && reportedMaxTokens > 0 ? reportedMaxTokens : FALLBACK_MAX_TOKENS;
	return { contextWindow, maxTokens: Math.min(maxTokens, contextWindow) };
}

/**
 * Validates a `/models` payload rather than asserting its shape. An entry with a
 * missing `id` would otherwise register a model with `id: undefined`, which
 * fails later at selection time with no hint that a malformed response was the
 * real cause.
 */
export function parseModelsPayload(payload: unknown): RemoteModel[] {
	const data = isPlainObject(payload) ? payload.data : undefined;
	if (!Array.isArray(data)) return [];

	return data.flatMap((entry): RemoteModel[] => {
		if (!isPlainObject(entry)) return [];
		const { id, name } = entry;
		if (typeof id !== "string" || id === "") return [];
		const numeric = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
		return [
			{
				id,
				name: typeof name === "string" ? name : undefined,
				context_window: numeric(entry.context_window),
				context_length: numeric(entry.context_length),
				max_model_len: numeric(entry.max_model_len),
				max_tokens: numeric(entry.max_tokens),
			},
		];
	});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Matches llama.cpp's client timeout: discovery must not hang pi's refresh. */
export const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Deadline for the startup prime, well inside the 15s budget pi allows the whole
 * of `resolveModelScope`. Priming is an optimization — it exists so the catalog
 * is ready before pi resolves `enabledModels` — and pi's own later refresh remains
 * the source of truth. A slow server must therefore cost a short pause at
 * startup, never the full discovery timeout.
 */
export const PRIME_TIMEOUT_MS = 3_000;

/**
 * Prefer the server's own `{ error: { message } }` over a bare status code,
 * as llama.cpp's client does.
 */
export function discoveryErrorMessage(payload: unknown, fallback: string): string {
	if (!isPlainObject(payload)) return fallback;
	const error = payload.error;
	if (!isPlainObject(error)) return fallback;
	const message = error.message;
	return typeof message === "string" && message ? message : fallback;
}

/**
 * The human-readable reason a discovery attempt failed.
 *
 * `fetch` reports every transport failure as the same opaque `TypeError: fetch
 * failed`, putting the fact that actually distinguishes them — connection
 * refused, DNS miss, TLS rejection — in `cause`. Unwrapping one level turns
 * three identical-looking failures into three different sentences, which is the
 * whole point of reporting the reason at all.
 *
 * A timeout arrives as an `AbortError` from `AbortSignal.timeout`, named rather
 * than described, so it is spelled out against the deadline that produced it.
 */
export function discoveryFailureReason(error: unknown): string {
	if (error instanceof Error && error.name === "TimeoutError") {
		return `No response within ${DISCOVERY_TIMEOUT_MS / 1000}s`;
	}
	if (error instanceof Error) {
		const cause = error.cause;
		if (cause instanceof Error && cause.message) return cause.message;
		if (error.message) return error.message;
	}
	return String(error);
}
