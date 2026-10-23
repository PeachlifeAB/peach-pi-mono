import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { retryConfigSchemaText } from "../scripts/gen-retry-config-schema.ts";
import { DEFAULT_RETRY_POLICY } from "../src/retry-policy.ts";
import { loadRetryPolicy, projectRetryConfigPath, resolveRetryPolicyLayers } from "../src/retry-policy-node.ts";

function globalConfigPath(home: string): string {
	return join(home, ".pi", "agent", "extensions", "ppie-recover", "config.json");
}

function writeJson(path: string, config: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config));
}

test("missing config layers use built-in defaults and create nothing", () => {
	const home = mkdtempSync(join(tmpdir(), "ppie-recover-home-"));
	try {
		assert.deepEqual(loadRetryPolicy({ home, env: {} }), DEFAULT_RETRY_POLICY);
		assert.deepEqual(resolveRetryPolicyLayers({ home, env: {} }).layers, []);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("explicit missing config path and relative path fail visibly", () => {
	assert.throws(() => loadRetryPolicy({ explicitPath: "relative.json" }), /must be absolute/);
	assert.throws(
		() => loadRetryPolicy({ explicitPath: "/tmp/definitely-missing-ppie-recover.json" }),
		/does not exist/,
	);
});

test("explicit path remains a test-only injection seam", () => {
	const dir = mkdtempSync(join(tmpdir(), "ppie-recover-config-"));
	try {
		const path = join(dir, "config.json");
		writeJson(path, {
			memory_overflow_protection: {
				compaction: { enabled: true, dynamic: { enabled: true, at_context_ratio: 0.8 } },
			},
		});
		assert.equal(loadRetryPolicy({ explicitPath: path }).dynamicCompactionRatio, 0.8);
		writeFileSync(path, "{");
		assert.throws(() => loadRetryPolicy({ explicitPath: path }), /invalid JSON/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("trusted project config deep-merges over the global layer while arrays replace", () => {
	const root = mkdtempSync(join(tmpdir(), "ppie-recover-layers-"));
	const home = join(root, "home");
	const project = join(root, "project");
	try {
		writeJson(globalConfigPath(home), {
			retry: { max_attempts: 2, smart_overrides: [{ when: { words: ["global"] }, max_attempts: 1 }] },
		});
		writeJson(projectRetryConfigPath(project), {
			retry: { smart_overrides: [{ when: { words: ["project"] }, max_attempts: 3 }] },
			memory_overflow_protection: {
				compaction: { enabled: true, dynamic: { enabled: true, at_context_ratio: 0.8 } },
			},
		});
		const report = resolveRetryPolicyLayers({ home, env: {}, project: { cwd: project, trusted: true } });
		assert.deepEqual(
			report.layers.map((layer) => layer.kind),
			["global", "project"],
		);
		assert.equal(report.policy.defaultRetry.max_attempts, 2);
		assert.equal(report.policy.dynamicCompactionRatio, 0.8);
		assert.deepEqual(report.policy.smartOverrides[0].when.words, ["project"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("untrusted project config is ignored entirely", () => {
	const root = mkdtempSync(join(tmpdir(), "ppie-recover-untrusted-"));
	const home = join(root, "home");
	const project = join(root, "project");
	try {
		writeJson(projectRetryConfigPath(project), {
			retry: { max_attempts: 1 },
			hooks: { provider_silent: { after_seconds: 1, command: "false" } },
		});
		const report = resolveRetryPolicyLayers({ home, env: {}, project: { cwd: project, trusted: false } });
		assert.deepEqual(report.layers, []);
		assert.deepEqual(report.policy, DEFAULT_RETRY_POLICY);
		assert.equal(report.policy.providerSilentHook, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("group- or world-writable config layers are refused", () => {
	const root = mkdtempSync(join(tmpdir(), "ppie-recover-permissions-"));
	const home = join(root, "home");
	try {
		const path = globalConfigPath(home);
		writeJson(path, { retry: { max_attempts: 1 } });
		chmodSync(path, 0o666);
		const report = resolveRetryPolicyLayers({ home, env: {} });
		assert.deepEqual(report.layers, []);
		assert.deepEqual(report.refusals, [{ path, reason: "world-writable" }]);
		assert.deepEqual(report.policy, DEFAULT_RETRY_POLICY);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an invalid layer is refused with its reason and the remaining layers still apply", () => {
	const root = mkdtempSync(join(tmpdir(), "ppie-recover-invalid-"));
	const home = join(root, "home");
	const project = join(root, "project");
	try {
		const path = globalConfigPath(home);
		writeJson(path, { retry: { reset_after_streamed_tokens: 0 } });
		writeJson(projectRetryConfigPath(project), { retry: { max_attempts: 2 } });
		const report = resolveRetryPolicyLayers({ home, env: {}, project: { cwd: project, trusted: true } });
		assert.deepEqual(
			report.layers.map((layer) => layer.kind),
			["project"],
		);
		assert.equal(report.refusals.length, 1);
		assert.equal(report.refusals[0]?.path, path);
		assert.equal(report.refusals[0]?.reason, "invalid");
		assert.match(report.refusals[0]?.detail ?? "", /reset_after_streamed_tokens: unknown key/);
		assert.equal(report.policy.defaultRetry.max_attempts, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a layer that passes the schema but fails normalization is refused, not fatal", () => {
	const root = mkdtempSync(join(tmpdir(), "ppie-recover-normalize-"));
	const home = join(root, "home");
	try {
		const path = globalConfigPath(home);
		writeJson(path, { memory_overflow_protection: { prune: { enabled: true, removal_fractions: [0.5, 0.25] } } });
		const report = resolveRetryPolicyLayers({ home, env: {} });
		assert.deepEqual(report.layers, []);
		assert.equal(report.refusals[0]?.reason, "invalid");
		assert.match(report.refusals[0]?.detail ?? "", /strictly increasing/);
		assert.deepEqual(report.policy, DEFAULT_RETRY_POLICY);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reading the global config refreshes a stale sidecar schema", () => {
	const home = mkdtempSync(join(tmpdir(), "ppie-recover-schema-"));
	try {
		const configPath = globalConfigPath(home);
		writeJson(configPath, { retry: { max_attempts: 2 } });
		const schemaPath = join(dirname(configPath), "config.schema.json");
		writeFileSync(schemaPath, '{"stale":true}\n');
		loadRetryPolicy({ home, env: {} });
		assert.equal(readFileSync(schemaPath, "utf8"), retryConfigSchemaText);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("no sidecar schema is created when the global config is absent", () => {
	const home = mkdtempSync(join(tmpdir(), "ppie-recover-noschema-"));
	try {
		loadRetryPolicy({ home, env: {} });
		assert.equal(existsSync(join(dirname(globalConfigPath(home)), "config.schema.json")), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
