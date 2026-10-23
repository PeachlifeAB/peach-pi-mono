import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/**
 * One model per remaining `Api` value, carrying that API's compat flags.
 *
 * `api` is a per-model field on `ProviderModelConfig`, so a single provider can
 * span every API type — the gateway proxies each upstream protocol under its
 * own model id. Between these entries, `AnthropicMessagesCompat`,
 * `OpenAIResponsesCompat` and `BedrockCompat` are covered in full.
 */
export const examplePerApiModels: ProviderModelConfig[] = [
	{
		id: "gateway-anthropic",
		name: "Gateway → Anthropic Messages",
		api: "anthropic-messages",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 16384,
		compat: {
			supportsEagerToolInputStreaming: true,
			supportsLongCacheRetention: true,
			sendSessionAffinityHeaders: true,
			supportsCacheControlOnTools: true,
			supportsTemperature: false,
			// Upstream requires thinking.type "adaptive" plus output_config.effort.
			forceAdaptiveThinking: true,
			// Only for providers that emit empty thinking signatures.
			allowEmptySignature: true,
			supportsStrictTools: true,
		},
	},
	{
		id: "gateway-openai-responses",
		name: "Gateway → OpenAI Responses",
		api: "openai-responses",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
		contextWindow: 200000,
		maxTokens: 16384,
		compat: {
			supportsDeveloperRole: true,
			sessionAffinityFormat: "openai-nosession",
			supportsLongCacheRetention: true,
			supportsStrictMode: true,
			supportsOpenAIGrammarTools: true,
			supportsToolSearch: true,
			supportsExplicitPromptCacheMode: true,
		},
	},
	{
		id: "gateway-azure-responses",
		name: "Gateway → Azure OpenAI Responses",
		api: "azure-openai-responses",
		reasoning: true,
		input: ["text"],
		cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
		contextWindow: 128000,
		maxTokens: 8192,
		compat: { sessionAffinityFormat: "openrouter", supportsStrictMode: false },
	},
	{
		id: "gateway-codex-responses",
		name: "Gateway → OpenAI Codex Responses",
		api: "openai-codex-responses",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 1.9 },
		contextWindow: 200000,
		maxTokens: 16384,
		compat: { supportsDeveloperRole: false },
	},
	{
		id: "gateway-mistral",
		name: "Gateway → Mistral Conversations",
		api: "mistral-conversations",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.4, output: 2, cacheRead: 0.04, cacheWrite: 0.5 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
	{
		id: "gateway-google",
		name: "Gateway → Google Generative AI",
		api: "google-generative-ai",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.25, output: 5, cacheRead: 0.31, cacheWrite: 1.6 },
		contextWindow: 1000000,
		maxTokens: 8192,
	},
	{
		id: "gateway-vertex",
		name: "Gateway → Google Vertex AI",
		api: "google-vertex",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.25, output: 5, cacheRead: 0.31, cacheWrite: 1.6 },
		contextWindow: 1000000,
		maxTokens: 8192,
	},
	{
		id: "gateway-bedrock",
		name: "Gateway → Amazon Bedrock Converse",
		api: "bedrock-converse-stream",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 16384,
		compat: { supportsStrictMode: true },
	},
];
