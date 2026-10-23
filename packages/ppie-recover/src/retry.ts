import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./debug-log.ts";
import { installRetrySessionAdapter } from "./pi-agent-session-retry-adapter.ts";
import type { RecoveryChainTelemetryPort } from "./recovery-chain.ts";
import { createGuarded, createNotifier } from "./retry-hooks.ts";
import { resolveRetryPolicyLayers } from "./retry-policy-node.ts";
import type { ResolvedRetryPolicy } from "./retry-policy-types.ts";
import { type RetryRuntimeState, registerRetryRuntime } from "./retry-runtime.ts";

export type RetryExtensionOptions = Readonly<{
	recoveryTelemetry?: RecoveryChainTelemetryPort;
	policy?: ResolvedRetryPolicy;
}>;

export default function retry(pi: ExtensionAPI, options: RetryExtensionOptions = {}) {
	installRetrySessionAdapter();
	const guarded = createGuarded();
	const notifier = createNotifier();
	const state: RetryRuntimeState = {
		userAborted: false,
		latestCtx: undefined,
		recoveryGeneration: 0,
		continuationDemandId: 0,
	};
	const buildRuntime = (policy: ResolvedRetryPolicy): void =>
		registerRetryRuntime({
			pi,
			policy,
			recoveryTelemetry: options.recoveryTelemetry,
			guarded,
			notify: notifier.notify,
			setNotifyContext: notifier.setContext,
			state,
		});

	// Injected policy (tests, embedding): no file resolution, build immediately.
	if (options.policy !== undefined) {
		buildRuntime(options.policy);
		return;
	}
	// Layered resolution needs a session context — cwd and project trust exist
	// only once a session starts. Later sessions keep the first resolution; a
	// mid-process trust change applies on the next launch.
	let built = false;
	pi.on(
		"session_start",
		guarded("session_start.config_layers", (_event, ctx) => {
			if (built) return;
			built = true;
			const report = resolveRetryPolicyLayers({
				project: { cwd: ctx.cwd, trusted: ctx.isProjectTrusted() },
			});
			notifier.setContext(ctx);
			for (const refusal of report.refusals) {
				notifier.notify(
					refusal.detail === undefined
						? `ppie-recover config refused (${refusal.reason.replace("-", " ")}): ${refusal.path}`
						: `ppie-recover config refused; recovery continues without it: ${refusal.detail}`,
					"warning",
				);
			}
			debugLog("config.layers", {
				layers: report.layers.map((layer) => ({ kind: layer.kind, path: layer.path })),
				refusals: report.refusals,
			});
			buildRuntime(report.policy);
		}),
	);
}
