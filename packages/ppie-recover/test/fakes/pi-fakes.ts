/**
 * Shared, reusable stateful fakes for ppie-recover's two real ports: pi's
 * extension event bus (ExtensionAPI) and the per-event ExtensionContext.
 *
 * Extracted from retry-real-interface.spec.ts so other spec files (e.g.
 * test/contract-ctx-fake-core.spec.ts) can import CtxFakeCore/PiFakeCore
 * directly, instead of importing them FROM a test file — which would
 * re-run that file's own describe/test blocks as an import side effect,
 * duplicating every test in it under the importing file's run.
 */

import type {
	CompactionResult,
	CompactOptions,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

// Matches the real error text from
// ExtensionRunner.assertActive (pi-coding-agent/dist/core/extensions/runner.js):
// accessing a captured ctx after fork/newSession/switchSession/reload throws
// this exact message. See docs/pi-extension-hooks.md's session_shutdown row.
export const STALE_CTX_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

const FAKE_COMPACTION_RESULT: CompactionResult = {
	summary: "fake compaction summary",
	firstKeptEntryId: "fake-first-kept-entry",
	tokensBefore: 1000,
	estimatedTokensAfter: 100,
};

export class PiFakeCore {
	readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
	readonly sentUserMessages: Array<{ message: string; options: unknown }> = [];
	readonly registeredFlags = new Map<string, { default?: unknown }>();
	readonly flagValues = new Map<string, unknown>();
	readonly customEntries: Array<{ customType: string; data: unknown }> = [];
	readonly entryRenderers = new Map<string, unknown>();
	readonly busEvents: Array<{ channel: string; payload: unknown }> = [];
	readonly events = {
		emit: (channel: string, payload: unknown) => this.busEvents.push({ channel, payload }),
	};
	setModelHandler?: (model: unknown) => Promise<boolean>;
	setModel(model: unknown): Promise<boolean> {
		return this.setModelHandler?.(model) ?? Promise.resolve(false);
	}
	on(event: string, fn: (...args: unknown[]) => void) {
		(this.handlers.get(event) ?? []).push(fn);
		if (!this.handlers.has(event)) this.handlers.set(event, [fn]);
	}
	emit(event: string, ...args: unknown[]) {
		for (const fn of this.handlers.get(event) ?? []) fn(...args);
	}
	// pi-core's real ExtensionRunner uses a hook handler's RETURN VALUE for
	// events like before_provider_request (BeforeProviderRequestEventResult)
	// to apply extension-mutated data (e.g. a pruned payload) — emit() above
	// discards that, so it cannot catch a regression where a wrapper drops
	// the handler's return. This calls the (single) registered handler
	// directly and returns what it returns, matching real usage.
	emitAndGetResult<Result>(event: string, ...args: unknown[]): Result {
		const handlers = this.handlers.get(event) ?? [];
		if (handlers.length !== 1) {
			throw new Error(`emitAndGetResult expects exactly one handler for "${event}", found ${handlers.length}`);
		}
		return handlers[0](...args) as Result;
	}
	readonly registeredCommands = new Map<string, unknown>();
	registerFlag(name: string, spec: { default?: unknown }) {
		this.registeredFlags.set(name, spec);
	}
	registerCommand(name: string, spec: unknown) {
		this.registeredCommands.set(name, spec);
	}
	registerEntryRenderer(customType: string, renderer: unknown) {
		this.entryRenderers.set(customType, renderer);
	}
	appendEntry(customType: string, data: unknown) {
		this.customEntries.push({ customType, data });
	}
	setFlag(name: string, value: unknown) {
		this.flagValues.set(name, value);
	}
	getFlag(name: string) {
		return this.flagValues.has(name) ? this.flagValues.get(name) : this.registeredFlags.get(name)?.default;
	}
	// Real pi contract for extension-sent user messages: bindCore's
	// sendUserMessage wrapper (pi-coding-agent dist/core/agent-session.js
	// _bindExtensionCore) catches a rejected AgentSession.sendUserMessage and
	// reports it as extensionPath "<runtime>" — the calling extension never
	// observes the failure. Tests wire deliverUserMessage to the routing
	// behavior under test; a throw lands in runtimeErrors exactly like the
	// real catch wrapper, and the message is silently lost.
	deliverUserMessage?: (message: string, options: unknown) => void;
	readonly runtimeErrors: Array<{ event: string; error: string }> = [];
	sendUserMessage(message: string, options: unknown) {
		this.sentUserMessages.push({ message, options });
		try {
			this.deliverUserMessage?.(message, options);
		} catch (err) {
			this.runtimeErrors.push({
				event: "send_user_message",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

export class CtxFakeCore {
	readonly hasUI = true;
	readonly mode = "tui" as const;
	model: unknown;
	scopedModels: Array<{ model: unknown }> = [];
	branch: SessionEntry[] = [];
	stripTrailingAssistantOnOverflow = false;
	private agentState: { messages: Array<{ role?: string }> } | undefined;
	attachAgentState(agentState: { messages: Array<{ role?: string }> }) {
		this.agentState = agentState;
	}
	private stale = false;
	markStale() {
		this.stale = true;
	}
	readonly ui = new Proxy(
		{
			status: [] as string[],
			notifications: [] as Array<{ message: string; level?: string }>,
		},
		{
			get: (target, prop: string) => {
				if (this.stale) throw new Error(STALE_CTX_MESSAGE);
				if (prop === "setStatus") {
					return (_key: string, value: string) => target.status.push(value);
				}
				if (prop === "notify") {
					return (message: string, level?: string) => target.notifications.push({ message, level });
				}
				if (prop in target) {
					return (target as unknown as Record<string, unknown>)[prop];
				}
				throw new Error(
					`CtxFakeCore.ui: unhandled property "${prop}" — the fake does not implement this member; add it or the test is passing vacuously`,
				);
			},
		},
	);
	readonly compactions: Array<{ at: number }> = [];
	readonly sessionManager = {
		getBranch: (_fromId?: string): SessionEntry[] => {
			if (this.stale) throw new Error(STALE_CTX_MESSAGE);
			return this.branch;
		},
	};
	contextWindow = 1000;
	contextTokens: number | null = null;
	getContextUsage() {
		if (this.stale) throw new Error(STALE_CTX_MESSAGE);
		// Matches pi-coding-agent's real ContextUsage shape exactly
		// (tokens/percent included, not just contextWindow) — verified in
		// test/contract-ctx-fake-core.spec.ts. ppie-recover's own code only
		// ever reads .contextWindow (retry-utils.ts's contextWindowOf), but
		// the fake should still return the real shape so a future caller
		// that reads .tokens/.percent gets a realistic value instead of
		// undefined.
		return { contextWindow: this.contextWindow, tokens: this.contextTokens, percent: null };
	}
	pendingMessages = false;
	hasPendingMessages() {
		if (this.stale) throw new Error(STALE_CTX_MESSAGE);
		return this.pendingMessages;
	}
	// Matches pi-coding-agent's real ExtensionContext.isIdle(): "whether the
	// agent is idle (not streaming)". Defaults true (idle) so existing tests
	// that never set it keep their current behavior.
	agentIsIdle = true;
	isIdle() {
		if (this.stale) throw new Error(STALE_CTX_MESSAGE);
		return this.agentIsIdle;
	}
	abortCallCount = 0;
	abort() {
		if (this.stale) throw new Error(STALE_CTX_MESSAGE);
		this.abortCallCount++;
	}
	failNextCompact: string | undefined;
	failAllCompacts: string | undefined;
	compactNeverSettles = false;
	onCompactStart: (() => void) | undefined;
	onCompactComplete: (() => void) | undefined;
	// Callbacks of a request held open by compactNeverSettles. The real host
	// settles such a request whenever its compaction finishes; settleHeldCompaction()
	// lets a test drive that moment explicitly.
	private heldCompaction: CompactOptions | undefined;
	settleHeldCompaction() {
		const held = this.heldCompaction;
		if (!held) throw new Error("CtxFakeCore.settleHeldCompaction: no compaction is being held");
		this.heldCompaction = undefined;
		held.onComplete?.(FAKE_COMPACTION_RESULT);
		this.onCompactComplete?.();
	}
	// CompactOptions comes directly from pi-coding-agent. The fake emits the
	// observable start before any unresolved/failure outcome and supplies the
	// real CompactionResult shape on success.
	compact(callbacks?: CompactOptions) {
		if (this.stale) throw new Error(STALE_CTX_MESSAGE);
		this.onCompactStart?.();
		this.compactions.push({ at: Date.now() });
		if (this.compactNeverSettles) {
			this.heldCompaction = callbacks;
			return;
		}
		if (this.failNextCompact || this.failAllCompacts) {
			const message = this.failNextCompact ?? (this.failAllCompacts as string);
			this.failNextCompact = undefined;
			if (this.stripTrailingAssistantOnOverflow) {
				const messages = this.agentState?.messages;
				if (messages?.at(-1)?.role === "assistant") messages.pop();
			}
			callbacks?.onError?.(new Error(message));
			return;
		}
		callbacks?.onComplete?.(FAKE_COMPACTION_RESULT);
		this.onCompactComplete?.();
	}
}

export function noOpProxy<T extends object>(target: T): T {
	return new Proxy(target, {
		get(t, prop: string) {
			if (prop in t) return (t as unknown as Record<string, unknown>)[prop];
			throw new Error(
				`noOpProxy: unhandled property "${prop}" — the fake does not implement this member; add it or the test is passing vacuously`,
			);
		},
	});
}

export function asExtensionApi(fake: PiFakeCore): ExtensionAPI {
	return noOpProxy(fake) as unknown as ExtensionAPI;
}

export function asExtensionContext(fake: CtxFakeCore): ExtensionContext {
	return noOpProxy(fake) as unknown as ExtensionContext;
}
