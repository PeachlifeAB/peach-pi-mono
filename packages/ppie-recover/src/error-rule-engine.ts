import type { ResolvedRetryRule, RetryBehaviorOverride, RetryPacing } from "./retry-policy-types.ts";

/**
 * Error-rule engine: resolves provider error text against the ordered rule table.
 *
 * Contract basis: pi exposes `errorMessage?: string` only — codes arrive as text
 * (pi-core prefixes them, #4232). Codes are the stable spine; words are
 * best-effort enrichment. Matching is literal-only, case-insensitive,
 * word-boundary-anchored; code extraction masks comma-grouped numbers so
 * "75,403 tokens" never reads as 403.
 *
 * Rows arrive fully resolved from the config (retry-config-normalize): every
 * pacing field is present, so the engine applies data and owns no defaults.
 * Each row's max_seconds_between_attempts caps its own wait law; "unlimited"
 * attempts resolve to Infinity exactly once, here.
 */

const STATUS_CODE_RE = /(?<![\d,.])(\d{3})(?!\d)/;

/** Pacing with the attempt limit resolved to a number ("unlimited" → Infinity). */
export type ResolvedPacing = Readonly<{
	seconds_before_first_retry: number;
	multiplier_between_attempts: number;
	max_attempts: number;
	max_seconds_between_attempts: number;
}>;

const asAttempts = (limit: RetryPacing["max_attempts"]): number =>
	limit === "unlimited" ? Number.POSITIVE_INFINITY : limit;

/** First standalone 3-digit status code in the message, if any. */
export function extractStatusCode(message: string): number | undefined {
	const match = STATUS_CODE_RE.exec(message);
	return match ? Number(match[1]) : undefined;
}

export function pacingDelayMs(pacing: ResolvedPacing, attempt: number): number {
	const exponent = Math.max(0, attempt - 1);
	return Math.min(
		pacing.max_seconds_between_attempts * 1000,
		pacing.seconds_before_first_retry * 1000 * pacing.multiplier_between_attempts ** exponent,
	);
}

type ErrorRuleSource = "rule" | "catch_all";

type ErrorRuleMatch = Readonly<{
	rule: string;
	pacing: ResolvedPacing;
	fallbackModels: readonly string[];
	source: ErrorRuleSource;
}>;

export type ErrorRuleEngine = Readonly<{
	resolve(message: string): ErrorRuleMatch;
	/** Pacing wait for the attempt-th retry of an error classified by resolve(). */
	delayMsFor(message: string, attempt: number): number;
	maxAttemptsFor(message: string): number;
	/** Max attempts for a single declared rule name. */
	maxAttemptsForRuleName(rule: string): number;
}>;

type CompiledRule = Readonly<{
	rule: string;
	codeSet: ReadonlySet<number> | undefined;
	anyWordsRe: RegExp | undefined;
	allWordsRes: readonly RegExp[] | undefined;
	pacing: ResolvedPacing;
	fallbackModels: readonly string[];
	explicit: RetryBehaviorOverride;
	isCatchAll: boolean;
}>;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Token boundaries: letters/digits block, underscore separates — "overloaded_error"
// matches "overloaded", but "capacity" never matches "cap".
function wordRe(word: string): RegExp {
	return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(word)}(?![A-Za-z0-9])`, "i");
}

function explicitValues(row: ResolvedRetryRule): RetryBehaviorOverride {
	return (
		row.explicit ?? {
			max_attempts: row.max_attempts,
			seconds_before_first_retry: row.seconds_before_first_retry,
			multiplier_between_attempts: row.multiplier_between_attempts,
			max_seconds_between_attempts: row.max_seconds_between_attempts,
			...(row.fallbackModels.length > 0 ? { fallback_models: row.fallbackModels } : {}),
		}
	);
}

function compileRule(row: ResolvedRetryRule): CompiledRule {
	const when = row.when;
	const words = when?.words;
	return {
		rule: row.rule,
		codeSet: when?.error_codes ? new Set(when.error_codes) : undefined,
		anyWordsRe:
			words && (when?.words_match ?? "any") === "any"
				? new RegExp(`(?<![A-Za-z0-9])(?:${words.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`, "i")
				: undefined,
		allWordsRes: words && when?.words_match === "all" ? words.map(wordRe) : undefined,
		pacing: {
			seconds_before_first_retry: row.seconds_before_first_retry,
			multiplier_between_attempts: row.multiplier_between_attempts,
			max_attempts: asAttempts(row.max_attempts),
			max_seconds_between_attempts: row.max_seconds_between_attempts,
		},
		fallbackModels: row.fallbackModels,
		explicit: explicitValues(row),
		isCatchAll: when === undefined,
	};
}

function matchesRule(rule: CompiledRule, code: number | undefined, message: string): boolean {
	if (rule.isCatchAll) return false;
	const codeHit = code !== undefined && rule.codeSet?.has(code) === true;
	const wordsHit = rule.anyWordsRe
		? rule.anyWordsRe.test(message)
		: rule.allWordsRes
			? rule.allWordsRes.every((re) => re.test(message))
			: false;
	return codeHit || wordsHit;
}

type EffectiveRule = Readonly<{
	pacing: ResolvedPacing;
	fallbackModels: readonly string[];
}>;

function applyExplicitValues(current: EffectiveRule, rule: CompiledRule): EffectiveRule {
	const explicit = rule.explicit;
	return {
		pacing: {
			seconds_before_first_retry: explicit.seconds_before_first_retry ?? current.pacing.seconds_before_first_retry,
			multiplier_between_attempts:
				explicit.multiplier_between_attempts ?? current.pacing.multiplier_between_attempts,
			max_attempts:
				explicit.max_attempts === undefined ? current.pacing.max_attempts : asAttempts(explicit.max_attempts),
			max_seconds_between_attempts:
				explicit.max_seconds_between_attempts ?? current.pacing.max_seconds_between_attempts,
		},
		fallbackModels: explicit.fallback_models ?? current.fallbackModels,
	};
}

export function createErrorRuleEngine(rules: readonly ResolvedRetryRule[]): ErrorRuleEngine {
	const compiled = rules.map(compileRule);
	const catchAll = compiled.find((rule) => rule.isCatchAll);
	if (catchAll === undefined) throw new Error("error rules: the built-in catch-all row is missing");

	const resolve = (message: string): ErrorRuleMatch => {
		const code = extractStatusCode(message);
		const matching = compiled.filter((rule) => matchesRule(rule, code, message));
		const effective = matching.reduce((current, rule) => applyExplicitValues(current, rule), {
			pacing: catchAll.pacing,
			fallbackModels: catchAll.fallbackModels,
		});
		return {
			rule: matching.length === 0 ? catchAll.rule : matching.map((rule) => rule.rule).join(" + "),
			pacing: effective.pacing,
			fallbackModels: effective.fallbackModels,
			source: matching.length === 0 ? "catch_all" : "rule",
		};
	};

	return {
		resolve,
		delayMsFor: (message, attempt) => pacingDelayMs(resolve(message).pacing, attempt),
		maxAttemptsFor: (message) => resolve(message).pacing.max_attempts,
		maxAttemptsForRuleName: (name) => {
			const found = compiled.find((rule) => rule.rule === name);
			if (found !== undefined) return found.pacing.max_attempts;
			return catchAll.pacing.max_attempts;
		},
	};
}
