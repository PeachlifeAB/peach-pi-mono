import type { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RetryContinuationPort } from "./agent-retry-types.ts";
import {
	type BasicRetryDrivingLock,
	createStandaloneRetryDrivingLock,
	makeWaitableRetryDrivingLock,
	type RetryDrivingLock,
} from "./retry-driving-lock.ts";
import { vetoesRetry } from "./retry-veto.ts";
import { resolveContinueFromTail } from "./session-run-entry.ts";

type PrepareRetry = (this: AgentSession, message: unknown) => Promise<boolean>;
type EmitAgentSettled = (this: AgentSession) => Promise<void>;
type AgentSessionWithPrivateRetry = {
	_prepareRetry?: PrepareRetry;
	_emitAgentSettled?: EmitAgentSettled;
};

type RetryOwner = symbol;

// Verified against the installed @earendil-works/pi-agent-core: Agent.prompt()
// throws "Agent is already processing a prompt..." synchronously when
// this.activeRun is already set (dist/agent.js). AgentSession's run loop
// (session-run-entry.ts) sets _isAgentRunActive (isIdle's backing flag) BEFORE awaiting
// agent.prompt(), and its finally clears that flag even when agent.prompt()
// threw — so entering the run loop while a run is genuinely still active
// (activeRun set by someone else) corrupts AgentSession's own idle
// bookkeeping, independent of whether the resulting error is caught. The
// defense below is a same-tick re-check of Agent#signal (activeRun's public
// proxy) immediately before run.call, which skips the call entirely rather
// than entering it to find out — see the comment at that check for why no
// try/catch is kept around run.call. ExtensionContext.hasPendingMessages()
// (steering/follow-up queue depth) is a different counter entirely and does
// not observe this race in either direction.

const sessionsByManager = new WeakMap<object, AgentSession>();
const agentsByManager = new WeakMap<object, Agent>();
const explicitContinuationsByManager = new WeakMap<object, RetryContinuationPort>();
const drivingBySession = new WeakMap<AgentSession, RetryOwner>();

let installed = false;

function rememberSession(session: AgentSession): void {
	sessionsByManager.set(session.sessionManager, session);
	agentsByManager.set(session.sessionManager, session.agent);
}

export function installRetrySessionAdapter(): void {
	if (installed) return;
	installed = true;

	const proto = AgentSession.prototype as unknown as AgentSessionWithPrivateRetry;

	const origPrepareRetry = proto._prepareRetry;
	if (typeof origPrepareRetry === "function") {
		proto._prepareRetry = function (this: AgentSession, message: unknown) {
			if (drivingBySession.has(this) || vetoesRetry(this.sessionManager, message)) return Promise.resolve(false);
			return origPrepareRetry.call(this, message);
		};
	}

	// Remember existing sessions at settle; extension load can follow subscribe().
	const origEmitAgentSettled = proto._emitAgentSettled;
	if (typeof origEmitAgentSettled === "function") {
		proto._emitAgentSettled = function (this: AgentSession) {
			rememberSession(this);
			return origEmitAgentSettled.call(this);
		};
	}

	const origSubscribe = AgentSession.prototype.subscribe;
	AgentSession.prototype.subscribe = function (this: AgentSession, ...args: Parameters<AgentSession["subscribe"]>) {
		rememberSession(this);
		return origSubscribe.apply(this, args) as ReturnType<AgentSession["subscribe"]>;
	};
}

export function registerRetryAgentForSessionManager(
	sessionManager: object,
	agent: Agent,
	continuation: RetryContinuationPort,
): void {
	agentsByManager.set(sessionManager, agent);
	explicitContinuationsByManager.set(sessionManager, continuation);
}

function sessionForManager(sessionManager: object): AgentSession | undefined {
	return sessionsByManager.get(sessionManager as object);
}

export function agentForManager(sessionManager: object): Agent | null {
	return sessionForManager(sessionManager)?.agent ?? agentsByManager.get(sessionManager as object) ?? null;
}

export function createSessionRetryContinuationPort(getSessionManager: () => object | undefined): RetryContinuationPort {
	return {
		async continueCurrent(expectedTail, prepare, isCurrent, onWaitingForRunningTurn) {
			const manager = getSessionManager();
			const session = manager ? sessionForManager(manager) : undefined;
			if (!session) {
				const explicit = manager ? explicitContinuationsByManager.get(manager) : undefined;
				return (
					explicit?.continueCurrent(expectedTail, prepare, isCurrent, onWaitingForRunningTurn) ?? "unavailable"
				);
			}
			if (!session.isIdle || session.agent.signal !== undefined) onWaitingForRunningTurn?.();
			await session.waitForIdle();
			await session.agent.waitForIdle();
			if (getSessionManager() !== manager || !session.isIdle) return "superseded";
			if (isCurrent && !isCurrent()) return "superseded";
			const messages = session.agent.state.messages;
			if (messages.at(-1) !== expectedTail) return "superseded";
			const continueFromTail = resolveContinueFromTail(AgentSession.prototype);
			if (!continueFromTail) return "unavailable";
			// Same-tick, synchronous check on the real occupancy signal — Agent#signal
			// is undefined exactly when Agent#activeRun is unset (agent.js:
			// `get signal() { return this.activeRun?.abortController.signal; }`).
			// Deliberately BEFORE prepare(): prepare() can mutate the transcript
			// (e.g. drop a trailing error message) with no restore path on
			// "superseded", so it must not run for an attempt this check is about
			// to abort. Nothing async separates this check from run.call below, so
			// nothing can interleave a user prompt in between (JS is
			// single-threaded; nothing yields here) — this reads activeRun's true
			// current state, unlike session.isIdle, which can go stale:
			// the run loop's finally clears AgentSession's own
			// _isAgentRunActive even when agent.prompt() threw, so entering it
			// while busy would corrupt idle bookkeeping. Skipping the call
			// entirely in that case avoids that corruption. No try/catch backstop
			// around run.call below: given this check is genuinely last and
			// synchronous, run.call cannot observe activeRun already held —
			// keeping a catch "just in case" would silently paper over a broken
			// invariant instead of surfacing it.
			if (session.agent.signal !== undefined) return "superseded";
			prepare();
			await continueFromTail(session);
			return "completed";
		},
	};
}

/**
 * Host-idle readiness for the compaction coordinator: resolves when the
 * AgentSession is fully idle (agent run, compaction, branch summary, retry,
 * queued continuation). Pi clears its compaction controller and resolves its
 * idle wait before compaction_end listeners run, so awaiting this promise
 * cannot submit a prompt while the host still reports compaction in progress.
 * Undefined means no known session; the coordinator continues immediately.
 */
export function createHostIdleWaitForSessionManager(
	getSessionManager: () => object | undefined,
): () => Promise<void> | undefined {
	return () => {
		const manager = getSessionManager();
		const session = manager ? sessionForManager(manager) : undefined;
		return session?.waitForIdle();
	};
}

function createSessionRetryDrivingLock(session: AgentSession): BasicRetryDrivingLock {
	return {
		acquire(owner) {
			if (drivingBySession.has(session)) return false;
			drivingBySession.set(session, owner);
			return true;
		},
		release(owner) {
			if (drivingBySession.get(session) === owner) drivingBySession.delete(session);
		},
		isHeld(queryOwner) {
			const heldOwner = drivingBySession.get(session);
			return queryOwner === undefined ? heldOwner !== undefined : heldOwner === queryOwner;
		},
	};
}

export function createRetryDrivingLockForSessionManager(getSessionManager: () => object | undefined): RetryDrivingLock {
	const fallback = createStandaloneRetryDrivingLock();
	const currentSession = () => {
		const sessionManager = getSessionManager();
		return sessionManager ? sessionForManager(sessionManager) : undefined;
	};
	return makeWaitableRetryDrivingLock({
		acquire(owner) {
			const session = currentSession();
			return session ? createSessionRetryDrivingLock(session).acquire(owner) : fallback.acquire(owner);
		},
		release(owner) {
			const session = currentSession();
			if (session) createSessionRetryDrivingLock(session).release(owner);
			else fallback.release(owner);
		},
		isHeld(owner) {
			const session = currentSession();
			return session ? createSessionRetryDrivingLock(session).isHeld(owner) : fallback.isHeld(owner);
		},
	});
}
