import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OpenAIProviderConfig } from "./config.ts";

/**
 * Provider wire logging.
 *
 * pi exposes no logging API for extensions; the sanctioned pattern is plain
 * `node:fs` writing under `CONFIG_DIR_NAME` (`.pi`) in the project directory.
 * This file is both the reference implementation of that pattern and the
 * debugging tool for the providers registered by this package.
 *
 * Logging is opt-in, because provider requests carry prompt content. Enable it
 * either per-run with the `--ppie-custom-provider-log` flag (registered in `misc.ts`) or
 * persistently with `log.enabled` in `openai-provider.json`; output lands in
 * `.pi/provider-payload.log`:
 *
 *   pi --ppie-custom-provider-log
 */

const LOG_FILE_NAME = "provider-payload.log";

/** Header values that must never be written to disk. */
const REDACTED_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"api-key",
	"cookie",
	"set-cookie",
	"proxy-authorization",
	"cf-aig-authorization",
]);

/** Payload fields that can carry credentials or user/model prompt content. */
const REDACTED_PAYLOAD_FIELDS = new Set([
	"access",
	"access_token",
	"api_key",
	"apikey",
	"authorization",
	"content",
	"input",
	"instructions",
	"messages",
	"prompt",
	"reasoning_content",
	"refresh",
	"refresh_token",
	"system",
	"text",
	"thinking",
	"token",
	"tool_calls",
]);

/**
 * Resolves the log path, creating `.pi/` if needed. Returns undefined when the
 * directory cannot be created (read-only mount, bad cwd) so callers skip the
 * write rather than throwing inside an event handler.
 */
function resolveLogPath(cwd: string): string | undefined {
	try {
		const dir = join(cwd, CONFIG_DIR_NAME);
		// The config dir normally exists, but a fresh project may not have one yet.
		mkdirSync(dir, { recursive: true });
		return join(dir, LOG_FILE_NAME);
	} catch {
		return undefined;
	}
}

/** Rotates to a single `.1` backup once the log exceeds the configured size. */
function rotateIfLarge(logFile: string, maxBytes: number): void {
	try {
		if (statSync(logFile).size > maxBytes) {
			renameSync(logFile, `${logFile}.1`);
		}
	} catch {
		// Missing file is the normal first-write case; nothing to rotate.
	}
}

/**
 * Appends one record. Never throws: a logging failure must not break the
 * agent turn that triggered it.
 */
function appendRecord(logFile: string, label: string, body: string, maxBytes: number): void {
	try {
		rotateIfLarge(logFile, maxBytes);
		appendFileSync(logFile, `--- ${label} @ ${new Date().toISOString()} ---\n${body}\n\n`, "utf8");
	} catch {
		// Disk full, read-only mount, permissions — degrade silently.
	}
}

/**
 * Strips credential-bearing headers before anything reaches disk. Accepts
 * `ProviderHeaders` (`Record<string, string | null>`) as well as a plain
 * response header map — in `before_provider_headers` a null value means the
 * header is being deleted, which is worth seeing in the log.
 */
function redactHeaders(headers: Record<string, string | null>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => {
			if (REDACTED_HEADERS.has(key.toLowerCase())) return [key, "<redacted>"];
			return [key, value === null ? "<deleted>" : value];
		}),
	);
}

/**
 * `JSON.stringify` that survives circular references and oversized payloads —
 * a provider payload is arbitrary provider-shaped data, not guaranteed-safe JSON.
 */
function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		const serialized = JSON.stringify(
			value,
			(_key, val) => {
				if (typeof val === "object" && val !== null) {
					if (seen.has(val)) return "<circular>";
					seen.add(val);
				}
				return val;
			},
			2,
		);
		return serialized ?? "<unserializable>";
	} catch (error) {
		return `<unserializable: ${error instanceof Error ? error.message : String(error)}>`;
	}
}

/** Replaces sensitive payload values before the logger serializes them. */
function redactPayload(value: unknown, seen = new WeakSet<object>()): unknown {
	if (Array.isArray(value)) return value.map((item) => redactPayload(item, seen));
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return "<circular>";
	seen.add(value);

	return Object.fromEntries(
		Object.entries(value).map(([key, nested]) => [
			key,
			REDACTED_PAYLOAD_FIELDS.has(key.toLowerCase()) ? "<redacted>" : redactPayload(nested, seen),
		]),
	);
}

/**
 * Registers provider wire logging plus a payload-rewrite demonstration.
 *
 * Note both handlers are deliberately **synchronous**. `before_provider_request`
 * has result type `unknown`, and any returned value *replaces* the outgoing
 * payload — so an `async` handler would return a Promise and corrupt the
 * request. Returning `undefined` leaves the payload untouched.
 */
/**
 * Logging is opt-in because provider requests can contain sensitive prompts.
 * The per-run flag and the persistent config setting are both honored, so a
 * user can enable it for one session without editing a file.
 */
export function resolveLoggingEnabled(pi: ExtensionAPI, config: OpenAIProviderConfig): boolean {
	return pi.getFlag("ppie-custom-provider-log") === true || config.log.enabled;
}

/**
 * Declares the flag `resolveLoggingEnabled` reads. It lives here, beside its only
 * consumer, rather than in the unregistered API-coverage modules.
 */
export function registerLogFlag(pi: ExtensionAPI): void {
	// Provider requests can contain prompts and credentials. Logging therefore
	// starts disabled and must be enabled explicitly with this boolean on-switch.
	pi.registerFlag("ppie-custom-provider-log", {
		description: "Log redacted pi events and provider metadata to .pi/provider-payload.log",
		type: "boolean",
		default: false,
	});
}

/**
 * Writes one record, gated on the flag and config. Exported so handlers that
 * must live elsewhere (notably `project_trust`, which cannot be observed without
 * casting a trust vote) can still contribute to the same log.
 */
export function logEvent(
	loggingEnabled: boolean,
	config: OpenAIProviderConfig,
	cwd: string,
	label: string,
	body: unknown,
): void {
	if (!loggingEnabled) return;
	const logFile = resolveLogPath(cwd);
	if (!logFile) return;
	appendRecord(
		logFile,
		label,
		typeof body === "string" ? body : safeStringify(redactPayload(body)),
		config.log.maxBytes,
	);
}

export function registerLogging(pi: ExtensionAPI, config: OpenAIProviderConfig) {
	const loggingEnabled = resolveLoggingEnabled(pi, config);
	// A replacement invalidates callback contexts. The process cwd is plain data
	// captured while this extension instance is active, so observational handlers
	// can still log without dereferencing a stale context.
	const cwd = process.cwd();
	const log = (label: string, body: unknown) => logEvent(loggingEnabled, config, cwd, label, body);

	pi.on("before_provider_request", (event) => {
		log("before_provider_request", event.payload);
		return undefined;
	});
	pi.on("before_provider_headers", (event) => log("before_provider_headers", redactHeaders(event.headers)));
	pi.on("after_provider_response", (event) => {
		log(`after_provider_response ${event.status}`, redactHeaders(event.headers));
		if (event.status === 429) {
			const retryAfter = event.headers["retry-after"] ?? event.headers["Retry-After"];
			log("rate limited", `retry-after: ${retryAfter ?? "(not sent)"}`);
		}
	});

	// Observational handlers return undefined so they never alter Pi decisions.
	pi.on("session_start", (event) => log("session_start", event));
	pi.on("session_info_changed", (event) => log("session_info_changed", event));
	pi.on("session_compact", (event) => log("session_compact", event));
	pi.on("session_tree", (event) => log("session_tree", event));
	pi.on("session_shutdown", (event) => log("session_shutdown", event));
	pi.on("session_before_switch", (event) => log("session_before_switch", event));
	pi.on("session_before_fork", (event) => log("session_before_fork", event));
	pi.on("session_before_compact", (event) => log("session_before_compact", event));
	pi.on("session_before_tree", (event) => log("session_before_tree", event));
	pi.on("before_agent_start", (event) => log("before_agent_start", event));
	pi.on("agent_start", (event) => log("agent_start", event));
	pi.on("agent_end", (event) => log("agent_end", event));
	pi.on("agent_settled", (event) => log("agent_settled", event));
	pi.on("turn_start", (event) => log("turn_start", event));
	pi.on("turn_end", (event) => log("turn_end", event));
	pi.on("message_start", (event) => log("message_start", event));
	pi.on("message_update", () => log("message_update", "<delta>"));
	pi.on("message_end", (event) => log("message_end", event));
	pi.on("tool_execution_start", (event) => log("tool_execution_start", event));
	pi.on("tool_execution_update", (event) => log("tool_execution_update", event));
	pi.on("tool_execution_end", (event) => log("tool_execution_end", event));
	pi.on("tool_call", (event) => log("tool_call", event));
	pi.on("tool_result", (event) => log("tool_result", event));
	pi.on("model_select", (event) => log("model_select", event));
	pi.on("thinking_level_select", (event) => log("thinking_level_select", event));
	pi.on("user_bash", (event) => log("user_bash", event));
	pi.on("input", (event) => log("input", event));
	pi.on("context", (event) => log("context", `${event.messages.length} messages`));
	pi.on("resources_discover", (event) => log("resources_discover", event));
}
