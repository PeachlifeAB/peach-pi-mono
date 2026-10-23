import * as z from "zod";

// Live-target facts for a real-settings forked smoke run. The config file's
// own directory IS the owning project working directory — there is
// deliberately no projectDir field (see schemas/smoke-config.schema.json).
// This zod schema is the single source of truth: scripts/smoke-config-validate.ts
// validates against it, scripts/gen-smoke-config-schema.ts emits the committed
// JSON Schema artifact from it, and a drift guard (test/smoke-config-schema.test.ts)
// fails if the committed file falls behind. Zod boundary contract per ADR 0001.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const loadItem = z
	.object({
		kind: z.enum(["extension", "skill"]),
		value: z
			.string()
			.min(1, "must be a non-empty extension/skill spec")
			.describe(
				"For extension: an npm spec (npm:...), a local absolute path, or a repo-relative path resolved by running pi from the config directory. For skill: a repo-relative path resolved against the config directory. No shell ~ expansion happens inside JSON; write explicit absolute paths for local extensions. Must be non-empty — a blank load entry would inject a flag with no value into pi's argv.",
			),
	})
	.strict();

export const smokeConfigSchema = z
	.object({
		$schema: z.string().min(1).optional().describe("Optional editor/IDE schema hint. Ignored by the launcher."),
		version: z.literal(1).describe("Schema version. Only 1 is supported."),
		forkSessionId: z
			.string()
			.regex(UUID, "must be a session UUID")
			.describe(
				"Pi session id to fork. Must belong to the project this config lives in; ownership is validated by Pi's own fork resolution at launch, never inferred from storage layout. The source session is forked, never resumed or mutated.",
			),
		prompt: z
			.string()
			.min(1, "must be a non-empty reproduction prompt")
			.describe(
				"The single reproduction prompt sent over RPC. Must be non-empty — the launcher sends nothing useful if the prompt is empty, and a no-op smoke is not a pass.",
			),
		mode: z
			.literal("rpc")
			.describe("RPC mode keeps the process alive until a semantic result; print/interactive modes cannot."),
		model: z
			.string()
			.min(1, "must be a non-empty model/provider id")
			.optional()
			.describe(
				"Optional exact model/provider ID to pass as --model. Use only when the repro requires pinning the same model as the source session; omit to inherit Pi/session defaults.",
			),
		disableGlobalSkills: z
			.boolean()
			.describe(
				"Emits --no-skills. Disables ambient/global skill discovery but must not discard explicit --skill args.",
			),
		disableGlobalExtensions: z
			.boolean()
			.describe(
				"Emits --no-extensions. Disables ambient/global extension discovery but must not discard explicit --extension args.",
			),
		load: z
			.array(loadItem)
			.describe(
				"One ordered list of explicit skills and extensions to load. Order is preserved exactly in pi's argv because extension/skill ordering can matter.",
			),
	})
	.strict()
	.meta({
		$id: "https://ppie-recover/schemas/smoke-config.schema.json",
		title: "ppie-recover smoke config",
		description:
			"Live target facts for a real-settings forked smoke run. This file is NEVER checked in with real values (see .gitignore). The directory it lives in IS the owning project working directory; there is intentionally no projectDir field. The runner builds pi's argv solely from this file and runs pi from this directory.",
	});
export const smokeConfigJsonSchema = z.toJSONSchema(smokeConfigSchema);

// Render issues as `config.<path>: <message>` lines so the human message names
// each offending key in the config's own namespace. Mirrors
// formatRetryConfigError in retry-config-schema.ts.
export function formatSmokeConfigError(error: z.ZodError, sourcePath?: string): string {
	const prefix = sourcePath ? `${sourcePath}: ` : "";
	const lines = error.issues.map((issue) => {
		const path = issue.path.map((seg) => (typeof seg === "number" ? `[${seg}]` : `.${String(seg)}`)).join("");
		const key = issue.code === "unrecognized_keys" ? issue.keys.join(", ") : "";
		const suffix = key ? `.${key}: unknown key` : `: ${issue.message}`;
		return `config${path}${suffix}`;
	});
	return `${prefix}invalid ppie-recover smoke config:\n${lines.join("\n")}`;
}
