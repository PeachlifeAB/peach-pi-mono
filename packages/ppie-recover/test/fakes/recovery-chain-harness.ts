import type {
	RecoveryChainAction,
	RecoveryChainController,
	RecoveryChainPolicy,
	RecoveryChainTelemetryEvent,
} from "../../src/recovery-chain.ts";
import { createRecoveryChainController } from "../../src/recovery-chain.ts";

/** Test-scale chain policy for the controller state machine — deliberately NOT
 * the shipped config (small numbers keep telemetry short); tests that assert
 * configured behavior resolve a real resolved policy instead. */
export const HARNESS_CHAIN_POLICY: RecoveryChainPolicy = {
	forcedCompactionAttempts: 2,
	maxPruningAttempts: 1,
	maxProviderRetryAttempts: () => 4,
};

type HarnessPolicy = Omit<RecoveryChainPolicy, "maxProviderRetryAttempts"> & {
	maxProviderRetryAttempts?: number | RecoveryChainPolicy["maxProviderRetryAttempts"];
};

const asAttemptLimit = (
	limit: number | RecoveryChainPolicy["maxProviderRetryAttempts"],
): RecoveryChainPolicy["maxProviderRetryAttempts"] => (typeof limit === "function" ? limit : () => limit);

export function recoveryChainHarness(policy: Partial<HarnessPolicy> = {}) {
	let nextId = 0;
	const telemetry: RecoveryChainTelemetryEvent[] = [];
	const controller = createRecoveryChainController({
		generation: "generation-1",
		policy: {
			...HARNESS_CHAIN_POLICY,
			...policy,
			maxProviderRetryAttempts: asAttemptLimit(
				policy.maxProviderRetryAttempts ?? HARNESS_CHAIN_POLICY.maxProviderRetryAttempts,
			),
		},
		delayMsForCompactionAttempt: (_trigger, attempt) => (attempt === 1 ? 0 : 30_000),
		nextChainId: () => `chain-${++nextId}`,
		telemetry: { onEvent: (event: RecoveryChainTelemetryEvent) => telemetry.push(event) },
	});
	return { controller, telemetry };
}

type ActionOf<Kind extends RecoveryChainAction["kind"]> = Extract<RecoveryChainAction, { kind: Kind }>;

export function requireAction<Kind extends RecoveryChainAction["kind"]>(
	controller: RecoveryChainController,
	kind: Kind,
): ActionOf<Kind> {
	const action = controller.nextAction();
	if (!action) throw new Error(`expected ${kind} action, got no action`);
	if (action.kind !== kind) {
		throw new Error(`expected ${kind} action, got ${action.kind}`);
	}
	return action as ActionOf<Kind>;
}

export function startAction(controller: RecoveryChainController, action: RecoveryChainAction) {
	controller.observe({ type: "action-started", actionId: action.id });
}

export function failCompaction(
	controller: RecoveryChainController,
	input: {
		owner: "ppie-recover" | "external";
		requestId: string;
		lifecycleEpoch: number;
	},
) {
	controller.observe({ type: "compaction-started", ...input });
	controller.observe({
		type: "compaction-finished",
		...input,
		outcome: "unavailable",
	});
}
