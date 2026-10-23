type ModelFallbackOutcome = "hop" | "resolution-failed" | "switch-rejected" | "stand-down" | "terminated";

export type ModelFallbackRecord = Readonly<{
	sequenceId: string;
	timestamp: string;
	hopIndex: number;
	failedModel: string;
	candidateModel?: string;
	servingModel?: string;
	outcome: ModelFallbackOutcome;
	reason: string;
	status?: number;
	elapsedMs: number;
}>;

export type ModelFallbackTerminalRecord = ModelFallbackRecord &
	Readonly<{ outcome: "terminated"; trace: readonly ModelFallbackRecord[] }>;

export type ModelFallbackSequence = Readonly<{
	sequenceId: string;
	originatingModel: string;
	startedAtMs: number;
	records: readonly ModelFallbackRecord[];
	visitedModels: ReadonlySet<string>;
	successfulSwitches: number;
	state: "active" | "terminal" | "cancelled";
}>;

type OutcomeInput = Readonly<{
	atMs: number;
	failedModel: string;
	candidateModel?: string;
	servingModel?: string;
	outcome: Exclude<ModelFallbackOutcome, "terminated">;
	reason: string;
	status?: number;
}>;

type TerminalInput = Readonly<{
	atMs: number;
	failedModel: string;
	candidateModel?: string;
	servingModel?: string;
	reason: string;
	status?: number;
	cancelled?: boolean;
}>;

export type FallbackCandidateSelection =
	| Readonly<{ kind: "candidate"; sequence: ModelFallbackSequence; candidateModel: string }>
	| Readonly<{
			kind: "exhausted";
			sequence: ModelFallbackSequence;
			reason: "chain-exhausted" | "hop-limit" | "sequence-stopped";
	  }>;

function createRecord(
	sequence: ModelFallbackSequence,
	input: OutcomeInput | TerminalInput,
	outcome: ModelFallbackOutcome,
): ModelFallbackRecord {
	const successfulSwitches = sequence.successfulSwitches + (outcome === "hop" ? 1 : 0);
	return Object.freeze({
		sequenceId: sequence.sequenceId,
		timestamp: new Date(input.atMs).toISOString(),
		hopIndex: successfulSwitches,
		failedModel: input.failedModel,
		candidateModel: input.candidateModel,
		servingModel: input.servingModel,
		outcome,
		reason: input.reason,
		status: input.status,
		elapsedMs: input.atMs - sequence.startedAtMs,
	});
}

export function createModelFallbackSequence(input: {
	sequenceId: string;
	failedModel: string;
	startedAtMs: number;
}): ModelFallbackSequence {
	return Object.freeze({
		sequenceId: input.sequenceId,
		originatingModel: input.failedModel,
		startedAtMs: input.startedAtMs,
		records: Object.freeze([]),
		visitedModels: new Set([input.failedModel]),
		successfulSwitches: 0,
		state: "active",
	});
}

export function selectNextFallbackCandidate(
	sequence: ModelFallbackSequence,
	candidateModels: readonly string[],
	maxHops: number,
): FallbackCandidateSelection {
	if (sequence.state !== "active") return { kind: "exhausted", sequence, reason: "sequence-stopped" };
	if (sequence.successfulSwitches >= maxHops) return { kind: "exhausted", sequence, reason: "hop-limit" };
	const candidateModel = candidateModels.find((candidate) => !sequence.visitedModels.has(candidate));
	if (candidateModel === undefined) return { kind: "exhausted", sequence, reason: "chain-exhausted" };
	const visitedModels = new Set(sequence.visitedModels);
	visitedModels.add(candidateModel);
	return {
		kind: "candidate",
		candidateModel,
		sequence: Object.freeze({ ...sequence, visitedModels }),
	};
}

export function recordModelFallbackOutcome(
	sequence: ModelFallbackSequence,
	input: OutcomeInput,
): ModelFallbackSequence {
	const record = createRecord(sequence, input, input.outcome);
	return Object.freeze({
		...sequence,
		records: Object.freeze([...sequence.records, record]),
		successfulSwitches: sequence.successfulSwitches + (input.outcome === "hop" ? 1 : 0),
	});
}

export function terminateModelFallbackSequence(
	sequence: ModelFallbackSequence,
	input: TerminalInput,
): Readonly<{ sequence: ModelFallbackSequence; record: ModelFallbackTerminalRecord }> {
	const terminalOutcome = createRecord(sequence, input, "terminated");
	const record = Object.freeze({
		...terminalOutcome,
		outcome: "terminated" as const,
		trace: Object.freeze([...sequence.records, terminalOutcome]),
	});
	return Object.freeze({
		record,
		sequence: Object.freeze({
			...sequence,
			records: Object.freeze([...sequence.records, record]),
			state: input.cancelled ? "cancelled" : "terminal",
		}),
	});
}
