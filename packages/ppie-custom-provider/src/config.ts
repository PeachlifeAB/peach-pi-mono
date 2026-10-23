import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Extension configuration.
 *
 * pi's own `settings.json` has a fixed schema with no extension namespace, and
 * `ExtensionAPI` exposes no method to read it — so extension config lives in a
 * dedicated sidecar, the convention every installed extension follows
 * (`interactive-shell.json`, `boomerang.json`, `pi-goal.json`, ...).
 *
 * Global:  <agent dir>/openai-provider.json
 * Project: <cwd>/.pi/openai-provider.json   (overrides global, per key)
 *
 * See docs/adr/adr-0002-extension-configuration-sidecar-file.md.
 *
 * Deliberately absent, and not to be added:
 *
 * - `contextWindow` / `maxTokens` — the server reports them where it can and pi
 *   resolves them otherwise. A config value contradicting the server produces
 *   silent truncation the user cannot trace. See ADR-0001.
 * - `apiKey` — belongs in pi's mode-restricted credential store via `/login`,
 *   not a plain config file.
 * - timeouts — pi's core settings govern; a deadline invented here would sever
 *   legitimate long generations. See ADR-0003.
 * - `headers` — already fully expressible in pi's `models.json`.
 */

export const CONFIG_FILE_NAME = "openai-provider.json";

/** Matches llama.cpp's shipped default: a real URL, not an empty string. */
const DEFAULT_BASE_URL = "http://localhost:1234/v1";

/** OpenAI-compatible servers expose the catalog here. */
const DEFAULT_DISCOVERY_PATH = "/models";

/** Rotate the wire log past this size so a long session cannot fill the disk. */
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

type ModelCompat = NonNullable<Model<Api>["compat"]>;

interface DiscoveryConfig {
	/** Fetch the catalog from the server. Off means only statically declared models. */
	enabled: boolean;
	/** Catalog path, appended to `baseUrl`. */
	path: string;
}

interface LogConfig {
	/** Off by default: provider payloads contain prompt content. */
	enabled: boolean;
	maxBytes: number;
}

export interface OpenAIProviderConfig {
	baseUrl: string;
	discovery: DiscoveryConfig;
	/**
	 * Extra overflow phrase for servers whose wording pi does not recognize.
	 * Empty (the default) leaves pi's own detection to act alone; a value here is
	 * additive, never a replacement.
	 */
	overflowPattern: string;
	/**
	 * Per-field overrides on top of pi's own compat detection. Empty by default so
	 * detection runs — pi already encodes the quirks of ten hosted gateways, and a
	 * blanket block here would override it for all of them. Needed mainly when a
	 * recognized gateway sits behind a hostname detection cannot match. See ADR-0001.
	 */
	compat: ModelCompat;
	log: LogConfig;
}

export const DEFAULT_CONFIG: OpenAIProviderConfig = {
	baseUrl: DEFAULT_BASE_URL,
	discovery: {
		enabled: true,
		path: DEFAULT_DISCOVERY_PATH,
	},
	overflowPattern: "",
	compat: {},
	log: {
		enabled: false,
		maxBytes: DEFAULT_LOG_MAX_BYTES,
	},
};

export function loadConfig(cwd: string): OpenAIProviderConfig {
	const globalPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const projectPath = join(cwd, ".pi", CONFIG_FILE_NAME);

	const globalConfig = readConfigFile(globalPath);
	const projectConfig = readConfigFile(projectPath);

	const merged = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };

	return {
		baseUrl: resolveString(merged.baseUrl, DEFAULT_CONFIG.baseUrl),
		discovery: mergeDiscovery(globalConfig.discovery, projectConfig.discovery),
		overflowPattern: resolveOverflowPattern(merged.overflowPattern),
		compat: isPlainObject(merged.compat) ? (merged.compat as ModelCompat) : DEFAULT_CONFIG.compat,
		log: mergeLog(globalConfig.log, projectConfig.log),
	};
}

/** Never throws: unreadable or malformed config must not stop pi from starting. */
function readConfigFile(path: string): Partial<OpenAIProviderConfig> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return isPlainObject(parsed) ? (parsed as Partial<OpenAIProviderConfig>) : {};
	} catch (error) {
		console.error(`Warning: Could not parse ${path}:`, error);
		return {};
	}
}

function mergeDiscovery(globalValue: unknown, projectValue: unknown): DiscoveryConfig {
	const globalDiscovery = isPlainObject(globalValue) ? globalValue : undefined;
	const projectDiscovery = isPlainObject(projectValue) ? projectValue : undefined;

	return {
		enabled: resolveBoolean(projectDiscovery?.enabled ?? globalDiscovery?.enabled, DEFAULT_CONFIG.discovery.enabled),
		path: resolveString(projectDiscovery?.path ?? globalDiscovery?.path, DEFAULT_CONFIG.discovery.path),
	};
}

function mergeLog(globalValue: unknown, projectValue: unknown): LogConfig {
	const globalLog = isPlainObject(globalValue) ? globalValue : undefined;
	const projectLog = isPlainObject(projectValue) ? projectValue : undefined;

	return {
		enabled: resolveBoolean(projectLog?.enabled ?? globalLog?.enabled, DEFAULT_CONFIG.log.enabled),
		maxBytes: clampInt(projectLog?.maxBytes ?? globalLog?.maxBytes, DEFAULT_CONFIG.log.maxBytes, 1024, 1024 ** 3),
	};
}

/**
 * Compiles the pattern here so an invalid expression is reported once at load
 * and discarded, rather than throwing later inside an event handler.
 */
function resolveOverflowPattern(value: unknown): string {
	if (typeof value !== "string") return DEFAULT_CONFIG.overflowPattern;
	const trimmed = value.trim();
	if (trimmed.length === 0) return DEFAULT_CONFIG.overflowPattern;
	try {
		new RegExp(trimmed, "i");
		return trimmed;
	} catch (error) {
		console.error(`Warning: Ignoring invalid overflowPattern ${JSON.stringify(trimmed)}:`, error);
		return DEFAULT_CONFIG.overflowPattern;
	}
}

/** Compiled form of `overflowPattern`; undefined when unset, so pi's detection acts alone. */
export function overflowRegExp(config: OpenAIProviderConfig): RegExp | undefined {
	if (config.overflowPattern.length === 0) return undefined;
	try {
		return new RegExp(config.overflowPattern, "i");
	} catch {
		return undefined;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveString(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}
