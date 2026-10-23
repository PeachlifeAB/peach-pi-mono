import { classifyError, TRANSIENT_RE } from "./error-classifier.ts";
import { coreHandlesOverflow } from "./overflow-detection.ts";
import type { OverflowRecoveryState, UnclassifiedErrorRecord } from "./overflow-recovery-types.ts";
import { normalizeErrorSignature } from "./retry-utils.ts";

export function createOverflowClassification(options: { state: OverflowRecoveryState }) {
	const { state } = options;

	const classifyAndTrack = (errorMessage: string) => {
		const errorClass = classifyError(errorMessage);
		const signature = normalizeErrorSignature(errorMessage);
		state.activeErrorSignature = signature;
		state.activeErrorClass = errorClass;
		state.activeErrorMessage = errorMessage;
		if (errorClass === "transient" && !TRANSIENT_RE.test(errorMessage)) {
			const existing = state.unclassifiedErrors.get(signature);
			state.unclassifiedErrors.set(signature, {
				errorClass,
				signature,
				count: (existing?.count ?? 0) + 1,
			});
		}
		return { errorClass, signature };
	};

	const listUnclassifiedErrors = (): UnclassifiedErrorRecord[] => [...state.unclassifiedErrors.values()];

	const shouldDeferToCore = (errorMessage: string, signature: string): boolean => {
		if (!coreHandlesOverflow(errorMessage)) return false;
		if (state.deferredCoreOverflowSignature === signature) return false;
		state.deferredCoreOverflowSignature = signature;
		return true;
	};

	return {
		classifyAndTrack,
		listUnclassifiedErrors,
		shouldDeferToCore,
	};
}
