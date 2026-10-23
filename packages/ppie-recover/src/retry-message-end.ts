import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { createRetryEngine, TriggerOptions } from "./agent-retry.ts";
import { debugLog } from "./debug-log.ts";
import { classifyError, TRANSIENT_RE } from "./error-classifier.ts";
import { extractStatusCode } from "./error-rule-engine.ts";
import type { createLengthStopHandler } from "./length-stop.ts";
import type { ModelFallbackCoordinator } from "./model-fallback-coordinator.ts";
import { canonicalModelReference } from "./model-fallback-model.ts";
import { isOutputBudgetExhaustion } from "./output-budget-dialect.ts";
import type { createOverflowRecovery } from "./overflow-recovery.ts";
import type { ResponsesOutputBudgetRecovery } from "./responses-output-budget-recovery.ts";
import type { RetryAdmission } from "./retry-admission.ts";
import type { Guarded, NotifyLevel } from "./retry-hooks.ts";
import { isKeepaliveFrame, type MessageShape } from "./retry-utils.ts";
import { registerRetryVeto } from "./retry-veto.ts";
import type { createWatchdog } from "./watchdog.ts";

export function registerRetryMessageEnd(options: {
	pi: ExtensionAPI;
	guarded: Guarded;
	engine: ReturnType<typeof createRetryEngine>;
	fallback: ModelFallbackCoordinator;
	maxFallbackHops: number;
	lengthStop: ReturnType<typeof createLengthStopHandler>;
	responsesOutputBudget: ResponsesOutputBudgetRecovery;
	recovery: ReturnType<typeof createOverflowRecovery>;
	watchdog: ReturnType<typeof createWatchdog>;
	setContext: (ctx: ExtensionContext) => void;
	setLatestContext: (ctx: ExtensionContext) => void;
	notify: (message: string, level?: NotifyLevel) => void;
	triggerRetry: (ctx: ExtensionContext, triggerOptions?: TriggerOptions) => void;
	resetTurn: () => void;
	onProviderProgress: (stopReason: "stop" | "toolUse") => void;
	admission: RetryAdmission;
	onRetriesExhausted?: () => void;
	isUserAborted: () => boolean;
	markUserAborted: () => void;
}): void {
	const { engine, lengthStop, recovery, watchdog } = options;
	const routeFallback = (
		ctx: ExtensionContext,
		message: MessageShape,
		errorMessage: string,
		reason: string,
	): boolean => {
		const fallbackModels = options.admission.fallbackModelsFor(errorMessage);
		const active = options.fallback.activeSequence();
		if ((options.maxFallbackHops === 0 || fallbackModels.length === 0) && !active) return false;
		const failedModel =
			typeof message.provider === "string" && typeof message.model === "string"
				? `${message.provider}/${message.model}`
				: (active?.originatingModel ?? (ctx.model ? canonicalModelReference(ctx.model) : undefined));
		if (!failedModel) return false;
		void options.fallback.route({
			failedModel,
			fallbackModels,
			maxHops: options.maxFallbackHops,
			reason,
			status: extractStatusCode(errorMessage),
		});
		return true;
	};
	const handleProviderError = (ctx: ExtensionContext, message: MessageShape, errorMessage: string): void => {
		const errorClass = classifyError(errorMessage);
		if (options.isUserAborted()) return;
		if (errorClass === "transient" && !TRANSIENT_RE.test(errorMessage)) {
			options.notify(
				`Unrecognized provider error (falling back to generic retry): ${errorMessage.slice(0, 120)}`,
				"warning",
			);
		}
		const { signature } = recovery.classifyAndTrack(errorMessage);
		if (options.admission.neverRetries(errorMessage)) {
			if (routeFallback(ctx, message, errorMessage, errorClass)) return;
			options.notify(`Non-retryable error (not retried): ${errorMessage.slice(0, 120)}`, "error");
			return;
		}
		if (options.admission.retryBudgetExhausted(errorMessage)) {
			if (routeFallback(ctx, message, errorMessage, errorClass)) return;
			options.notify(
				`Rule "${options.admission.ruleFor(errorMessage)}" gave up; stopping automatic recovery: ${errorMessage.slice(0, 120)}`,
				"error",
			);
			options.onRetriesExhausted?.();
			return;
		}
		if (/Context overflow recovery failed/i.test(errorMessage)) {
			options.triggerRetry(ctx);
			return;
		}
		if (errorClass === "memory_guard") {
			engine.cancel();
			recovery.recoverMemoryGuard(ctx, {
				onRetry: (delayAlreadyElapsed) =>
					options.triggerRetry(ctx, { fallbackErrorMessage: errorMessage, delayAlreadyElapsed }),
			});
			return;
		}
		if (recovery.shouldDeferToCore(errorMessage, signature)) {
			debugLog("defer_to_core.start", { signature });
			options.notify(
				"Provider rejected the request without details; attempting bounded context recovery.",
				"warning",
			);
			recovery.awaitCoreDeferOrFallback(ctx, {
				retryDelayMs: options.admission.delayMsForError(errorMessage, 1),
				errorMessage,
				onRetry: () => options.triggerRetry(ctx, { fallbackErrorMessage: errorMessage, delayAlreadyElapsed: true }),
			});
			return;
		}
		options.triggerRetry(ctx);
	};
	const onMessageEnd = (event: { msg?: unknown; message?: unknown }, ctx: ExtensionContext) => {
		const message = (event.msg ?? event.message) as MessageShape;
		if (message.role !== "assistant" || isKeepaliveFrame(message)) return;
		options.setContext(ctx);
		options.setLatestContext(ctx);
		watchdog.disarm();
		const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "";
		// Registered before Pi's post-run retry, which reads it next.
		registerRetryVeto(ctx.sessionManager, options.admission.neverRetries);
		if (message.stopReason === "stop" && lengthStop.shouldRecoverTinyStop(ctx, message)) {
			lengthStop.handle(ctx, { ...message, stopReason: "length" });
			return;
		}
		// A provider-exhausted outgoing cap gets one mapped-field repair before ordinary length recovery.
		if (options.responsesOutputBudget.classifyMessageEnd(message, ctx)) return;
		if (isOutputBudgetExhaustion(message)) {
			lengthStop.handle(ctx, { ...message, stopReason: "length" });
			return;
		}
		if (message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "length") {
			if (message.stopReason === "stop" || message.stopReason === "toolUse") {
				options.onProviderProgress(message.stopReason);
			}
			return;
		}
		if (message.stopReason === "length") return lengthStop.handle(ctx, message);
		if (message.stopReason === "aborted") {
			options.markUserAborted();
			engine.cancel();
			options.fallback.cancel("aborted");
			options.resetTurn();
			return;
		}
		handleProviderError(ctx, message, errorMessage);
	};
	options.pi.on("message_end", options.guarded("message_end", onMessageEnd));
}
