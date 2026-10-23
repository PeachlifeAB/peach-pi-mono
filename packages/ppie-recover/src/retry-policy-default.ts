import { DEFAULT_CONFIG } from "./retry-config-defaults.ts";
import { normalizeRetryConfig } from "./retry-config-normalize.ts";
import type { ResolvedRetryPolicy } from "./retry-policy-types.ts";

/**
 * The resolved default policy is exactly normalizeRetryConfig(DEFAULT_CONFIG) —
 * one assembly path, no second set of literals.
 */
export const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = Object.freeze(normalizeRetryConfig(DEFAULT_CONFIG));
