import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { formatRetryConfigError, retryConfigJsonSchema, retryConfigSchema } from "./retry-config-schema.ts";
import { type ResolvedRetryPolicy, resolveRetryPolicy } from "./retry-policy.ts";

type RetryPolicyLayerKind = "global" | "project";

type RetryPolicyLayer = Readonly<{
	kind: RetryPolicyLayerKind;
	path: string;
	text: string;
}>;

type RetryConfigRefusal = Readonly<
	| { path: string; reason: "group-writable" | "world-writable"; detail?: undefined }
	| {
			path: string;
			reason: "invalid";
			detail: string;
	  }
>;

type RetryPolicyReport = Readonly<{
	policy: ResolvedRetryPolicy;
	layers: readonly RetryPolicyLayer[];
	refusals: readonly RetryConfigRefusal[];
}>;

type RetryPolicyProjectInput = Readonly<{ cwd: string; trusted: boolean }>;

/** Global layer: the pi agent config dir (`PI_CODING_AGENT_DIR` via pi itself). */
function globalRetryConfigPath(input: { home?: string; env?: NodeJS.ProcessEnv } = {}): string {
	const env = input.env ?? process.env;
	if (env.PI_CODING_AGENT_DIR && env.PI_CODING_AGENT_DIR.trim() !== "") {
		return join(env.PI_CODING_AGENT_DIR.trim(), "extensions", "ppie-recover", "config.json");
	}
	return join(input.home ?? homedir(), ".pi", "agent", "extensions", "ppie-recover", "config.json");
}

/** Project layer: `<cwd>/<CONFIG_DIR_NAME>/ppie-recover.json`, read only when trusted. */
export function projectRetryConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "ppie-recover.json");
}

const SIDECAR_SCHEMA_NAME = "config.schema.json";
const sidecarSchemaText = `${JSON.stringify(retryConfigJsonSchema, null, 2)}\n`;

/**
 * Refresh the schema sitting beside a config file so editor validation always
 * matches the code that validates at load. Written only next to a config that
 * exists, and only when the content differs. A sync failure is never fatal:
 * the schema is an editor aid, and recovery must not depend on it.
 */
function syncSidecarSchema(configPath: string): void {
	const schemaPath = join(dirname(configPath), SIDECAR_SCHEMA_NAME);
	try {
		if (existsSync(schemaPath) && readFileSync(schemaPath, "utf8") === sidecarSchemaText) return;
		writeFileSync(schemaPath, sidecarSchemaText);
	} catch {
		// Read-only or unwritable config dir: keep loading the policy.
	}
}

function readLayer(
	kind: RetryPolicyLayerKind,
	path: string,
	refusals: RetryConfigRefusal[],
): RetryPolicyLayer | undefined {
	if (!existsSync(path)) return undefined;
	syncSidecarSchema(path);
	const mode = statSync(path).mode;
	if (mode & 0o002) {
		refusals.push({ path, reason: "world-writable" });
		return undefined;
	}
	if (mode & 0o020) {
		refusals.push({ path, reason: "group-writable" });
		return undefined;
	}
	return { kind, path, text: readFileSync(path, "utf8") };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Layers merge by deep-merging objects; arrays replace wholesale. */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (key === "$schema") continue; // the pointer belongs to the layer that owns the file
		merged[key] = isPlainObject(value) && isPlainObject(merged[key]) ? deepMerge(merged[key], value) : value;
	}
	return merged;
}

/**
 * Layered config resolution, replacing the removed env-var and CLI-flag
 * overrides: the global file under the pi agent config dir always applies; the
 * project file is read only when its session context is trusted, and an
 * untrusted project file is ignored entirely — never partially applied.
 * Layers are validated individually and merged before one normalization pass.
 * `explicitPath` remains as the test-injection seam.
 */
export function resolveRetryPolicyLayers(
	input: {
		explicitPath?: string | boolean;
		home?: string;
		env?: NodeJS.ProcessEnv;
		project?: RetryPolicyProjectInput;
	} = {},
): RetryPolicyReport {
	const refusals: RetryConfigRefusal[] = [];
	const explicitPath =
		typeof input.explicitPath === "string" && input.explicitPath.trim() !== ""
			? input.explicitPath.trim()
			: undefined;

	if (explicitPath !== undefined) {
		if (!isAbsolute(explicitPath)) throw new Error(`ppie-recover config path must be absolute: ${explicitPath}`);
		const layer = readLayer("global", explicitPath, refusals);
		if (!layer && refusals.length === 0) {
			throw new Error(`ppie-recover config file does not exist: ${explicitPath}`);
		}
		if (!layer) return { policy: resolveRetryPolicy(undefined), layers: [], refusals };
		const parsed = parseLayer(layer);
		if (!parsed.ok) throw new Error(parsed.detail);
		return { policy: resolveRetryPolicy(parsed.config), layers: [layer], refusals };
	}

	// A session must never lose recovery to a bad file: an unusable layer is
	// refused and reported, and the remaining layers still apply.
	const layers: RetryPolicyLayer[] = [];
	let merged: Record<string, unknown> | undefined;
	const candidates = [readLayer("global", globalRetryConfigPath({ home: input.home, env: input.env }), refusals)];
	if (input.project?.trusted) {
		candidates.push(readLayer("project", projectRetryConfigPath(input.project.cwd), refusals));
	}
	for (const layer of candidates) {
		if (!layer) continue;
		const parsed = parseLayer(layer);
		if (!parsed.ok) {
			refusals.push({ path: layer.path, reason: "invalid", detail: parsed.detail });
			continue;
		}
		layers.push(layer);
		merged = merged === undefined ? parsed.config : deepMerge(merged, parsed.config);
	}
	return { policy: resolveRetryPolicy(merged), layers, refusals };
}

type ParsedLayer = { ok: true; config: Record<string, unknown> } | { ok: false; detail: string };

function parseLayer(layer: RetryPolicyLayer): ParsedLayer {
	let parsed: unknown;
	try {
		parsed = JSON.parse(layer.text);
	} catch (err) {
		return { ok: false, detail: `${layer.path}: invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!isPlainObject(parsed)) return { ok: false, detail: `${layer.path}: config must be a JSON object` };
	const validation = retryConfigSchema.safeParse(parsed);
	if (!validation.success) return { ok: false, detail: formatRetryConfigError(validation.error, layer.path) };
	const config = validation.data as Record<string, unknown>;
	try {
		resolveRetryPolicy(config);
	} catch (err) {
		return { ok: false, detail: `${layer.path}: ${err instanceof Error ? err.message : String(err)}` };
	}
	return { ok: true, config };
}

export function loadRetryPolicy(
	input: {
		explicitPath?: string | boolean;
		home?: string;
		env?: NodeJS.ProcessEnv;
		project?: RetryPolicyProjectInput;
	} = {},
): ResolvedRetryPolicy {
	return resolveRetryPolicyLayers(input).policy;
}
