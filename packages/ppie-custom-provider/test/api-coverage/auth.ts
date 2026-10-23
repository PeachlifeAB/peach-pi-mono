import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

/**
 * The legacy `oauth` callback surface on `ProviderConfig`.
 *
 * The real provider deliberately ships API-key auth only, following pi's own
 * bundled llama.cpp extension: a provider pointing at an arbitrary
 * OpenAI-compatible endpoint has no authorization server to talk to, and
 * inventing endpoints would produce a login flow that cannot succeed.
 *
 * Note the absent device-code polling. The original demo drove a
 * sleep-and-retry loop until an expiry deadline; that pattern is ruled out by
 * docs/adr/adr-0003-reactive-discovery-no-timeouts-no-polling.md.
 */
export const exampleOAuthConfig: NonNullable<ProviderConfig["oauth"]> = {
	name: "OpenAI-Compatible Gateway (SSO)",
	async login(callbacks) {
		const method = await callbacks.onSelect({
			message: "Select login method:",
			options: [
				{ id: "browser", label: "Browser OAuth" },
				{ id: "device", label: "Device code" },
			],
		});
		if (!method) throw new Error("Login cancelled");

		callbacks.onAuth({ url: "https://gateway.example.com/oauth/authorize" });
		const code = await callbacks.onPrompt({ message: "Paste the code from the gateway login page:" });

		return {
			refresh: `refresh-${code}`,
			access: `access-${code}`,
			expires: Date.now() + 3600_000,
		};
	},
	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return {
			refresh: credentials.refresh,
			access: `access-${Date.now()}`,
			expires: Date.now() + 3600_000,
		};
	},
	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
	// Credential-dependent model projection: hide premium variants until the
	// stored credential says the account is entitled to them.
	modifyModels(models, credentials) {
		return credentials.tier === "premium" ? models : models.filter((model) => !model.id.endsWith(":ant-ling"));
	},
};

/**
 * Provider-level config-value syntax, for reference.
 *
 * `$VAR`/`${VAR}` interpolate env vars, a leading `!command` runs a command for
 * the whole value, `$$` is a literal `$` and `$!` a literal `!`. pi resolves
 * these at request time.
 *
 * The real provider does not ship headers: `models.json` already owns them, and
 * duplicating that surface in an extension competes with core. See
 * docs/adr/adr-0002-extension-configuration-sidecar-file.md.
 */
export const exampleHeaders: Record<string, string> = {
	"X-Client-Id": "ppie-custom-provider-example",
	// `!command` form: the whole value is produced by running the command.
	"X-Signing-Token": "!printf ppie-custom-provider-signature",
	// `$$` emits a literal `$`; `$!` emits a literal `!`.
	"X-Literal-Chars": "$$cost-and-$!bang",
};
