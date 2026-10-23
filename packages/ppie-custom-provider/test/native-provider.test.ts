import type {
	AuthPrompt,
	Model,
	ModelsPublication,
	ModelsStoreEntry,
	OAuthCredential,
	ProviderAuthInteraction,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type OpenAIProviderConfig } from "../src/config.ts";
import { PRIME_TIMEOUT_MS } from "../src/models.ts";
import {
	BASE_URL_ENV_VAR,
	createOpenAIProvider,
	createOpenAIProviderController,
	NATIVE_PROVIDER_ID,
	SERVER_URL_FIELD,
} from "../src/native-provider.ts";

/**
 * These drive the real provider object pi would receive. `fetch` is stubbed
 * because the seam under test is the provider's own guard logic and catalog
 * mapping, not HTTP itself.
 */

function config(overrides: Partial<OpenAIProviderConfig> = {}): OpenAIProviderConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * A working stand-in for pi's generation-checked `publish`, which replaced the
 * old `store` handle. It mirrors the two behaviours the provider depends on:
 * `persist` records the entry, and `update` runs only when the publication is
 * accepted — so a provider that ignores the return value cannot pass silently.
 *
 * `accept: false` models a refresh superseded by a newer one.
 */
function createPublisher(accept = true) {
	const state = {
		entry: undefined as ModelsStoreEntry | undefined,
		publications: 0,
		publish: async (publication: ModelsPublication): Promise<boolean> => {
			state.publications += 1;
			if (!accept) return false;
			if (publication.persist) state.entry = publication.persist;
			publication.update?.();
			return true;
		},
	};
	return state;
}

/** Most cases start empty; the persistence tests assert on `entry` afterwards. */
let publisher: ReturnType<typeof createPublisher>;

/** The context pi passes, with only the fields a test varies overridden. */
function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	return {
		allowNetwork: true,
		publish: publisher.publish,
		signal: new AbortController().signal,
		...overrides,
	};
}

function storedModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: NATIVE_PROVIDER_ID,
		baseUrl: DEFAULT_CONFIG.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function credential(serverUrl?: string, key?: string): OAuthCredential {
	return {
		type: "oauth",
		access: key ?? "",
		refresh: "",
		expires: 8640000000000000,
		...(serverUrl === undefined ? {} : { [SERVER_URL_FIELD]: serverUrl }),
	};
}

function modelsResponse(models: unknown[]): Response {
	return new Response(JSON.stringify({ data: models }), { status: 200 });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	delete process.env[BASE_URL_ENV_VAR];
	publisher = createPublisher();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("refreshModels", () => {
	it("makes no network request when the network is disallowed", async () => {
		const provider = createOpenAIProvider(config());

		await provider.refreshModels?.(refreshContext({ allowNetwork: false }));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(provider.getModels?.()).toEqual([]);
	});

	// pi's cold start runs an offline, cache-only pass before any credential is
	// resolved. A provider that returns early there reports an empty catalog and
	// never appears in `--list-models` or the /login picker.
	it("restores the persisted catalog on the offline pass", async () => {
		const provider = createOpenAIProvider(config());
		await provider.refreshModels?.(
			refreshContext({ allowNetwork: false, stored: { models: [storedModel("cached-model")], checkedAt: 1 } }),
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(provider.getModels?.().map((model) => model.id)).toEqual(["cached-model"]);
	});

	it("ignores stored entries belonging to another provider", async () => {
		const provider = createOpenAIProvider(config());
		await provider.refreshModels?.(
			refreshContext({
				allowNetwork: false,
				stored: { models: [{ ...storedModel("foreign"), provider: "some-other-provider" }], checkedAt: 1 },
			}),
		);

		expect(provider.getModels?.()).toEqual([]);
	});

	it("persists the fetched catalog so the next cold start has one", async () => {
		const provider = createOpenAIProvider(config());
		fetchMock.mockImplementation(async () => modelsResponse([{ id: "fetched-model" }]));

		await provider.refreshModels?.(
			refreshContext({ allowNetwork: true, credential: credential("http://server:1234/v1") }),
		);

		expect(publisher.entry?.models.map((model) => model.id)).toEqual(["fetched-model"]);
	});

	it("does not persist a catalog the caller aborted mid-fetch", async () => {
		const provider = createOpenAIProvider(config());
		const controller = new AbortController();
		fetchMock.mockImplementation(async () => {
			controller.abort();
			return modelsResponse([{ id: "fetched-model" }]);
		});

		await provider.refreshModels?.(refreshContext({ allowNetwork: true, signal: controller.signal }));

		expect(publisher.entry).toBeUndefined();
	});

	it("makes no network request once the caller has aborted", async () => {
		const provider = createOpenAIProvider(config());
		const controller = new AbortController();
		controller.abort();

		await provider.refreshModels?.(refreshContext({ allowNetwork: true, signal: controller.signal }));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("makes no network request when discovery is disabled in config", async () => {
		const provider = createOpenAIProvider(config({ discovery: { enabled: false, path: "/models" } }));

		await provider.refreshModels?.(refreshContext({ allowNetwork: true }));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	// Regression: pi refreshes before the user has logged in. Probing the default
	// server URL there fails against a port nobody is listening on, surfacing
	// "Could not refresh ...; showing cached models" before /login was ever run.
	it("contacts no server before the user has logged in", async () => {
		const provider = createOpenAIProvider(config());

		await provider.refreshModels?.(refreshContext({ allowNetwork: true }));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("contacts no server when the credential carries no server URL", async () => {
		const provider = createOpenAIProvider(config());

		await provider.refreshModels?.(refreshContext({ allowNetwork: true, credential: credential() }));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps the cached catalog intact when refreshing without a credential", async () => {
		const provider = createOpenAIProvider(config());
		await provider.refreshModels?.(
			refreshContext({ allowNetwork: true, stored: { models: [storedModel("cached-model")], checkedAt: 1 } }),
		);

		expect(provider.getModels?.().map((model) => model.id)).toEqual(["cached-model"]);
	});

	it("populates the catalog from the server listing", async () => {
		fetchMock.mockResolvedValue(modelsResponse([{ id: "a", name: "Model A", context_window: 8192 }]));
		const provider = createOpenAIProvider(config());

		await provider.refreshModels?.(
			refreshContext({ allowNetwork: true, credential: credential("http://server:1234/v1") }),
		);

		expect(provider.getModels?.()).toEqual([
			expect.objectContaining({ id: "a", name: "Model A", contextWindow: 8192, maxTokens: 8192 }),
		]);
	});

	it("prefers the server URL stored with the credential over the config default", async () => {
		fetchMock.mockResolvedValue(modelsResponse([]));
		const provider = createOpenAIProvider(config());

		await provider.refreshModels?.(
			refreshContext({
				credential: credential("http://stored:9999/v1"),
			}),
		);

		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://stored:9999/v1/models");
	});

	it("sends the stored key as a bearer token, and no header without one", async () => {
		// A Response body can only be read once, so build a fresh one per call.
		fetchMock.mockImplementation(async () => modelsResponse([]));
		const provider = createOpenAIProvider(config());

		await provider.refreshModels?.(
			refreshContext({
				credential: credential("http://server:1234/v1", "secret"),
			}),
		);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: "Bearer secret" } });

		fetchMock.mockClear();
		await provider.refreshModels?.(
			refreshContext({ allowNetwork: true, credential: credential("http://server:1234/v1") }),
		);
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toBeUndefined();
	});

	it("surfaces a failed discovery rather than silently serving an empty catalog", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 500, statusText: "Server Error" }));
		const provider = createOpenAIProvider(config());

		await expect(
			provider.refreshModels?.(
				refreshContext({ allowNetwork: true, credential: credential("http://server:1234/v1") }),
			),
		).rejects.toThrow(/500/);
	});

	/**
	 * pi keeps the thrown error but renders only the provider id, so every failure
	 * reads "Could not refresh ppie-custom-provider; showing cached models." These
	 * cover the reporting seam that makes the three causes distinguishable.
	 */
	describe("discovery failure reporting", () => {
		it("reports the server's own error message, not just the status code", async () => {
			const reported: string[] = [];
			fetchMock.mockResolvedValue(
				new Response(JSON.stringify({ error: { message: "model not loaded" } }), { status: 503 }),
			);
			const provider = createOpenAIProvider(config(), (message) => reported.push(message));

			await expect(
				provider.refreshModels?.(
					refreshContext({ allowNetwork: true, credential: credential("http://server:1234/v1") }),
				),
			).rejects.toThrow();

			expect(reported).toEqual(["Discovery failed for http://server:1234/v1/models: model not loaded"]);
		});

		// The symptom that started this: a server that is simply not running. `fetch`
		// reports it as an opaque `TypeError: fetch failed` with the real reason in
		// `cause`, which is what the user needs to see.
		it("unwraps the transport cause a bare fetch failure hides", async () => {
			const reported: string[] = [];
			fetchMock.mockRejectedValue(
				Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED 127.0.0.1:8008") }),
			);
			const provider = createOpenAIProvider(config(), (message) => reported.push(message));

			await expect(
				provider.refreshModels?.(
					refreshContext({ allowNetwork: true, credential: credential("http://localhost:8008/v1") }),
				),
			).rejects.toThrow();

			expect(reported[0]).toContain("connect ECONNREFUSED 127.0.0.1:8008");
		});

		it("names the deadline when the server never answers", async () => {
			const reported: string[] = [];
			fetchMock.mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }));
			const provider = createOpenAIProvider(config(), (message) => reported.push(message));

			await expect(
				provider.refreshModels?.(
					refreshContext({ allowNetwork: true, credential: credential("http://server:1234/v1") }),
				),
			).rejects.toThrow();

			expect(reported[0]).toContain("No response within 15s");
		});

		// The rejection is load-bearing: it is what makes pi keep the cached catalog
		// instead of publishing an empty one. Reporting must not consume it.
		it("still rejects, and keeps the cached catalog, after reporting", async () => {
			fetchMock.mockRejectedValue(new Error("boom"));
			const provider = createOpenAIProvider(config(), () => {});

			await expect(
				provider.refreshModels?.(
					refreshContext({
						credential: credential("http://server:1234/v1"),
						stored: { models: [storedModel("cached-model")], checkedAt: 1 },
					}),
				),
			).rejects.toThrow(/boom/);

			// The restore published before the fetch failed, so the cached catalog is
			// what pi keeps serving.
			expect(provider.getModels?.().map((model) => model.id)).toEqual(["cached-model"]);
		});

		// Closing the /model picker aborts the refresh; that is the user's own doing
		// and must not write a failure line on every dismissal.
		it("reports nothing when the caller aborted the refresh", async () => {
			const reported: string[] = [];
			const controller = new AbortController();
			fetchMock.mockImplementation(async () => {
				controller.abort();
				throw new Error("aborted");
			});
			const provider = createOpenAIProvider(config(), (message) => reported.push(message));

			await expect(
				provider.refreshModels?.(
					refreshContext({
						signal: controller.signal,
						credential: credential("http://server:1234/v1"),
					}),
				),
			).rejects.toThrow();

			expect(reported).toEqual([]);
		});

		it("works without a sink, so the provider stays usable unwired", async () => {
			fetchMock.mockRejectedValue(new Error("boom"));
			const provider = createOpenAIProvider(config());

			await expect(
				provider.refreshModels?.(
					refreshContext({ allowNetwork: true, credential: credential("http://server:1234/v1") }),
				),
			).rejects.toThrow(/boom/);
		});
	});

	it("leaves compat unset so pi's own detection runs", async () => {
		fetchMock.mockResolvedValue(modelsResponse([{ id: "a" }]));
		const provider = createOpenAIProvider(config());

		await provider.refreshModels?.(refreshContext({ allowNetwork: true }));

		expect(provider.getModels?.()[0]?.compat).toBeUndefined();
	});

	it("applies user-supplied compat overrides when configured", async () => {
		fetchMock.mockResolvedValue(modelsResponse([{ id: "a" }]));
		const provider = createOpenAIProvider(config({ compat: { supportsStore: false } }));

		await provider.refreshModels?.(
			refreshContext({ allowNetwork: true, credential: credential("http://server:1234/v1") }),
		);

		expect(provider.getModels?.()[0]?.compat).toEqual({ supportsStore: false });
	});
});

/**
 * pi fires its cache-only refresh as `void this.refresh(...)` from
 * `registerNativeProvider` and resolves `enabledModels` before that settles, so a
 * catalog filled only by `refreshModels` is empty when the warnings are computed.
 * Priming closes that window from inside the extension factory, which pi *does*
 * await.
 */
describe("prime", () => {
	it("populates the catalog before the provider is registered", async () => {
		fetchMock.mockResolvedValue(modelsResponse([{ id: "gemma-sas" }, { id: "carnice" }]));
		const { provider, prime } = createOpenAIProviderController(config(), undefined, () =>
			credential("http://server:1234/v1", "sk-test"),
		);

		expect(provider.getModels?.()).toEqual([]);
		await prime();

		expect(provider.getModels?.().map((model) => model.id)).toEqual(["gemma-sas", "carnice"]);
	});

	it("sends the stored key, so a server that requires one still answers", async () => {
		fetchMock.mockResolvedValue(modelsResponse([]));
		const { prime } = createOpenAIProviderController(config(), undefined, () =>
			credential("http://server:1234/v1", "sk-test"),
		);

		await prime();

		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://server:1234/v1/models");
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: "Bearer sk-test" } });
	});

	it("contacts nothing when no credential is stored", async () => {
		const { prime } = createOpenAIProviderController(config(), undefined, () => undefined);

		await prime();

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("contacts nothing when the credential carries no server URL", async () => {
		const { prime } = createOpenAIProviderController(config(), undefined, () => credential());

		await prime();

		expect(fetchMock).not.toHaveBeenCalled();
	});

	// The factory is awaited by pi before startup continues, so a throw here would
	// fail the whole extension over an optimization.
	it("resolves rather than throwing when discovery fails", async () => {
		fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8008"));
		const reported: string[] = [];
		const { provider, prime } = createOpenAIProviderController(
			config(),
			(message) => reported.push(message),
			() => credential("http://localhost:8008/v1"),
		);

		await expect(prime()).resolves.toBeUndefined();

		expect(provider.getModels?.()).toEqual([]);
		expect(reported[0]).toContain("Startup discovery failed");
		expect(reported[0]).toContain("connect ECONNREFUSED 127.0.0.1:8008");
	});

	it("bounds the wait well inside the budget pi allows for scope resolution", async () => {
		fetchMock.mockResolvedValue(modelsResponse([]));
		const { prime } = createOpenAIProviderController(config(), undefined, () => credential("http://server:1234/v1"));

		await prime();

		const signal = (fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined)?.signal;
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(PRIME_TIMEOUT_MS).toBeLessThan(15_000);
	});
});

describe("login", () => {
	// `ProviderAuthInteraction` is `AuthInteraction & { signal: AbortSignal }`: pi
	// always supplies a concrete signal to provider login flows.
	function interaction(answers: string[]): { interaction: ProviderAuthInteraction; prompts: AuthPrompt[] } {
		const prompts: AuthPrompt[] = [];
		let index = 0;
		return {
			prompts,
			interaction: {
				signal: new AbortController().signal,
				prompt: async (prompt: AuthPrompt) => {
					prompts.push(prompt);
					return answers[index++] ?? "";
				},
				notify: () => {},
			},
		};
	}

	// The provider offers subscription-style login only: one flow collecting both
	// the server URL and an optional key, rather than pi's bare api-key prompt.
	it("is registered as a subscription login, not an api-key login", () => {
		const provider = createOpenAIProvider(config());

		expect(provider.auth.oauth).toBeDefined();
		expect(provider.auth.apiKey).toBeUndefined();
	});

	it("asks for a server URL and then a key, and stores both", async () => {
		const provider = createOpenAIProvider(config());
		const { interaction: auth, prompts } = interaction(["http://entered:1234/v1", "sk-test"]);

		const stored = await provider.auth.oauth?.login?.(auth);

		expect(prompts.map((prompt) => prompt.type)).toEqual(["text", "secret"]);
		expect(stored).toMatchObject({
			type: "oauth",
			access: "sk-test",
			[SERVER_URL_FIELD]: "http://entered:1234/v1",
		});
	});

	it("performs no validation request against the entered URL", async () => {
		const provider = createOpenAIProvider(config());
		const { interaction: auth } = interaction(["http://not-running-yet:1234/v1", ""]);

		await provider.auth.oauth?.login?.(auth);

		// The user may be configuring a server that is not up yet; probing it would
		// reject a valid setup.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back to the configured URL when the user submits an empty prompt", async () => {
		const provider = createOpenAIProvider(config({ baseUrl: "http://from-config:1234/v1" }));
		const { interaction: auth, prompts } = interaction(["  ", ""]);

		const stored = await provider.auth.oauth?.login?.(auth);

		expect(prompts[0]).toMatchObject({ placeholder: "http://from-config:1234/v1" });
		expect(stored?.[SERVER_URL_FIELD]).toBe("http://from-config:1234/v1");
	});

	it("stores an empty key when the user leaves the secret prompt empty", async () => {
		const provider = createOpenAIProvider(config());
		const { interaction: auth } = interaction(["http://local:1234/v1", "   "]);

		expect((await provider.auth.oauth?.login?.(auth))?.access).toBe("");
	});

	// There is no authorization server behind a generic endpoint, so the stored
	// credential must never expire into a refresh pi cannot perform.
	it("stores a credential that never expires into a refresh", async () => {
		const provider = createOpenAIProvider(config());
		const { interaction: auth } = interaction(["http://local:1234/v1", ""]);

		const stored = await provider.auth.oauth?.login?.(auth);

		expect(stored?.expires).toBeGreaterThan(Date.now());
	});

	it("returns the credential unchanged from refresh", async () => {
		const provider = createOpenAIProvider(config());
		const stored = credential("http://local:1234/v1", "sk-test");

		expect(await provider.auth.oauth?.refresh?.(stored, new AbortController().signal)).toEqual(stored);
	});
});

describe("toAuth", () => {
	it("uses the server URL stored with the credential", async () => {
		const provider = createOpenAIProvider(config());

		const auth = await provider.auth.oauth?.toAuth(credential("http://stored:9999/v1", "sk-stored"));

		expect(auth).toMatchObject({ apiKey: "sk-stored", baseUrl: "http://stored:9999/v1" });
	});

	it("falls back to the configured URL when the credential carries none", async () => {
		const provider = createOpenAIProvider(config({ baseUrl: "http://configured:1234/v1" }));

		const auth = await provider.auth.oauth?.toAuth(credential(undefined, "sk-stored"));

		expect(auth?.baseUrl).toBe("http://configured:1234/v1");
	});

	// A blank key means the server wants no Authorization header; sending a
	// placeholder bearer would break servers that reject unknown tokens.
	it("omits the key entirely when the user stored none", async () => {
		const provider = createOpenAIProvider(config());

		const auth = await provider.auth.oauth?.toAuth(credential("http://local:1234/v1"));

		expect(auth?.apiKey).toBeUndefined();
		expect(auth?.baseUrl).toBe("http://local:1234/v1");
	});
});
