import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	OAuthCredential,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
	ThinkingLevelMap,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/**
 * OAuth / delegating-gateway reference. **Nothing here is registered.**
 *
 * Lives in `reference/` rather than `src/` because it does not ship: the
 * package's `files` array publishes `src/`, so while this sat there it went
 * into every installed copy despite being unreachable — 593 lines of fictional
 * gateway a consumer can neither call nor benefit from. Relocating rather than
 * deleting keeps it readable and typechecked in-repo. Gating it behind an
 * environment variable was considered and rejected: that would have kept the
 * competing proxy-token cache described below shipping and reachable, which is
 * exactly what the ADRs cited here forbid. See PPMONO-7.
 *
 * This describes a fictional gateway (`gateway.example.com`, a made-up client
 * id, invented token endpoints) and exists to keep the PKCE flow, the legacy vs
 * canonical OAuth surfaces, and the delegating `streamSimple` pattern visible
 * and typechecked. The real provider ships API-key auth only, following pi's own
 * bundled llama.cpp extension: an arbitrary OpenAI-compatible endpoint has no
 * authorization server to talk to. See
 * docs/adr/adr-0004-copy-shipped-implementations-over-invention.md.
 *
 * The proxy-token cache below is retained as a *cautionary* example. A real
 * provider must not hold one: pi runs OAuth refresh under its own credential
 * store lock and hands providers an already-refreshed credential, so an
 * extension-side cache is a second source of truth that can serve a token pi
 * considers stale. See
 * docs/adr/adr-0003-reactive-discovery-no-timeouts-no-polling.md.
 */

export const DELEGATING_PROVIDER_ID = "gateway-generic";

/**
 * A synthetic API type. `Api` is `KnownApi | (string & {})`, so a provider may
 * invent its own name when it does not speak any built-in protocol directly.
 * pi has no built-in dispatcher for an unknown api string, so a provider using
 * one MUST supply its own `streamSimple`.
 */
const GATEWAY_API = "gateway-generic-api";

const AUTH_BASE_URL = "https://gateway.example.com";
const OAUTH_CLIENT_ID = "ppie-custom-provider-example-client";
const OAUTH_REDIRECT_URI = "http://localhost:7777/callback";

/** Short-lived proxy token TTL, refreshed ahead of the gateway's own expiry. */
const PROXY_TOKEN_TTL_MS = 25 * 60 * 1000;

/**
 * Internal model shape. `backend` and `upstreamBaseUrl` are extension-private
 * routing fields: they never appear on the `ProviderModelConfig` we register,
 * because `streamSimple` resolves them per call instead.
 */
interface GatewayModelSpec {
	id: string;
	name: string;
	backend: "anthropic-messages" | "openai-responses";
	upstreamBaseUrl: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	contextWindow: number;
	maxTokens: number;
}

const GATEWAY_MODELS: GatewayModelSpec[] = [
	{
		id: "gateway-claude",
		name: "Gateway Claude",
		backend: "anthropic-messages",
		upstreamBaseUrl: `${AUTH_BASE_URL}/v1/proxy/anthropic`,
		reasoning: true,
		thinkingLevelMap: { off: null, low: "4096", medium: "16384", high: "32768" },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "gateway-gpt",
		name: "Gateway GPT",
		backend: "openai-responses",
		upstreamBaseUrl: `${AUTH_BASE_URL}/v1/proxy/openai`,
		reasoning: true,
		thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" },
		contextWindow: 400000,
		maxTokens: 128000,
	},
];

// ---------------------------------------------------------------------------
// PKCE helpers (Web Crypto — available globally on Node 18+)
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generates an RFC 7636 PKCE verifier/challenge pair. Use this when the
 * upstream authorization server requires PKCE — pi's OAuth callbacks do not
 * generate one for you.
 */
async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
	const random = new Uint8Array(32);
	crypto.getRandomValues(random);
	const verifier = base64UrlEncode(random);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

// ---------------------------------------------------------------------------
// Secondary token exchange, cached with a TTL
// ---------------------------------------------------------------------------

interface ProxyToken {
	token: string;
	baseUrl: string;
	expiresAt: number;
}

let cachedProxyToken: ProxyToken | undefined;

/** Drops the cached proxy token so the next request re-exchanges. Call after a refresh. */
export function invalidateProxyToken() {
	cachedProxyToken = undefined;
}

/**
 * Exchanges the long-lived OAuth access token for a short-lived, scoped proxy
 * token. Some gateways require this second hop before every model call; caching
 * it with a TTL keeps the extra round trip off the hot path.
 */
async function getProxyToken(accessToken: string, signal?: AbortSignal): Promise<ProxyToken> {
	if (cachedProxyToken && cachedProxyToken.expiresAt > Date.now()) {
		return cachedProxyToken;
	}

	const response = await fetch(`${AUTH_BASE_URL}/api/v1/direct_access`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
		signal,
	});
	if (!response.ok) {
		throw new Error(`Proxy token exchange failed: ${response.status} ${response.statusText}`);
	}

	// Validate before caching: a malformed body cached for the full TTL would
	// fail every request for 25 minutes with no way to recover short of a restart.
	const payload: unknown = await response.json();
	if (typeof payload !== "object" || payload === null) {
		throw new Error("Proxy token endpoint returned a non-object body");
	}
	const { token, base_url: proxyBaseUrl } = payload as Record<string, unknown>;
	if (typeof token !== "string" || token === "") {
		throw new Error("Proxy token response is missing a usable token");
	}
	if (proxyBaseUrl !== undefined && typeof proxyBaseUrl !== "string") {
		throw new Error("Proxy token response has a non-string base_url");
	}

	cachedProxyToken = {
		token,
		baseUrl: proxyBaseUrl ?? AUTH_BASE_URL,
		expiresAt: Date.now() + PROXY_TOKEN_TTL_MS,
	};
	return cachedProxyToken;
}

// ---------------------------------------------------------------------------
// Delegating streamSimple
// ---------------------------------------------------------------------------

/**
 * Builds the synthetic AssistantMessage used when the request fails before any
 * upstream event was produced — the degenerate "never connected" stream, where
 * a single `error` event is the entire stream.
 */
function connectionErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/**
 * A `streamSimple` that owns auth but not protocol: it performs the proxy-token
 * exchange, then delegates the actual streaming to a *built-in* ProviderStreams
 * implementation chosen per model. This is the middle ground between
 * `native-provider.ts` (one static built-in api for the whole provider) and
 * `stream.ts` (a fully bespoke parser).
 */
export function streamViaGateway(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const spec = GATEWAY_MODELS.find((candidate) => candidate.id === model.id);
	if (!spec) {
		const stream = createAssistantMessageEventStream();
		const error = connectionErrorMessage(model, `Unknown gateway model: ${model.id}`);
		stream.push({ type: "error", reason: "error", error });
		stream.end(error);
		return stream;
	}

	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const accessToken = options?.apiKey;
			if (!accessToken) throw new Error("Gateway provider requires an OAuth access token");

			const proxy = await getProxyToken(accessToken, options?.signal);

			// Rewrite baseUrl per call: the real endpoint is only known after the
			// token exchange, so it cannot be baked into the model config.
			const baseUrl = `${proxy.baseUrl}${new URL(spec.upstreamBaseUrl).pathname}`;
			const upstreamOptions: SimpleStreamOptions = { ...options, apiKey: proxy.token };

			// Branch on the backend so each model is built at its *concrete* api type.
			// `Model<TApi>["compat"]` is a conditional type keyed on TApi, so building
			// both variants under one widened type would erase the compat shape and
			// force a cast; narrowing here lets the compiler verify each one — the
			// `forceAdaptiveThinking` flag below is only valid because this branch is
			// known to be `anthropic-messages`.
			const api = spec.backend === "anthropic-messages" ? anthropicMessagesApi() : openAIResponsesApi();
			const upstreamModel: Model<Api> =
				spec.backend === "anthropic-messages"
					? ({
							...model,
							api: "anthropic-messages",
							baseUrl,
							// Inject compat flags at stream time. Static compat on the model
							// config works too; this shows overriding it for a single request.
							// `Model<TApi>["compat"]` is keyed on `TApi`, and the model arrives as
							// `Model<Api>`, so its compat is the union of every api's shape and
							// cannot be narrowed by `spec.backend`.
							compat: {
								...(model.compat as Model<"anthropic-messages">["compat"]),
								forceAdaptiveThinking: true,
							},
						} satisfies Model<"anthropic-messages">)
					: ({
							...model,
							api: "openai-responses",
							baseUrl,
							compat: undefined,
						} satisfies Model<"openai-responses">);

			for await (const event of api.streamSimple(upstreamModel, context, upstreamOptions)) {
				stream.push(event);
				if (event.type === "done") stream.end(event.message);
				if (event.type === "error") stream.end(event.error);
			}
		} catch (error) {
			const message = connectionErrorMessage(model, error);
			stream.push({ type: "error", reason: "error", error: message });
			stream.end(message);
		}
	})();

	return stream;
}

// ---------------------------------------------------------------------------
// Shared OAuth token plumbing
//
// Both the legacy and canonical auth paths below drive the same PKCE
// authorization-code flow; only the surrounding callback surface differs.
// ---------------------------------------------------------------------------

/** Builds the PKCE authorize URL plus the verifier/state needed to complete it. */
async function beginAuthorization(): Promise<{ url: string; verifier: string; state: string }> {
	const { verifier, challenge } = await createPkcePair();
	const state = crypto.randomUUID();

	const authUrl = new URL(`${AUTH_BASE_URL}/oauth/authorize`);
	authUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
	authUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("state", state);
	authUrl.searchParams.set("code_challenge", challenge);
	authUrl.searchParams.set("code_challenge_method", "S256");

	return { url: authUrl.toString(), verifier, state };
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}

/**
 * Validates an OAuth token response rather than asserting its shape.
 *
 * A `200` with an unexpected body is a real failure mode (error envelopes,
 * proxies, HTML login pages). Casting instead of checking would let a missing
 * `expires_in` become `Date.now() + NaN` — a credential whose expiry never
 * compares true, so it is never refreshed and every later request fails with a
 * misleading auth error far from the actual cause.
 */
function parseTokenResponse(payload: unknown): TokenResponse {
	if (typeof payload !== "object" || payload === null) {
		throw new Error("Token endpoint returned a non-object body");
	}
	const { access_token: access, refresh_token: refresh, expires_in: expires } = payload as Record<string, unknown>;

	if (typeof access !== "string" || access === "") {
		throw new Error("Token response is missing a usable access_token");
	}
	if (typeof expires !== "number" || !Number.isFinite(expires)) {
		throw new Error("Token response is missing a numeric expires_in");
	}
	if (refresh !== undefined && typeof refresh !== "string") {
		throw new Error("Token response has a non-string refresh_token");
	}

	return { access_token: access, expires_in: expires, refresh_token: refresh };
}

/**
 * Extracts `code` from a pasted redirect URL, rejecting a mismatched `state`.
 * Checking `state` is required for a PKCE flow that accepts a pasted URL —
 * PKCE alone proves the client, not the request's origin.
 */
function parseCallbackUrl(pasted: string, expectedState: string): string {
	const callbackUrl = new URL(pasted.trim());
	const code = callbackUrl.searchParams.get("code");
	if (!code) throw new Error("Callback URL contained no ?code parameter");
	if (callbackUrl.searchParams.get("state") !== expectedState) {
		throw new Error("OAuth state mismatch — possible CSRF");
	}
	return code;
}

async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
	const response = await fetch(`${AUTH_BASE_URL}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: OAUTH_CLIENT_ID,
			redirect_uri: OAUTH_REDIRECT_URI,
			code,
			code_verifier: verifier,
		}),
	});
	if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);
	return parseTokenResponse(await response.json());
}

async function exchangeRefreshToken(refresh: string): Promise<TokenResponse> {
	const response = await fetch(`${AUTH_BASE_URL}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			client_id: OAUTH_CLIENT_ID,
			refresh_token: refresh,
		}),
	});
	if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
	return parseTokenResponse(await response.json());
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers a provider whose models are projected from an internal spec: the
 * routing fields (`backend`, `upstreamBaseUrl`) are stripped because they are
 * resolved inside `streamSimple`, and `baseUrl` is a placeholder that the
 * stream rewrites per call.
 */
export function registerDelegatingProvider(pi: ExtensionAPI) {
	const models: ProviderModelConfig[] = GATEWAY_MODELS.map((spec) => ({
		id: spec.id,
		name: spec.name,
		api: GATEWAY_API,
		reasoning: spec.reasoning,
		thinkingLevelMap: spec.thinkingLevelMap,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
	}));

	pi.registerProvider(DELEGATING_PROVIDER_ID, {
		name: "Gateway (Delegating)",
		baseUrl: AUTH_BASE_URL,
		api: GATEWAY_API,
		/**
		 * LEGACY OAuth surface — the `registerProvider(name, config)` form.
		 *
		 * Prefer the canonical `ProviderAuth.oauth` on `createProvider` (see
		 * `registerCanonicalOAuthProvider` below) for new extensions. This shape is
		 * kept working for source compatibility, but differs from the canonical one:
		 *
		 *   - callbacks are a fixed `OAuthLoginCallbacks` object (`onAuth`,
		 *     `onDeviceCode`, `onPrompt`, `onSelect`) rather than the unified
		 *     `AuthInteraction` (`prompt(...)` / `notify(...)`) used by both
		 *     api-key and OAuth flows;
		 *   - `refreshToken` vs. canonical `refresh` (which also receives a signal);
		 *   - `getApiKey` returns a bare string, so per-credential `baseUrl`/headers
		 *     are inexpressible; canonical `toAuth` returns a full `ModelAuth`;
		 *   - `usesCallbackServer` is `@deprecated` outright and ignored;
		 *   - `modifyModels` is documented as a legacy projection hook with no
		 *     canonical counterpart.
		 */
		oauth: {
			name: "Gateway OAuth (PKCE, legacy surface)",

			/**
			 * @deprecated Retained for source compatibility; canonical auth flows
			 * ignore it. Set here only to show the field exists — do not rely on it.
			 */
			usesCallbackServer: false,

			async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				const { url, verifier, state } = await beginAuthorization();

				// Legacy: a dedicated onAuth callback. Canonical uses
				// notify({ type: "auth_url", ... }).
				callbacks.onAuth({
					url,
					instructions: "Approve access, then copy the full URL you land on.",
				});

				// Legacy: onPrompt takes { message } and always returns a string.
				// Canonical uses prompt({ type: "text", message }).
				const pasted = await callbacks.onPrompt({ message: "Paste the callback URL:" });
				const token = await exchangeCode(parseCallbackUrl(pasted, state), verifier);

				invalidateProxyToken();
				return {
					type: "oauth",
					access: token.access_token,
					refresh: token.refresh_token ?? "",
					expires: Date.now() + token.expires_in * 1000,
				};
			},

			/** Legacy name for canonical `refresh`; receives no AbortSignal. */
			async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
				const token = await exchangeRefreshToken(credentials.refresh);
				// The proxy token was minted against the old access token; drop it.
				invalidateProxyToken();
				return {
					type: "oauth",
					access: token.access_token,
					refresh: token.refresh_token ?? credentials.refresh,
					expires: Date.now() + token.expires_in * 1000,
				};
			},

			/**
			 * Legacy: collapses request auth to a single API-key string. The canonical
			 * `toAuth` returns `ModelAuth`, so it can also carry `baseUrl`/`headers`
			 * that vary per credential — which this form cannot express.
			 */
			getApiKey: (credentials: OAuthCredentials) => credentials.access,

			/**
			 * Legacy synchronous credential-dependent model projection. There is no
			 * canonical equivalent; do credential-dependent filtering in
			 * `createProvider`'s `filterModels` instead (see `native-provider.ts`).
			 */
			modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
				void credentials;
				return models;
			},
		},
		models,
		streamSimple: streamViaGateway,
	});
}

export const CANONICAL_PROVIDER_ID = "gateway-generic-canonical";

/**
 * The same PKCE OAuth flow expressed through the canonical `ProviderAuth.oauth`
 * surface on `createProvider` — the form new extensions should use. Compare
 * against the legacy `oauth` block in `registerDelegatingProvider` above:
 *
 *   legacy `login(callbacks)`        -> canonical `login(interaction)`
 *   legacy `onAuth({url})`           -> `interaction.notify({type:"auth_url"})`
 *   legacy `onPrompt({message})`     -> `interaction.prompt({type:"text", ...})`
 *   legacy `onDeviceCode(info)`      -> `interaction.notify({type:"device_code"})`
 *   legacy `onSelect(prompt)`        -> `interaction.prompt({type:"select", ...})`
 *   legacy `refreshToken(creds)`     -> `refresh(credential, signal)`
 *   legacy `getApiKey(creds): string`-> `toAuth(credential): Promise<ModelAuth>`
 *
 * `toAuth` is the substantive upgrade: it returns a full `ModelAuth`, so a
 * per-credential `baseUrl` or `headers` is expressible. Here that removes the
 * need to rewrite `baseUrl` inside `streamSimple` for the auth-derived part.
 */
export function registerCanonicalOAuthProvider(pi: ExtensionAPI) {
	const provider = createProvider({
		id: CANONICAL_PROVIDER_ID,
		name: "Gateway (Canonical OAuth)",
		baseUrl: AUTH_BASE_URL,
		auth: {
			oauth: {
				name: "Gateway OAuth (PKCE, canonical)",
				loginLabel: "Sign in with your Gateway account",

				async login(interaction): Promise<OAuthCredential> {
					const { url, verifier, state } = await beginAuthorization();

					// Canonical: one `notify` channel for every out-of-band event, so
					// auth_url / device_code / info / progress share a single surface.
					interaction.notify({
						type: "auth_url",
						url,
						instructions: "Approve access, then copy the full URL you land on.",
					});

					// Canonical: one typed `prompt` for text/secret/select/manual_code.
					// `AuthPrompt.signal` can cancel this single prompt without aborting
					// the whole login — e.g. when a callback server wins the race.
					const pasted = await interaction.prompt({
						type: "text",
						message: "Paste the callback URL:",
						signal: interaction.signal,
					});

					interaction.notify({ type: "progress", message: "Exchanging authorization code..." });
					const token = await exchangeCode(parseCallbackUrl(pasted, state), verifier);

					invalidateProxyToken();
					return {
						type: "oauth",
						access: token.access_token,
						refresh: token.refresh_token ?? "",
						expires: Date.now() + token.expires_in * 1000,
					};
				},

				// Canonical `refresh` receives a signal and runs under the credential
				// store lock, so concurrent requests cannot double-refresh a token.
				async refresh(credential, signal): Promise<OAuthCredential> {
					void signal;
					const token = await exchangeRefreshToken(credential.refresh);
					invalidateProxyToken();
					return {
						type: "oauth",
						access: token.access_token,
						refresh: token.refresh_token ?? credential.refresh,
						expires: Date.now() + token.expires_in * 1000,
					};
				},

				// Side-effect-free: derives request auth from an already-valid
				// credential. Unlike legacy `getApiKey`, this can carry baseUrl/headers.
				async toAuth(credential) {
					return {
						apiKey: credential.access,
						headers: { "x-gateway-client": "ppie-custom-provider-example" },
					};
				},
			},
		},
		models: GATEWAY_MODELS.map((spec) => ({
			id: spec.id,
			name: spec.name,
			provider: CANONICAL_PROVIDER_ID,
			api: GATEWAY_API,
			baseUrl: spec.upstreamBaseUrl,
			reasoning: spec.reasoning,
			thinkingLevelMap: spec.thinkingLevelMap,
			input: ["text", "image"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: spec.contextWindow,
			maxTokens: spec.maxTokens,
		})),
		api: { stream: streamViaGateway, streamSimple: streamViaGateway },
	});

	pi.registerProvider(provider);
}
