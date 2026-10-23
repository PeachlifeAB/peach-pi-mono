import type { CompactionFailureOutcome, CompactionIdentity, ContinuationOwner } from "./recovery-chain.ts";

export type HostCompactionObserver = Readonly<{
	started(identity: CompactionIdentity): void;
	completed(identity: CompactionIdentity, continuationOwner: ContinuationOwner): void;
	failed(identity: CompactionIdentity, outcome: CompactionFailureOutcome): void;
}>;

type Outcome =
	| Readonly<{ kind: "completed"; continuationOwner: ContinuationOwner }>
	| Readonly<{ kind: "failed"; outcome: CompactionFailureOutcome }>;

type Lifecycle = {
	identity: CompactionIdentity;
	generation: string;
	outcome?: Outcome;
	observer?: HostCompactionObserver;
};

export function createHostCompactionJournal(initialGeneration: string) {
	let generation = initialGeneration;
	let sequence = 0;
	let active: Lifecycle | undefined;
	let lifecycles: Lifecycle[] = [];

	const publishOutcome = (lifecycle: Lifecycle): void => {
		const { observer, outcome, identity } = lifecycle;
		if (!observer || !outcome) return;
		if (outcome.kind === "completed") observer.completed(identity, outcome.continuationOwner);
		else observer.failed(identity, outcome.outcome);
	};
	const settle = (outcome: Outcome): void => {
		if (!active || active.generation !== generation || active.outcome) return;
		active.outcome = outcome;
		publishOutcome(active);
	};

	return {
		started(input: { identity?: CompactionIdentity; signal?: AbortSignal } = {}): CompactionIdentity {
			const lifecycle: Lifecycle = {
				generation,
				identity: input.identity ?? {
					owner: "external",
					requestId: `host-compaction-${++sequence}`,
					lifecycleEpoch: sequence,
				},
			};
			active = lifecycle;
			lifecycles.push(lifecycle);
			input.signal?.addEventListener("abort", () => settle({ kind: "failed", outcome: "aborted" }), {
				once: true,
			});
			return lifecycle.identity;
		},
		completed(input: { willRetry: boolean }): void {
			settle({
				kind: "completed",
				continuationOwner: input.willRetry ? "core" : "ppie-recover",
			});
			active = undefined;
		},
		failed(outcome: CompactionFailureOutcome): void {
			settle({ kind: "failed", outcome });
			active = undefined;
		},
		claim(observer: HostCompactionObserver): void {
			for (const lifecycle of lifecycles) {
				if (lifecycle.generation !== generation || lifecycle.observer) continue;
				lifecycle.observer = observer;
				observer.started(lifecycle.identity);
				publishOutcome(lifecycle);
			}
			lifecycles = lifecycles.filter((lifecycle) => !lifecycle.outcome);
		},
		clear(): void {
			active = undefined;
			lifecycles = [];
		},
		changeGeneration(next: string): void {
			generation = next;
			active = undefined;
			lifecycles = [];
		},
	};
}

export type HostCompactionJournal = ReturnType<typeof createHostCompactionJournal>;
