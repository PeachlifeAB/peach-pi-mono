import type {
	Model,
	ModelAuth,
	OAuthCredential,
	Provider,
	ProviderStreamOptions,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { OpenAIProviderConfig } from "./config.ts";
import { logEvent, resolveLoggingEnabled } from "./logging.ts";
import {
	DISCOVERY_TIMEOUT_MS,
	discoveryErrorMessage,
	discoveryFailureReason,
	PRIME_TIMEOUT_MS,
	parseModelsPayload,
	type RemoteModel,
	resolveDimensions,
} from "./models.ts";

export const NATIVE_PROVIDER_ID = "ppie-custom-provider";

/**
 * Where a discovery failure is reported, beyond the throw pi consumes.
 *
 * pi keeps the thrown error (`packages/ai/src/models.ts:304-312` puts it in
 * `ModelsRefreshResult.errors`), but the model selector renders only the map's
 * *keys* — `Could not refresh ${id}; showing cached models.`
 * (`modes/interactive/components/model-selector.ts:176`). The reason never
 * reaches the screen, so a dead server, a rejected key, and an unresolvable host
 * are one indistinguishable sentence. This port carries that reason somewhere a
 * human can read it.
 *
 * A port rather than an `ExtensionAPI` parameter: the provider is domain code
 * and must not know the sink is a log file. `registerNativeProvider` injects the
 * adapter at the boundary.
 */
export type DiscoveryFailureSink = (message: string) => void;

/**
 * Prefills the server-URL prompt during `/login`. It is *not* an alternative to
 * logging in: this provider registers only `auth.oauth`, and `OAuthAuth` exposes
 * no `check`/`resolve` hook, so pi has nowhere to read ambient credentials from.
 * (llama.cpp's `LLAMA_BASE_URL`/`LLAMA_API_KEY` work without `/login` because it
 * registers `auth.apiKey`, whose `resolve` receives an `AuthContext`. Adding one
 * here would put a second entry for this provider in the `/login` picker — see
 * `getLoginProviderOptions`, which keys purely off block presence.)
 */
export const BASE_URL_ENV_VAR = "OPENAI_GENERIC_BASE_URL";

/**
 * Where the server URL lives inside the stored credential. `OAuthCredential` is
 * an open record (`[key: string]: unknown`), so the URL is a first-class field
 * rather than something smuggled through an env side channel.
 */
export const SERVER_URL_FIELD = "serverUrl";

/**
 * pi refreshes a credential whenever `Date.now() >= expires`. This provider has
 * no token to rotate, so the sentinel keeps `refresh` from ever being reached.
 */
const NEVER_EXPIRES = 8640000000000000;

/** Server URL stored with the credential, so /login can set it without a config edit. */
function credentialServerUrl(credential: OAuthCredential | undefined): string | undefined {
	const value = credential?.[SERVER_URL_FIELD];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toPiModel(model: RemoteModel, serverUrl: string, config: OpenAIProviderConfig): Model<"openai-completions"> {
	const { contextWindow, maxTokens } = resolveDimensions(model);
	const hasCompatOverrides = Object.keys(config.compat).length > 0;
	return {
		id: model.id,
		name: model.name ?? model.id,
		api: "openai-completions",
		provider: NATIVE_PROVIDER_ID,
		baseUrl: serverUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		// No compat block unless the user supplied one: pi derives all twenty flags
		// from provider id and base URL, and already handles ten hosted gateways.
		// See ADR-0001.
		...(hasCompatOverrides ? { compat: config.compat } : {}),
	};
}

/**
 * The provider plus the startup prime pi's registration path cannot perform.
 *
 * Shaped after pi's own llama extension, which likewise returns
 * `{ provider, setCatalog }` so the catalog can be filled from outside the
 * factory closure.
 */
export interface OpenAIProviderController {
	provider: Provider<"openai-completions">;
	/**
	 * Fills the catalog before `registerProvider`, so models exist by the time pi
	 * resolves `enabledModels`.
	 *
	 * `registerNativeProvider` in pi core fires its cache-only refresh as
	 * `void this.refresh({ allowNetwork: false })` — deliberately not awaited — and
	 * `resolveModelScope` runs before that settles. Any provider whose
	 * `refreshModels` awaits anything therefore reports an empty catalog at scope
	 * resolution, and every `enabledModels` entry for it is warned about as
	 * `No models match pattern "..."` despite resolving correctly moments later.
	 *
	 * Resolves rather than rejects: priming is best-effort, and a failure must
	 * leave the provider registered for pi's own refresh to retry.
	 */
	prime(): Promise<void>;
}

export function createOpenAIProvider(
	config: OpenAIProviderConfig,
	reportDiscoveryFailure?: DiscoveryFailureSink,
): Provider<"openai-completions"> {
	return createOpenAIProviderController(config, reportDiscoveryFailure).provider;
}

/**
 * Reads the credential `/login` stored for this provider. A port so tests can
 * supply one without a real `auth.json`, and so the provider never names the
 * credential file — `readStoredCredential` owns that location.
 */
export type StoredCredentialReader = () => OAuthCredential | undefined;

const defaultCredentialReader: StoredCredentialReader = () => {
	const credential = readStoredCredential(NATIVE_PROVIDER_ID);
	return credential?.type === "oauth" ? credential : undefined;
};

export function createOpenAIProviderController(
	config: OpenAIProviderConfig,
	reportDiscoveryFailure?: DiscoveryFailureSink,
	readCredential: StoredCredentialReader = defaultCredentialReader,
): OpenAIProviderController {
	let models: readonly Model<"openai-completions">[] = [];

	const setCatalog = (catalog: readonly RemoteModel[], serverUrl: string): void => {
		models = catalog.map((model) => toPiModel(model, serverUrl, config));
	};

	// Shaped after llama.cpp's `LlamaClient.request`: a bounded timeout so an
	// unreachable server cannot hang the refresh, and the server's own error
	// message preferred over a bare status code.
	const fetchCatalog = async (serverUrl: string, apiKey: string | undefined, signal?: AbortSignal) => {
		const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
		const response = await fetch(`${serverUrl}${config.discovery.path}`, {
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
		});
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = undefined;
		}
		if (!response.ok) throw new Error(discoveryErrorMessage(payload, `Server returned HTTP ${response.status}`));
		return parseModelsPayload(payload);
	};

	const provider: Provider<"openai-completions"> = {
		id: NATIVE_PROVIDER_ID,
		name: "OpenAI-Compatible (Generic)",
		baseUrl: config.baseUrl,
		auth: {
			// Account-style login: one flow that collects the server URL and an
			// optional key, rather than pi's bare api-key prompt. `toAuth` carries the
			// per-account baseUrl, so each stored account points at its own server.
			oauth: {
				name: "OpenAI-Compatible (Generic)",
				loginLabel: "Connect an OpenAI-compatible server",
				login: async (interaction): Promise<OAuthCredential> => {
					const enteredUrl = await interaction.prompt({
						type: "text",
						message: "OpenAI-compatible server URL",
						placeholder: process.env[BASE_URL_ENV_VAR] ?? config.baseUrl,
					});
					// Deliberately unvalidated and unprobed: the user may be configuring a
					// server that is not running yet.
					const serverUrl = enteredUrl.trim() || process.env[BASE_URL_ENV_VAR] || config.baseUrl;
					const apiKey = (
						await interaction.prompt({
							type: "secret",
							message: "API key (optional)",
						})
					).trim();
					return {
						type: "oauth",
						// A plain OpenAI-compatible endpoint issues no tokens, so there is
						// nothing to rotate: the key the user typed is the whole credential.
						// `expires` is the far-future sentinel because pi refreshes whenever
						// `Date.now() >= expires`, and there is no refresh to perform.
						access: apiKey,
						refresh: "",
						expires: NEVER_EXPIRES,
						[SERVER_URL_FIELD]: serverUrl,
					};
				},
				// No authorization server, so no rotation. Returning the credential
				// unchanged is the honest identity; `expires` keeps this unreachable.
				refresh: async (credential): Promise<OAuthCredential> => credential,
				toAuth: async (credential): Promise<ModelAuth> => {
					const serverUrl = credentialServerUrl(credential) ?? config.baseUrl;
					const apiKey = credential.access;
					// Blank key means the server wants no Authorization header at all;
					// sending a placeholder would break servers that reject unknown bearers.
					return apiKey ? { apiKey, baseUrl: serverUrl } : { baseUrl: serverUrl };
				},
			},
		},
		getModels: () => models,
		// pi calls this after login, logout, config reload, runtime key changes, and
		// at startup — so no timer is needed to keep the catalog current. See ADR-0003.
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			// The persisted catalog is restored first, unconditionally. pi runs an
			// offline pass with `allowNetwork: false` ("cache-only initialization"),
			// and that pass is the only thing standing between a cold start and an
			// empty model list — a provider that returns early here has no models to
			// list and never appears in `--list-models` or the /login picker.
			//
			// pi hands us an immutable snapshot in `context.stored` and takes every
			// mutation through the generation-checked `context.publish`, which returns
			// false when a newer refresh has superseded this one. Publishing is what
			// makes a late-finishing refresh unable to overwrite a newer catalog.
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model): model is Model<"openai-completions"> =>
						model.provider === NATIVE_PROVIDER_ID && model.api === "openai-completions",
				);
				if (
					!(await context.publish({
						update: () => {
							models = restored;
						},
					}))
				) {
					return;
				}
			}

			if (!context.allowNetwork || context.signal.aborted) return;
			if (!config.discovery.enabled) return;
			if (context.credential?.type !== "oauth") return;
			// llama.cpp's guard verbatim: the server URL comes from the credential and
			// nowhere else, so a refresh before /login contacts nothing.
			const credential = context.credential;
			const serverUrl = credentialServerUrl(credential);
			if (!serverUrl) return;
			// Observed, then rethrown unchanged: the rejection is what tells pi to keep
			// the cached catalog rather than publish an empty one, so swallowing it here
			// would trade a vague message for silent data loss.
			let catalog: readonly RemoteModel[];
			try {
				catalog = await fetchCatalog(serverUrl, credential.access, context.signal);
			} catch (error) {
				// An abort is the caller's own doing, not a server fault; reporting it
				// would put a line in the log every time the user closes the picker.
				if (!context.signal.aborted) {
					reportDiscoveryFailure?.(
						`Discovery failed for ${serverUrl}${config.discovery.path}: ${discoveryFailureReason(error)}`,
					);
				}
				throw error;
			}
			if (context.signal.aborted) return;
			// One publication carries both effects: `persist` writes the store so the
			// next cold start has a catalog before any network call, and `update` swaps
			// the in-memory list. pi applies the update only after the persist succeeds
			// and only while this refresh is still the current generation.
			const refreshed = catalog.map((model) => toPiModel(model, serverUrl, config));
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},
		stream: (model, context, options) => stream(model, context, options as ProviderStreamOptions | undefined),
		streamSimple: (model, context, options) => streamSimple(model, context, options),
	};

	const prime = async (): Promise<void> => {
		// The credential is read here because the factory has no pi-supplied context:
		// `refreshModels` receives its `store` and `credential` from pi, and neither
		// exists yet at registration.
		const credential = readCredential();
		if (!credential) return;
		const serverUrl = credentialServerUrl(credential);
		if (!serverUrl) return;

		try {
			setCatalog(await fetchCatalog(serverUrl, credential.access, AbortSignal.timeout(PRIME_TIMEOUT_MS)), serverUrl);
		} catch (error) {
			// Never rethrown: this runs inside the extension factory, and pi awaits
			// that factory before startup continues, so throwing here would fail the
			// whole extension over an optimization. The provider still registers and
			// pi's own refresh retries with the full discovery timeout.
			reportDiscoveryFailure?.(
				`Startup discovery failed for ${serverUrl}${config.discovery.path}: ${discoveryFailureReason(error)}`,
			);
		}
	};

	return { provider, prime };
}

/**
 * Registers the provider with its catalog already populated.
 *
 * Awaited by the extension factory, which pi awaits before startup continues
 * (`extensions/loader.ts` awaits the factory; `main.ts` awaits
 * `createAgentSessionServices` before calling `resolveModelScope`). Priming here
 * is therefore visible to `enabledModels` resolution and `--list-models`, which
 * is the whole point — see `OpenAIProviderController.prime`.
 */
export async function registerNativeProvider(pi: ExtensionAPI, config: OpenAIProviderConfig): Promise<void> {
	// The adapter for `DiscoveryFailureSink`. Both the gate and the cwd are read
	// once, here at the boundary: `refreshModels` runs long after registration, and
	// a replacement invalidates callback contexts, so the provider closes over
	// plain data rather than reaching back through `pi`.
	const loggingEnabled = resolveLoggingEnabled(pi, config);
	const cwd = process.cwd();
	const { provider, prime } = createOpenAIProviderController(config, (message) =>
		logEvent(loggingEnabled, config, cwd, "discovery_failed", message),
	);

	// Primed first so the catalog is non-empty the instant pi takes ownership.
	await prime();
	pi.registerProvider(provider);
}
