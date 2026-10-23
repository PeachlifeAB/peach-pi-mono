export function sleepUntilRetry(ms: number, shouldCancel: () => boolean, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (shouldCancel() || signal?.aborted) {
			resolve(true);
			return;
		}
		if (ms <= 0) {
			resolve(false);
			return;
		}

		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (cancelled: boolean) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(cancelled);
		};
		const onAbort = () => finish(true);

		signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => finish(shouldCancel() || signal?.aborted === true), ms);
	});
}
