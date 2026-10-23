import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { registerLegacyProvider, teardownLegacyProvider } from "./legacy-provider.ts";
import { registerLogFlag, registerLogging } from "./logging.ts";
import { registerNativeProvider } from "./native-provider.ts";
import { registerOperationsCoverage } from "./operations.ts";
import { registerProviderOverrides } from "./overrides.ts";

/**
 * What this extension registers in a normal session: the provider, its logging
 * flag, and passive wire logging. Nothing else.
 *
 * The API-coverage modules — `commands.ts`, `misc.ts`, `ui.ts`, `tools.ts`, and
 * `events.ts` — are deliberately *not* registered, following the precedent the
 * README already sets for `reference/api-coverage.ts`: kept on disk so pi's
 * wider extension surface stays visible and typechecked, but never loaded into
 * a real session.
 *
 * That precedent existed and these modules ignored it, at real cost. Registered,
 * they put 17 `ppie-custom-provider-*` entries in the command picker (including
 * one running arbitrary shell through `pi.exec` and four mutating the session
 * tree), spent context on 6 demo tools in every request, claimed the global
 * `ctrl+shift+g` binding away from pi's own `tui.altScreen.searchPrevious`, and
 * appended a tool count to the system prompt on every agent start. A package
 * whose stated job is "registering a generic OpenAI-compatible provider" should
 * do that and nothing more.
 */
// Async because provider registration primes the model catalog before returning.
// pi awaits the factory before startup continues, so the catalog is ready when pi
// resolves `enabledModels` — otherwise every entry for this provider is warned
// about as `No models match pattern "..."`. See `registerNativeProvider`.
export default async function (pi: ExtensionAPI) {
	// Config is resolved once here, at the boundary, and flows down as typed
	// read-only data. Nothing below re-reads the environment or the filesystem.
	const config = loadConfig(process.cwd());

	// Before anything that reads it. `registerNativeProvider` resolves logging
	// enablement for its discovery-failure sink, and `getFlag` cannot report a flag
	// that has not been declared yet — which silently discarded every failure
	// reason even when the user passed `--ppie-custom-provider-log`.
	registerLogFlag(pi);

	// No refresh command of its own: pi's `/model` picker already refreshes every
	// provider catalog, which reaches this provider through `refreshModels`.
	await registerNativeProvider(pi, config);

	// The legacy registration path is demonstration-only, and registering it
	// alongside the native provider actively degrades a real session: it duplicates
	// the same server under a second id, cannot reach the credential /login stores
	// (it authenticates through pi's `$ENV_VAR` interpolation instead), and so
	// falls back to probing the configured default. With nothing on that port every
	// refresh fails with "Could not refresh openai-generic; showing cached models"
	// while contributing zero models. Opt in explicitly to exercise that path.
	if (process.env.PI_OPENAI_PROVIDER_ENABLE_LEGACY === "1") registerLegacyProvider(pi, config);

	// Pluggable tool operations: this one *replaces the built-in `read` and `bash`
	// tools*, serving `/virtual/*` from memory and prefixing every bash command. It
	// demonstrates the ReadOperations/BashOperations/spawnHook seams, so it must
	// never take over a normal session. The module re-checks the variable itself;
	// the gate is repeated here so what the extension registers is readable in one
	// place.
	if (process.env.PI_OPENAI_PROVIDER_ENABLE_OPERATIONS === "1") registerOperationsCoverage(pi);

	// Self-gated on PI_OPENAI_PROVIDER_ENABLE_OVERRIDES; a no-op without it.
	registerProviderOverrides(pi);

	registerLogging(pi, config);
}

export { teardownLegacyProvider };
