// A max_attempts: 0 decision must also stop Pi's own auto-retry, or ppie-recover
// reports "not retried" while the host retries anyway.
const retryVetoByManager = new WeakMap<object, (errorMessage: string) => boolean>();

export function registerRetryVeto(sessionManager: object, veto: (errorMessage: string) => boolean): void {
	retryVetoByManager.set(sessionManager, veto);
}

/** True when ppie-recover has ruled out any retry of this failed message. */
export function vetoesRetry(sessionManager: object, message: unknown): boolean {
	const errorMessage = (message as { errorMessage?: unknown } | undefined)?.errorMessage;
	return typeof errorMessage === "string" && retryVetoByManager.get(sessionManager)?.(errorMessage) === true;
}
