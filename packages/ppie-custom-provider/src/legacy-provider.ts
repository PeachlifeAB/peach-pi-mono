import type { AnyModel, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { type OpenAIProviderConfig, overflowRegExp } from "./config.ts";
import { DISCOVERY_TIMEOUT_MS, discoveryErrorMessage, parseModelsPayload, resolveDimensions } from "./models.ts";
import { streamOpenAIGeneric } from "./stream.ts";

const LEGACY_PROVIDER_ID = "openai-generic";

/** The legacy provider serves chat models only: no image or classifier entries. */
type StoredModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;
/** Env var this provider reads, resolved by pi at request time. */
const API_KEY_ENV_VAR = "OPENAI_GENERIC_API_KEY";

/**
 * Builds the catalog from the server's own listing.
 *
 * Models carry no `compat` block of their own unless the user supplied one. pi
 * derives all twenty compat flags from provider id and base URL and already
 * encodes the quirks of ten hosted gateways; a blanket block here would override
 * that detection for every one of them in order to describe one. See ADR-0001.
 */
function toModelConfigs(
	models: readonly ReturnType<typeof parseModelsPayload>[number][],
	config: OpenAIProviderConfig,
) {
	const hasCompatOverrides = Object.keys(config.compat).length > 0;

	return models.map((model): StoredModelConfig => {
		const { contextWindow, maxTokens } = resolveDimensions(model);
		return {
			id: model.id,
			name: model.name ?? model.id,
			api: "openai-completions",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
			...(hasCompatOverrides ? { compat: config.compat } : {}),
		};
	});
}

/**
 * The store round-trips `Model`, which carries `provider`/`baseUrl` that
 * `ProviderModelConfig` leaves to the provider entry. These two functions are the
 * only place that difference is bridged.
 */
function toStoredModel(model: StoredModelConfig, config: OpenAIProviderConfig): Model<"openai-completions"> {
	return {
		...model,
		api: "openai-completions",
		provider: LEGACY_PROVIDER_ID,
		baseUrl: config.baseUrl,
	};
}

function readStoredConfigs(context: RefreshModelsContext): StoredModelConfig[] {
	if (!context.stored) return [];
	return context.stored.models
		.filter(isLegacyChatModel)
		.map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => model);
}

function isLegacyChatModel(model: AnyModel): model is Model<"openai-completions"> {
	return model.provider === LEGACY_PROVIDER_ID && model.api === "openai-completions";
}

/**
 * Discovery request, shaped after llama.cpp's `LlamaClient.request`: a bounded
 * timeout so an unreachable server cannot hang the refresh, and the server's own
 * error message preferred over a bare status code.
 */
async function fetchModelConfigs(config: OpenAIProviderConfig, signal?: AbortSignal): Promise<StoredModelConfig[]> {
	const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	const response = await fetch(`${config.baseUrl}${config.discovery.path}`, {
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		payload = undefined;
	}
	if (!response.ok) throw new Error(discoveryErrorMessage(payload, `Server returned HTTP ${response.status}`));
	return toModelConfigs(parseModelsPayload(payload), config);
}

export function registerLegacyProvider(pi: ExtensionAPI, config: OpenAIProviderConfig) {
	pi.registerProvider(LEGACY_PROVIDER_ID, {
		name: "OpenAI-Compatible (Generic)",
		baseUrl: config.baseUrl,
		// pi resolves `$VAR` at request time; the key itself lives in pi's
		// mode-restricted credential store once the user runs /login.
		apiKey: `$${API_KEY_ENV_VAR}`,
		api: "openai-completions",
		// Non-standard SSE framing means the default openai-completions client can't be reused.
		streamSimple: streamOpenAIGeneric,
		authHeader: true,
		// Registration performs no network call: an unreachable server must not be
		// able to delay pi's startup. The catalog arrives through refreshModels,
		// which pi invokes after login, logout, config reload, runtime key changes,
		// and at startup. See ADR-0003.
		models: [],
		async refreshModels(context) {
			// The returned list replaces this provider's models, so the offline pass
			// (`allowNetwork: false`) must return the persisted catalog rather than an
			// empty array — otherwise a cold start wipes the model list and the
			// provider shows up nowhere. pi supplies that catalog as `context.stored`.
			const restored = readStoredConfigs(context);

			if (!context.allowNetwork || context.signal.aborted) return restored;
			if (!config.discovery.enabled) return restored;
			// llama.cpp's guard: only contact a server the user actually configured, so
			// a refresh before /login contacts nothing rather than failing against a
			// default port nobody is listening on.
			if (!context.credential) return restored;

			const fetched = await fetchModelConfigs(config, context.signal);
			if (!context.signal.aborted) {
				// Persist only: this path returns its models to pi, which publishes them
				// itself, so no `update` callback is needed here.
				await context.publish({
					persist: {
						models: fetched.map((model) => toStoredModel(model, config)),
						checkedAt: Date.now(),
					},
				});
			}
			return fetched;
		},
	});

	// Additive overflow detection. pi recognizes the common phrasings itself; a
	// configured pattern covers servers that word it differently. Rewriting to
	// pi's own `context_length_exceeded` phrase is what triggers its
	// compact-and-retry recovery.
	const overflowPattern = overflowRegExp(config);
	if (!overflowPattern) return;

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.stopReason !== "error") return;
		if (message.provider !== LEGACY_PROVIDER_ID && ctx.model?.provider !== LEGACY_PROVIDER_ID) return;

		const errorMessage = message.errorMessage ?? "";
		// Idempotent: pi may already have recognized this, and the handler can run
		// again over a message it previously rewrote.
		if (errorMessage.includes("context_length_exceeded")) return;
		if (!overflowPattern.test(errorMessage)) return;

		return {
			message: {
				...message,
				errorMessage: `context_length_exceeded: ${errorMessage}`,
			},
		};
	});
}

/** Demonstrates the unregister path — not called at load time, shown for reference. */
export function teardownLegacyProvider(pi: ExtensionAPI) {
	pi.unregisterProvider(LEGACY_PROVIDER_ID);
}
