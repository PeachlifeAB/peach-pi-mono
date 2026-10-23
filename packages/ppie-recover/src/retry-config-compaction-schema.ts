import * as z from "zod";

const seconds = z.number().finite().min(0);
const nonNegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// Sibling of `compaction` under memory_overflow_protection. The recovery chain
// treats pruning as its own domain with its own counter, reached after the
// compaction budget is spent — or immediately when compaction is disabled —
// so the config mirrors that instead of nesting it inside compaction.
export const prune = z
	.object({
		enabled: z
			.boolean()
			.default(false)
			.describe("Allow pruning after the forced-compaction budget is spent. Destructive; off by default."),
		max_attempts: z
			.number()
			.int()
			.min(1)
			.max(20)
			.default(1)
			.describe(
				"Prune attempts before recovery stops. Own counter, independent of retry.max_attempts. Default 1: " +
					"the removal target is calculated from the provider's reported overage plus reserve and margin, so " +
					"a correct calculation clears the limit on the first attempt. A second attempt means the " +
					"calculation was wrong, not that more removal was needed.",
			),
		removal_fractions: z
			.array(z.number().gt(0).lt(1))
			.min(1)
			.refine((values) => new Set(values).size === values.length, "must not contain duplicates")
			.default([0.25, 0.5, 0.75, 0.875])
			.describe(
				"Escalation ladder: the fraction of eligible content removed on each successive attempt. Unique and " +
					"strictly increasing. Only the first entry is reached while max_attempts is 1.",
			),
		target_priorities: z
			.object({
				marked_blocks: z.number().int().min(0).default(3),
				tool_results: z.number().int().min(0).default(2),
				assistant_turns: z.number().int().min(0).default(1),
			})
			.strict()
			.prefault({})
			.describe("Higher priority is removed first; ties are removed oldest first."),
		tool_priorities: z
			.record(z.string().min(1), z.number().int().min(0))
			.default({})
			.describe(
				"Removal order for named tool results within tool_results. Unlisted tools are ordered by age. " +
					'Example: { "bash": 5, "read": 4 } removes bash output before read output.',
			),
		block_markers: z
			.array(z.string().min(1))
			.refine((markers) => new Set(markers).size === markers.length, "must not contain duplicates")
			.default(["llm wiki", "wiki", "recall"])
			.describe("Substrings identifying marked blocks, governed by target_priorities.marked_blocks."),
		extra_overage_tokens: nonNegativeInteger
			.default(2000)
			.describe("Headroom removed beyond the provider's measured overage, absorbing token-estimate error."),
	})
	.strict()
	.describe(
		"Last resort after the forced-compaction budget is spent — or immediately when compaction is disabled. " +
			"Unstable interface — it may change or be removed in a future version. Trims the outgoing provider " +
			"payload only; session history is never rewritten, and prompts, skills, system instructions, and user " +
			"messages are never eligible. Once recovery enters pruning it never returns to compaction.",
	);

const forcedCompaction = z
	.object({
		enabled: z
			.boolean()
			.default(false)
			.describe("Allow ppie-recover to force a compaction when Pi has not resolved an overflow itself."),
		wait_seconds_before_first_attempt: seconds
			.default(30)
			.describe(
				"Delay before forcing the first compaction, independent of the retry schedule. If Pi core or another " +
					"compaction extension starts one during this window, ppie-recover cancels its own and defers to that " +
					"compaction without consuming an attempt.",
			),
		max_attempts: z
			.number()
			.int()
			.min(1)
			.max(20)
			.default(2)
			.describe(
				"Forced compactions before recovery falls through to pruning. Own counter, independent of " +
					"retry.max_attempts. One attempt is consumed per compaction that did not resolve the overflow — " +
					"whether it failed mid-flight, reported nothing to compact, or completed without freeing enough. " +
					"Minimum 1; use enabled to switch forced compaction off.",
			),
		warn_after_seconds: seconds
			.default(600)
			.describe("Advisory warning when a compaction has not finished. 0 disables. Never alters recovery state."),
		give_up_after_no_progress_seconds: seconds
			.default(180)
			.describe(
				"First observation window of the two-stage abandonment check: compaction lifecycle state is " +
					"snapshotted, then compared after this delay. 0 disables the watchdog.",
			),
		give_up_confirm_seconds: seconds
			.default(480)
			.describe(
				"Second observation window, entered only when the first found no change. Two consecutive unchanged " +
					"observations release compaction ownership; abandoning never infers that the compaction completed.",
			),
	})
	.strict()
	.describe("Compaction ppie-recover initiates itself after an overflow error that Pi has not resolved.");

const dynamicCompaction = z
	.object({
		enabled: z.boolean().default(false).describe("Allow preventive compaction before an overflow occurs."),
		at_context_ratio: z
			.number()
			.finite()
			.gt(0)
			.lt(1)
			.default(0.8)
			.describe(
				"Fraction of the model context window that triggers preventive compaction. Not an on/off switch: the " +
					"value is retained while enabled is false. Evaluated at Pi's agent_settled checkpoint, so a " +
					"continuous tool-use loop crossing the ratio is left running.",
			),
	})
	.strict()
	.describe(
		"Preventive compaction at a context threshold. Independent of forced compaction; neither implies the other.",
	);

export const compaction = z
	.object({
		enabled: z
			.boolean()
			.default(false)
			.describe(
				"Master switch for every compaction feature. When false, ppie-recover reads no other value in this " +
					"object: it initiates no compaction, waits for none, and warns about none. Compaction is left " +
					"entirely to Pi. Containment is positional and admits no exception — a nested value is governed " +
					"by this switch whether it causes an action or is purely advisory. Nested values are retained, " +
					"so re-enabling restores the configured behavior. The sibling prune group has its own enabled " +
					"gate and is not governed by this switch.",
			),
		dynamic: dynamicCompaction.prefault({}),
		forced: forcedCompaction.prefault({}),
	})
	.strict()
	.describe(
		"Every compaction concern ppie-recover owns. Pi's native reserveTokens and keepRecentTokens are never altered.",
	);
