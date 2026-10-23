import type { ErrorClass } from "./error-classifier.ts";

type ReplayGuardInput = {
	errorClass: ErrorClass | undefined;
	activeErrorSignature: string | undefined;
	lastErrorSignature: string | undefined;
	currentPayloadChars: number;
	lastSentPayloadChars: number | undefined;
};

export function shouldStopUnshrunkOverflowReplay({
	errorClass,
	activeErrorSignature,
	lastErrorSignature,
	currentPayloadChars,
	lastSentPayloadChars,
}: ReplayGuardInput): boolean {
	const guardApplies = errorClass === "context_overflow" || errorClass === "opaque_overflow";
	return (
		guardApplies &&
		activeErrorSignature !== undefined &&
		currentPayloadChars === lastSentPayloadChars &&
		lastErrorSignature === activeErrorSignature
	);
}
