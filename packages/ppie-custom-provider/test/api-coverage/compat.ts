import type { Api, Model } from "@earendil-works/pi-ai";

type ModelCompat = NonNullable<Model<Api>["compat"]>;

/**
 * Compat flags a gateway might need, covering the OpenAI-completions surface.
 *
 * Note `Model<Api>["compat"]` is a conditional type over the union `Api`, so it
 * distributes into a union of *all* compat
 * shapes rather than narrowing by `api`. Anthropic/Bedrock-only flags are
 * therefore accepted here too; they are set on the dedicated per-API models
 * below, where they actually mean something at runtime.
 *
 * A real provider must NOT ship a blanket block like this: pi derives these
 * flags from provider id and base URL and already handles ten hosted gateways.
 * Setting them unconditionally overrides that detection for all of them. See
 * docs/adr/adr-0001-defer-to-pi-defaults-over-extension-constants.md.
 */
export const exampleBaseCompat: ModelCompat = {
	// Request-shape quirks.
	supportsStore: false, // gateway rejects the OpenAI `store` field
	supportsDeveloperRole: false, // use "system" instead of "developer"
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true, // stream_options: { include_usage: true }
	supportsStrictMode: false, // gateway ignores `strict` in tool definitions
	supportsOpenAIGrammarTools: false, // fall back to normal function tools
	maxTokensField: "max_tokens", // instead of "max_completion_tokens"

	// Message-replay quirks.
	requiresToolResultName: true, // tool results need a `name` field
	requiresAssistantAfterToolResult: true, // insert assistant turn between tool result and user
	requiresThinkingAsText: false, // keep native thinking blocks, don't inline as <thinking>
	requiresReasoningContentOnAssistantMessages: false,

	// Caching and session affinity.
	cacheControlFormat: "anthropic", // Anthropic-style cache_control markers
	sessionAffinityFormat: "openai", // session_id + x-client-request-id + x-session-affinity
	sendSessionAffinityHeaders: true,
	supportsLongCacheRetention: true, // prompt_cache_retention: "24h"

	// Routing preferences, forwarded when the endpoint is an OpenRouter/Vercel gateway.
	openRouterRouting: {
		allow_fallbacks: true,
		require_parameters: false,
		data_collection: "deny",
		zdr: true,
		order: ["openai", "together"],
	},
	vercelGatewayRouting: {
		order: ["openai", "anthropic"],
	},

	// z.ai top-level tool_stream.
	zaiToolStream: true,
};

/**
 * One entry per `thinkingFormat`. The format is single-valued per model, so
 * covering all ten documented values requires ten variants off one upstream id.
 */
export const exampleThinkingVariants: { suffix: string; label: string; compat: ModelCompat }[] = [
	{ suffix: "openai", label: "reasoning_effort", compat: { thinkingFormat: "openai" } },
	{ suffix: "openrouter", label: "reasoning: { effort }", compat: { thinkingFormat: "openrouter" } },
	{
		suffix: "deepseek",
		label: "thinking: { type } + reasoning_effort",
		compat: { thinkingFormat: "deepseek" },
	},
	{ suffix: "together", label: "reasoning: { enabled }", compat: { thinkingFormat: "together" } },
	{ suffix: "zai", label: "thinking: { type }", compat: { thinkingFormat: "zai" } },
	{ suffix: "qwen", label: "top-level enable_thinking", compat: { thinkingFormat: "qwen" } },
	{
		suffix: "qwen-chat-template",
		label: "chat_template_kwargs.enable_thinking + preserve_thinking",
		compat: { thinkingFormat: "qwen-chat-template" },
	},
	{
		suffix: "chat-template",
		label: "configurable chat_template_kwargs",
		compat: {
			// e.g. DeepSeek V3.x behind vLLM.
			thinkingFormat: "chat-template",
			chatTemplateKwargs: {
				thinking: { $var: "thinking.enabled" },
				thinking_effort: { $var: "thinking.effort", omitWhenOff: true },
				// Literal kwarg values are supported alongside the pi-controlled `$var` forms.
				preserve_thinking: true,
				max_thinking_tokens: 2048,
				thinking_tag: "think",
				disable_marker: null,
			},
		},
	},
	{
		suffix: "string-thinking",
		label: "top-level thinking: string",
		compat: { thinkingFormat: "string-thinking" },
	},
	{
		suffix: "ant-ling",
		label: "reasoning: { effort } when non-null",
		compat: { thinkingFormat: "ant-ling" },
	},
];
