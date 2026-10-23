import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type NotifyLevel = "info" | "warning" | "error";

export type CompactionOutcome =
	| { kind: "completed" }
	| { kind: "already-compacted"; error: Error }
	| { kind: "nothing-to-compact"; error: Error }
	| { kind: "failed"; error: Error };

type CompactOptions = {
	setStatus: (ctx: ExtensionContext, value: string) => void;
	notify: (message: string, level?: NotifyLevel) => void;
};

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function classifyCompactionError(error: Error): CompactionOutcome {
	if (error.message === "Already compacted") {
		return { kind: "already-compacted", error };
	}
	if (/nothing to compact/i.test(error.message)) {
		return { kind: "nothing-to-compact", error };
	}
	return { kind: "failed", error };
}

export function createCompact({ setStatus, notify }: CompactOptions) {
	return async (ctx: ExtensionContext): Promise<CompactionOutcome> => {
		setStatus(ctx, "🗜️ compacting");
		notify("Context recovery needs compaction before retry…", "warning");
		return await new Promise<CompactionOutcome>((resolve) => {
			try {
				ctx.compact({
					onComplete: () => resolve({ kind: "completed" }),
					onError: (error) => resolve(classifyCompactionError(asError(error))),
				});
			} catch (error) {
				resolve(classifyCompactionError(asError(error)));
			}
		});
	};
}
