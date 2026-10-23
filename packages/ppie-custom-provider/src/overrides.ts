import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The "Override Existing Provider" form: `registerProvider` called with a
 * config that omits `models`, so all existing models for that provider are
 * preserved and only the endpoint/headers change.
 *
 * Enabled by PI_OPENAI_PROVIDER_ENABLE_OVERRIDES so the example does not silently
 * reroute real provider traffic when the extension is loaded.
 */
export function registerProviderOverrides(pi: ExtensionAPI) {
	if (process.env.PI_OPENAI_PROVIDER_ENABLE_OVERRIDES !== "1") return;

	// baseUrl only — every Anthropic model keeps working, through the proxy.
	pi.registerProvider("anthropic", {
		baseUrl: "https://proxy.example.com",
	});

	// headers only — endpoint unchanged, extra header on every OpenAI request.
	pi.registerProvider("openai", {
		headers: {
			"X-Custom-Header": "value",
		},
	});

	// Both baseUrl and headers, with an env-var header value.
	pi.registerProvider("google", {
		baseUrl: "https://ai-gateway.corp.com/google",
		headers: {
			"X-Corp-Auth": "$CORP_AUTH_TOKEN",
		},
	});
}
