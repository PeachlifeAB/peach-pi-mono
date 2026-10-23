import * as z from "zod";
import { hookEntry, PROVIDER_SILENT_EVENT } from "./hooks.ts";
import { compaction, prune } from "./retry-config-compaction-schema.ts";
import { DEFAULT_CONFIG } from "./retry-config-defaults.ts";
import { addInlineMetadataToJsonSchema, removeInlineMetadata } from "./retry-config-metadata.ts";

const maxAttempts = z
	.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.literal("unlimited")])
	.describe('Provider requests before recovery stops. 0 never retries; "unlimited" never gives up.');
const seconds = z.number().finite().min(0);
const multiplier = z
	.number()
	.finite()
	.min(1)
	.max(60)
	.describe("Geometric growth: delay = seconds_before_first_retry x multiplier^(attempt-1).");
const canonicalModelReference = z.string().regex(/^[^/\s]+\/\S+$/, "must be a canonical provider/modelId reference");
const modelFallback = z
	.object({
		enabled: z.boolean().default(false),
		max_hops: z.number().int().default(3),
	})
	.strict();

const when = z
	.object({
		error_codes: z
			.array(z.number().int().min(100).max(999))
			.min(1)
			.refine((codes) => new Set(codes).size === codes.length, "must not contain duplicates")
			.describe("HTTP status codes this row matches. Example: [429, 503].")
			.optional(),
		words: z
			.array(z.string().min(1))
			.min(1)
			.refine((words) => new Set(words).size === words.length, "must not contain duplicates")
			.describe('Case-insensitive substrings of the error message. Example: ["rate limit", "overloaded"].')
			.optional(),
		words_match: z
			.enum(["any", "all"])
			.describe('"any" matches when one word is present; "all" requires every word. Defaults to "any".')
			.optional(),
	})
	.strict()
	.refine((value) => value.error_codes !== undefined || value.words !== undefined, "must contain error_codes or words")
	.describe("Trigger clause. Supplying both kinds matches when either the code or the word clause matches.");

const retryBehavior = z
	.object({
		max_attempts: maxAttempts.optional(),
		seconds_before_first_retry: seconds.describe("Delay before the first retry.").optional(),
		multiplier_between_attempts: multiplier.optional(),
		max_seconds_between_attempts: seconds.describe("Ceiling on the calculated delay.").optional(),
	})
	.strict();

const smartOverride = retryBehavior
	.extend({
		when,
		fallback_models: z.array(canonicalModelReference).min(1).optional(),
	})
	.strict()
	.refine(
		(value) => Object.entries(value).some(([key, property]) => key !== "when" && property !== undefined),
		"must override at least one retry property",
	);

const retry = retryBehavior
	.extend({
		smart_overrides: z
			.array(smartOverride)
			.min(1)
			.describe(
				"Per-error overrides of the values above, applied in declaration order with later explicit values winning. Not a " +
					"separate budget: a matching row replaces which values the retry counter uses. A configured " +
					"array replaces the shipped rows entirely.",
			)
			.optional(),
	})
	.strict()
	.describe(
		"Retries for errors where the provider returned nothing — network failures, 5xx, stream death, rate " +
			"limits. The request is resent unchanged; no context intervention is attempted.",
	);

const configSchema = z
	.object({
		$schema: z.string().optional(),
		retry: retry.optional(),
		memory_overflow_protection: z
			.object({ compaction: compaction.prefault({}), prune: prune.prefault({}) })
			.strict()
			.describe("Recovery for errors caused by context size: token-window overflow and provider memory ceilings.")
			.optional(),
		model_fallback: modelFallback.optional(),
		hooks: z
			.object({ [PROVIDER_SILENT_EVENT]: hookEntry.optional() })
			.strict()
			.describe("Trusted event reactions. Hooks never alter recovery state.")
			.optional(),
		warnings: z
			.object({
				provider_silence_seconds: seconds
					.describe("Advisory warning when the provider has streamed nothing for this long.")
					.optional(),
			})
			.strict()
			.describe(
				"Advisory thresholds. A warning never aborts, retries, compacts, or trims. The compaction warning lives " +
					"at memory_overflow_protection.compaction.forced.warn_after_seconds.",
			)
			.optional(),
		debug: z
			.union([
				z.literal(false),
				z
					.object({
						path: z
							.string()
							.min(1)
							.describe('Absolute path to the debug log. Used verbatim — "~" is not expanded.'),
					})
					.strict(),
			])
			.describe("Diagnostic log. Sink failures are non-fatal and never interrupt recovery.")
			.optional(),
	})
	.strict();

export type PiRetryUserConfig = z.infer<typeof configSchema>;
export const retryConfigSchema = z.preprocess(removeInlineMetadata, configSchema);
export const retryConfigJsonSchema = addInlineMetadataToJsonSchema(
	z.toJSONSchema(retryConfigSchema, { target: "draft-2020-12" }),
);
export { DEFAULT_CONFIG };

export function formatRetryConfigError(error: z.ZodError, sourcePath?: string): string {
	const prefix = sourcePath ? `${sourcePath}: ` : "";
	const lines = error.issues.map((issue) => {
		const path = issue.path
			.map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`))
			.join("");
		const key = issue.code === "unrecognized_keys" ? issue.keys.join(", ") : "";
		return `config${path}${key ? `.${key}: unknown key` : `: ${issue.message}`}`;
	});
	return `${prefix}invalid ppie-recover config:\n${lines.join("\n")}`;
}
