export type CompactionRequestOwner = "dynamic" | "context-overflow" | "length-overflow" | "memory-guard";

export type CoordinatorDisposition =
	| "caller-continuation"
	| "core-continuation"
	| "unavailable"
	| "stalled"
	| "cancelled";

export type CoordinatorDispositionEvent = {
	requestId: number;
	owner: CompactionRequestOwner;
	attempt: number;
	lifecycleEpoch: number | undefined;
	disposition: CoordinatorDisposition;
	reason: string;
};

export type CoordinatorTelemetryPort = {
	onDisposition(event: CoordinatorDispositionEvent): void;
};

export function createDispositionEmitter(telemetry: CoordinatorTelemetryPort | undefined) {
	return (
		request: {
			id: number;
			owner: CompactionRequestOwner;
			attempt: number;
			observedLifecycleEpoch?: number;
		},
		disposition: CoordinatorDisposition,
		reason: string,
	) => {
		telemetry?.onDisposition({
			requestId: request.id,
			owner: request.owner,
			attempt: request.attempt,
			lifecycleEpoch: request.observedLifecycleEpoch,
			disposition,
			reason,
		});
	};
}
