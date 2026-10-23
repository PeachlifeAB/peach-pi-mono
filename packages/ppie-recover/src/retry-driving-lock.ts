export type RetryDrivingLock = {
	acquire(owner: symbol): boolean;
	acquireWhenAvailable(owner: symbol, signal?: AbortSignal): Promise<boolean>;
	release(owner: symbol): void;
	isHeld(owner?: symbol): boolean;
};

export type BasicRetryDrivingLock = Omit<RetryDrivingLock, "acquireWhenAvailable">;

export function makeWaitableRetryDrivingLock(lock: BasicRetryDrivingLock): RetryDrivingLock {
	type Waiter = { owner: symbol; signal?: AbortSignal; resolve: (acquired: boolean) => void; abort: () => void };
	const waiters: Waiter[] = [];
	const drain = (): void => {
		while (waiters.length > 0) {
			const waiter = waiters[0];
			if (waiter.signal?.aborted) {
				waiters.shift();
				waiter.resolve(false);
				continue;
			}
			if (!lock.acquire(waiter.owner)) return;
			waiters.shift();
			waiter.signal?.removeEventListener("abort", waiter.abort);
			waiter.resolve(true);
			return;
		}
	};
	return {
		acquire: lock.acquire,
		acquireWhenAvailable(owner, signal) {
			if (signal?.aborted) return Promise.resolve(false);
			if (lock.acquire(owner)) return Promise.resolve(true);
			return new Promise((resolve) => {
				const waiter: Waiter = {
					owner,
					signal,
					resolve,
					abort: () => {
						const index = waiters.indexOf(waiter);
						if (index >= 0) waiters.splice(index, 1);
						resolve(false);
					},
				};
				waiters.push(waiter);
				signal?.addEventListener("abort", waiter.abort, { once: true });
			});
		},
		release(owner) {
			lock.release(owner);
			drain();
		},
		isHeld: lock.isHeld,
	};
}

export function createStandaloneRetryDrivingLock(): RetryDrivingLock {
	let owner: symbol | undefined;
	return makeWaitableRetryDrivingLock({
		acquire(nextOwner) {
			if (owner !== undefined) return false;
			owner = nextOwner;
			return true;
		},
		release(releaseOwner) {
			if (owner === releaseOwner) owner = undefined;
		},
		isHeld(queryOwner) {
			return queryOwner === undefined ? owner !== undefined : owner === queryOwner;
		},
	});
}
