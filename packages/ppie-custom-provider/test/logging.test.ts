import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredential, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { registerEventCoverage } from "../src/events.ts";
import extension from "../src/index.ts";
import { logEvent, registerLogging } from "../src/logging.ts";
import { registerNativeProvider } from "../src/native-provider.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function replacementHarness(flag = false) {
	const handlers = new Map<string, Handler[]>();
	// `registerProvider(provider)` — the documented single-argument form for a
	// complete pi-ai `Provider`, per extensions.md.
	const providers: Provider[] = [];
	let active = true;
	const pi = {
		on(event: string, handler: Handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		getFlag() {
			if (!active) throw new Error("stale extension context");
			return flag;
		},
		registerProvider(provider: Provider) {
			providers.push(provider);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		providers,
		invalidate: () => {
			active = false;
		},
		handler(event: string, index = 0): Handler {
			const handler = handlers.get(event)?.at(index);
			if (!handler) throw new Error(`Missing ${event} handler`);
			return handler;
		},
	};
}

const staleContext = new Proxy(
	{},
	{
		get() {
			throw new Error("extension ctx is stale");
		},
	},
);

describe("replacement-safe logging", () => {
	it("does not dereference the registered extension API from provider or settled handlers", () => {
		const harness = replacementHarness();
		registerLogging(harness.pi, DEFAULT_CONFIG);
		harness.invalidate();

		expect(() =>
			harness.handler("before_provider_request")({ payload: { model: "test" } }, staleContext),
		).not.toThrow();
		expect(harness.handler("before_provider_request")({ payload: { model: "test" } }, staleContext)).toBeUndefined();
		expect(() => harness.handler("before_provider_headers")({ headers: {} }, staleContext)).not.toThrow();
		expect(() => harness.handler("agent_settled")({}, staleContext)).not.toThrow();
	});

	it("suppresses stale context access in provider header and settled UI handlers", () => {
		const harness = replacementHarness();
		registerEventCoverage(harness.pi, DEFAULT_CONFIG);
		harness.invalidate();

		expect(() => harness.handler("before_provider_headers")({ headers: {} }, staleContext)).not.toThrow();
		expect(() => harness.handler("agent_settled")({}, staleContext)).not.toThrow();
	});
});

describe("payload redaction", () => {
	it("redacts sensitive nested fields and preserves safe values in logged arrays", () => {
		const cwd = mkdtempSync(join(tmpdir(), "ppie-custom-provider-redact-"));
		const shared = { token: "private-token", label: "safe-value" };
		const payload = {
			messages: ["private prompt"],
			metadata: { API_KEY: "private-key", safe: "visible" },
			items: [null, "plain text", shared, shared],
		};

		logEvent(true, DEFAULT_CONFIG, cwd, "payload", payload);

		const contents = readFileSync(join(cwd, ".pi", "provider-payload.log"), "utf8");
		expect(contents).not.toContain("private prompt");
		expect(contents).not.toContain("private-key");
		expect(contents).not.toContain("private-token");
		expect(contents).toContain("<redacted>");
		expect(contents).toContain("<circular>");
		expect(contents).toContain("visible");
		expect(contents).toContain("safe-value");
	});
});

/**
 * The adapter `registerNativeProvider` injects into the provider. Driven through
 * the real registration seam and a real cwd, because the behavior under test is
 * whether a record reaches disk — a stub sink would prove nothing about the gate.
 */
describe("discovery failure adapter", () => {
	// pi takes every catalog mutation through `publish`; this adapter test only
	// needs it to accept.
	const publish = async () => true;

	const credential: OAuthCredential = {
		type: "oauth",
		access: "",
		refresh: "",
		expires: 8640000000000000,
		serverUrl: "http://server:1234/v1",
	};

	function logContents(cwd: string): string | undefined {
		const logFile = join(cwd, ".pi", "provider-payload.log");
		return existsSync(logFile) ? readFileSync(logFile, "utf8") : undefined;
	}

	/** `logEvent` resolves the log path from the cwd captured at registration. */
	async function registerInTempCwd(flag: boolean) {
		const cwd = mkdtempSync(join(tmpdir(), "ppie-custom-provider-"));
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		const harness = replacementHarness(flag);
		// Registration now primes the catalog first, so it must be awaited.
		await registerNativeProvider(harness.pi, DEFAULT_CONFIG);
		const provider = harness.providers[0];
		if (!provider) throw new Error("Provider was not registered");
		return { cwd, harness, provider };
	}

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	// Regression: the extension declared the flag *after* registering the provider,
	// so the sink resolved `getFlag` for a flag that did not exist yet and every
	// discovery reason was discarded even with `--ppie-custom-provider-log` passed.
	it("declares the log flag before anything resolves it", async () => {
		const order: string[] = [];
		const pi = {
			on() {},
			registerFlag(name: string) {
				order.push(`registerFlag:${name}`);
			},
			getFlag(name: string) {
				order.push(`getFlag:${name}`);
				return false;
			},
			registerProvider() {
				order.push("registerProvider");
			},
		} as unknown as ExtensionAPI;

		await extension(pi);

		const declared = order.indexOf("registerFlag:ppie-custom-provider-log");
		const firstRead = order.indexOf("getFlag:ppie-custom-provider-log");
		expect(declared).toBeGreaterThanOrEqual(0);
		expect(firstRead).toBeGreaterThan(declared);
	});

	it("writes no record when logging is disabled", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:1234");
			}),
		);
		const { cwd, provider } = await registerInTempCwd(false);

		await expect(
			provider.refreshModels?.({ allowNetwork: true, publish, signal: new AbortController().signal, credential }),
		).rejects.toThrow();

		expect(logContents(cwd)).toBeUndefined();
	});

	it("records the discovery failure when the run flag enables logging", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:1234");
			}),
		);
		const { cwd, provider } = await registerInTempCwd(true);

		await expect(
			provider.refreshModels?.({ allowNetwork: true, publish, signal: new AbortController().signal, credential }),
		).rejects.toThrow();

		const contents = logContents(cwd);
		expect(contents).toContain("discovery_failed");
		expect(contents).toContain("http://server:1234/v1/models");
		expect(contents).toContain("connect ECONNREFUSED 127.0.0.1:1234");
	});

	// Following PPMONO-10: the adapter resolves the flag and cwd during
	// registration, so a refresh after session replacement must not reach back
	// through the extension API.
	it("reports without dereferencing the registered extension API", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:1234");
			}),
		);
		const { cwd, harness, provider } = await registerInTempCwd(true);
		harness.invalidate();

		await expect(
			provider.refreshModels?.({ allowNetwork: true, publish, signal: new AbortController().signal, credential }),
		).rejects.toThrow(/ECONNREFUSED/);

		expect(logContents(cwd)).toContain("discovery_failed");
	});
});
