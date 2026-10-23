import type { Model, ModelsPublication, OAuthCredential, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type OpenAIProviderConfig } from "../src/config.ts";
import { registerLegacyProvider } from "../src/legacy-provider.ts";

const LEGACY_PROVIDER_ID = "openai-generic";

type MessageHandler = (event: unknown, ctx: unknown) => unknown;
type LegacyRegistration = { refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> };

function storedModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: LEGACY_PROVIDER_ID,
		baseUrl: DEFAULT_CONFIG.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 4096,
	};
}

function harness(config: OpenAIProviderConfig = DEFAULT_CONFIG) {
	const handlers = new Map<string, MessageHandler[]>();
	let registered: unknown;
	const pi = {
		registerProvider(_id: string, provider: unknown) {
			registered = provider;
		},
		on(event: string, handler: MessageHandler) {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
	} as unknown as ExtensionAPI;
	registerLegacyProvider(pi, config);
	return {
		provider: registered as LegacyRegistration,
		handler(event: string): MessageHandler {
			const handler = handlers.get(event)?.[0];
			if (!handler) throw new Error(`Missing ${event} handler`);
			return handler;
		},
	};
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	return {
		allowNetwork: true,
		publish: async (_publication: ModelsPublication) => true,
		signal: new AbortController().signal,
		...overrides,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("legacy provider refresh", () => {
	it("restores cached models offline and only persists a successful online refresh", async () => {
		const registration = harness();
		const cached = storedModel("cached");
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ data: [{ id: "fresh", context_window: 8192 }] })),
		);
		vi.stubGlobal("fetch", fetchMock);

		const restored = await registration.provider.refreshModels(
			refreshContext({ allowNetwork: false, stored: { models: [cached], checkedAt: 1 } }),
		);
		expect(restored).toMatchObject([{ id: "cached", api: "openai-completions" }]);
		expect(fetchMock).not.toHaveBeenCalled();

		let persisted: ModelsPublication | undefined;
		const fetched = await registration.provider.refreshModels(
			refreshContext({
				credential: { type: "oauth", access: "", refresh: "", expires: 8640000000000000 } as OAuthCredential,
				publish: async (publication) => {
					persisted = publication;
					return true;
				},
			}),
		);
		expect(fetched).toMatchObject([{ id: "fresh", contextWindow: 8192 }]);
		expect(persisted?.persist?.models).toMatchObject([
			{ id: "fresh", provider: LEGACY_PROVIDER_ID, baseUrl: DEFAULT_CONFIG.baseUrl },
		]);
	});

	it("keeps cached data and skips discovery for missing credentials, disabled discovery, or abort", async () => {
		const cached = storedModel("cached");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const registration = harness();
		const stored = { models: [cached], checkedAt: 1 };

		for (const context of [refreshContext({ stored }), refreshContext({ stored, signal: AbortSignal.abort() })]) {
			expect(await registration.provider.refreshModels(context)).toMatchObject([{ id: "cached" }]);
		}

		const disabled = harness({ ...DEFAULT_CONFIG, discovery: { ...DEFAULT_CONFIG.discovery, enabled: false } });
		expect(await disabled.provider.refreshModels(refreshContext({ stored }))).toMatchObject([{ id: "cached" }]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rewrites only matching legacy-provider overflow errors and remains idempotent", () => {
		const registration = harness({ ...DEFAULT_CONFIG, overflowPattern: "custom memory cap" });
		const handler = registration.handler("message_end");
		const context = { model: { provider: LEGACY_PROVIDER_ID } };
		const invoke = (message: Record<string, unknown>, ctx: unknown = context) => handler({ message }, ctx);

		expect(invoke({ role: "user", stopReason: "error", errorMessage: "custom memory cap" })).toBeUndefined();
		expect(invoke({ role: "assistant", stopReason: "stop", provider: LEGACY_PROVIDER_ID })).toBeUndefined();
		expect(
			invoke({ role: "assistant", stopReason: "error", provider: "other", errorMessage: "no match" }, {}),
		).toBeUndefined();
		expect(
			invoke({
				role: "assistant",
				stopReason: "error",
				provider: LEGACY_PROVIDER_ID,
				errorMessage: "context_length_exceeded: custom memory cap",
			}),
		).toBeUndefined();
		expect(
			invoke({ role: "assistant", stopReason: "error", provider: "other", errorMessage: "custom memory cap" }),
		).toMatchObject({
			message: { errorMessage: "context_length_exceeded: custom memory cap" },
		});
	});
});
