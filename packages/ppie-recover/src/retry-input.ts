import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { createRetryEngine } from "./agent-retry.ts";
import { debugLog } from "./debug-log.ts";
import { agentForManager } from "./pi-agent-session-retry-adapter.ts";
import type { RecoveryChainDriver } from "./recovery-chain-driver.ts";
import type { Guarded } from "./retry-hooks.ts";

export function registerRetryInput(options: {
	pi: ExtensionAPI;
	guarded: Guarded;
	driver: RecoveryChainDriver;
	engine: ReturnType<typeof createRetryEngine>;
	clearUserAborted: () => void;
	resetTurn: () => void;
	nextDemandId: () => string;
	yieldToContinuation: () => void;
}): void {
	const { pi, guarded, driver, engine, clearUserAborted, resetTurn } = options;
	pi.on(
		"input",
		guarded("input", (event, ctx) => {
			if (typeof event.text !== "string") return;
			const recoveryActive = driver.isActive();
			if (recoveryActive) {
				driver.observeContinuation(
					event.source === "extension" ? "external-extension" : "agent-steer",
					options.nextDemandId(),
				);
			}
			if (event.source === "extension") {
				if (recoveryActive) {
					engine.cancel();
					options.yieldToContinuation();
					debugLog("input.extension_yield", { text: event.text.slice(0, 80) });
				}
				return;
			}
			const sessionIdle = ctx.isIdle();
			const retryDriving = engine.isDriving();
			const drivenAgent = agentForManager(ctx.sessionManager);
			const activeRun = drivenAgent?.signal !== undefined;
			debugLog("input.received", {
				source: event.source,
				streamingBehavior: event.streamingBehavior ?? null,
				sessionIdle,
				retryDriving,
				agentResolved: drivenAgent !== null,
				activeRun,
			});

			if (event.streamingBehavior === undefined && (!sessionIdle || retryDriving)) {
				if (activeRun && drivenAgent) {
					// Custody only with guaranteed delivery: steer() enqueues
					// synchronously into the active run's steering queue, drained at
					// the next step boundary. pi.sendUserMessage is fire-and-forget
					// through the extension API and its rejection is invisible to us.
					drivenAgent.steer({
						role: "user",
						content: [{ type: "text", text: event.text }],
						timestamp: Date.now(),
					});
					clearUserAborted();
					engine.cancel();
					resetTurn();
					debugLog("input.steer_custody", { text: event.text.slice(0, 80) });
					return { action: "handled" };
				}
				// No active run: Pi's native path owns the input. Idle backoff:
				// prompt() proceeds. Busy/idle desync: prompt() throws loudly to
				// the caller. Never a silent drop.
				debugLog("input.passthrough", { reason: "no-active-run", sessionIdle, retryDriving });
				clearUserAborted();
				engine.cancel();
				resetTurn();
				return;
			}

			debugLog("input.passthrough", { reason: "native", sessionIdle, retryDriving });
			clearUserAborted();
			engine.cancel();
			resetTurn();
		}),
	);
}
