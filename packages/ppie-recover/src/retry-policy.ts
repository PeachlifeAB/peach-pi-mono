import { normalizeRetryConfig } from "./retry-config-normalize.ts";
import { formatRetryConfigError, retryConfigSchema } from "./retry-config-schema.ts";
import { DEFAULT_RETRY_POLICY } from "./retry-policy-default.ts";
import type { ResolvedRetryPolicy } from "./retry-policy-types.ts";

export { DEFAULT_RETRY_POLICY } from "./retry-policy-default.ts";
export type { ResolvedRetryPolicy } from "./retry-policy-types.ts";

export function resolveRetryPolicy(config?: unknown, sourcePath?: string): ResolvedRetryPolicy {
	if (config === undefined) return DEFAULT_RETRY_POLICY;
	const parsed = retryConfigSchema.safeParse(config);
	if (!parsed.success) throw new Error(formatRetryConfigError(parsed.error, sourcePath));
	return normalizeRetryConfig(parsed.data);
}
