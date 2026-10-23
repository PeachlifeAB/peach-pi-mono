import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RetryEngine } from "./agent-retry.ts";
import type { LengthStopHandler } from "./length-stop.ts";
import type { OverflowRecovery } from "./overflow-recovery.ts";
import type { ResolvedRetryPolicy } from "./retry-policy-types.ts";
import { lastAssistantMessage } from "./retry-utils.ts";

type NotifyLevel = "info" | "warning" | "error";

const done = Promise.resolve();

export function fallbackPolicyDiagnostic(policy: ResolvedRetryPolicy): string {
	const chains = policy.errorRules
		.filter((rule) => rule.fallbackModels.length > 0)
		.map((rule) => `${rule.rule}=[${rule.fallbackModels.join(", ")}]`);
	return `Model fallback: ${policy.fallbackEnabled ? "enabled" : "disabled"}; max_hops=${policy.maxFallbackHops}; chains=${chains.join("; ") || "none"}`;
}

type RegisterRetryCommandOptions = {
	pi: ExtensionAPI;
	engine: RetryEngine;
	lengthStop: LengthStopHandler;
	recovery: OverflowRecovery;
	policy?: ResolvedRetryPolicy;
	notify: (message: string, level?: NotifyLevel) => void;
	setNotify: (ctx: ExtensionContext) => void;
	clearUserAborted: () => void;
	triggerRetry: (ctx: ExtensionContext) => void;
};

export function registerRetryCommand({
	pi,
	engine,
	lengthStop,
	recovery,
	policy,
	notify,
	setNotify,
	clearUserAborted,
	triggerRetry,
}: RegisterRetryCommandOptions) {
	const retryHandler = async (_args: string, ctx: ExtensionContext) => {
		setNotify(ctx);

		const last = lastAssistantMessage(ctx);

		if (last?.stopReason !== "error" && last?.stopReason !== "length") {
			notify("No failed assistant turn to retry.", "warning");
			return done;
		}

		clearUserAborted();
		engine.cancel();

		if (last.stopReason === "length") {
			lengthStop.handle(ctx, last);
			return done;
		}

		notify("Manually retrying…", "info");
		triggerRetry(ctx);
		return done;
	};

	pi.registerCommand("retry", {
		description: "Manually trigger an invisible retry of the last failed turn.",
		handler: retryHandler,
	});

	pi.registerCommand("retry:list-unclassified", {
		description: "List provider error messages that fell through to generic retry unrecognized (no matching class).",
		handler: (_args, ctx) => {
			setNotify(ctx);

			const unclassified = recovery.listUnclassifiedErrors();

			if (unclassified.length === 0) {
				notify("No unclassified provider errors recorded this session.", "info");
				return done;
			}

			const lines = unclassified.map((entry) => `× ${entry.count}  ${entry.signature}`);
			notify(`Unclassified provider errors:\n${lines.join("\n")}`, "info");
			return done;
		},
	});

	// Opt-in environment diagnostic. ExtensionAPI exposes no loaded-extension
	// introspection and no host-version property, so a startup self-check is
	// not possible; this user-invoked command shells out to read-only `pi list`.
	// Two extensions hooking message_end/session_compact under ppie-recover-like
	// names race, and a crash in one silently blocks the other's event handling
	// (CLAUDE.local.md documents a real instance). Each package resolves to
	// exactly one absolute path line, so counting distinct absolute paths
	// containing "ppie-recover" counts packages without false positives.
	pi.registerCommand("retry:doctor", {
		description:
			"Diagnose environment hazards ppie-recover can't auto-detect: duplicate ppie-recover-like packages (which race on shared hooks) and the host pi version.",
		handler: async (_args, ctx) => {
			setNotify(ctx);

			const findings: string[] = [];
			let warned = false;

			try {
				const list = await pi.exec("pi", ["list", "--approve"], {
					timeout: 5000,
				});
				if (list.code === 0) {
					const retryPaths = [
						...new Set(
							list.stdout
								.split(/\r?\n/)
								.map((line) => line.trim())
								.filter((line) => line.startsWith("/") && /ppie-recover/i.test(line)),
						),
					];
					if (retryPaths.length >= 2) {
						warned = true;
						findings.push(
							`⚠️ ${retryPaths.length} ppie-recover-like packages are loaded — they race on message_end/session_compact. Remove all but one: ${retryPaths.join(", ")}`,
						);
					}
				} else {
					findings.push(
						`\`pi list\` exited ${list.code}; could not check for duplicate packages. Run \`pi list\` manually.`,
					);
				}
			} catch (err) {
				findings.push(
					`\`pi list\` failed (${err instanceof Error ? err.message : String(err)}); could not check for duplicate packages. Run \`pi list\` manually.`,
				);
			}

			// Host pi version is informational only: there is no reliable
			// expected-version source available to the extension at runtime,
			// so surface it for the user to compare against ppie-recover's
			// supported version in the README.
			try {
				const ver = await pi.exec("pi", ["--version"], {
					timeout: 5000,
				});
				if (ver.code === 0 && ver.stdout.trim()) {
					findings.push(`Host pi version: ${ver.stdout.trim()}`);
				}
			} catch {
				// Version is informational; ignore failures.
			}

			const policyDiagnostic = policy ? fallbackPolicyDiagnostic(policy) : undefined;
			if (findings.length === 0) {
				notify(
					`retry:doctor — no hazards detected: single ppie-recover package loaded.${policyDiagnostic ? ` | ${policyDiagnostic}` : ""}`,
					"info",
				);
			} else {
				notify(
					[...findings, ...(policyDiagnostic ? [policyDiagnostic] : [])].join(" | "),
					warned ? "warning" : "info",
				);
			}
			return done;
		},
	});
}
