import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { smokeConfigSchemaPath, smokeConfigSchemaText } from "../scripts/gen-smoke-config-schema.ts";
import { formatSmokeConfigError, smokeConfigJsonSchema, smokeConfigSchema } from "../src/smoke-config-schema.ts";

const valid = {
	version: 1 as const,
	forkSessionId: "019f6596-d064-7624-8597-5928e09e5e57",
	prompt: "Continue",
	mode: "rpc" as const,
	disableGlobalSkills: true,
	disableGlobalExtensions: true,
	load: [
		{ kind: "extension" as const, value: "/Users/sampleuser/Developer/ppie-recover" },
		{ kind: "skill" as const, value: ".agents/skills/thing" },
	],
};

test("accepts a valid config", () => {
	assert.equal(smokeConfigSchema.safeParse(valid).success, true);
});

test("accepts an empty load list and an optional model", () => {
	assert.equal(smokeConfigSchema.safeParse({ ...valid, load: [], model: "omlx/some-model" }).success, true);
});

test("rejects a wrong version literal", () => {
	assert.equal(smokeConfigSchema.safeParse({ ...valid, version: 2 }).success, false);
});

test("rejects a non-rpc mode", () => {
	assert.equal(smokeConfigSchema.safeParse({ ...valid, mode: "print" }).success, false);
});

test("rejects a malformed forkSessionId", () => {
	assert.equal(smokeConfigSchema.safeParse({ ...valid, forkSessionId: "not-a-uuid" }).success, false);
});

test("rejects an empty prompt (a no-op smoke is not a pass)", () => {
	assert.equal(smokeConfigSchema.safeParse({ ...valid, prompt: "" }).success, false);
});

test("rejects unknown top-level keys (strict)", () => {
	assert.equal(smokeConfigSchema.safeParse({ ...valid, projectDir: "/x" }).success, false);
});

test("rejects an unknown load kind and a blank load value", () => {
	assert.equal(smokeConfigSchema.safeParse({ ...valid, load: [{ kind: "plugin", value: "x" }] }).success, false);
	assert.equal(smokeConfigSchema.safeParse({ ...valid, load: [{ kind: "extension", value: "" }] }).success, false);
});

test("formatSmokeConfigError names the offending path", () => {
	const result = smokeConfigSchema.safeParse({ ...valid, projectDir: "/x" });
	assert.equal(result.success, false);
	if (!result.success) {
		assert.match(formatSmokeConfigError(result.error), /projectDir/);
	}
});

test("smokeConfigJsonSchema is a JSON Schema object with a version property", () => {
	assert.equal(smokeConfigJsonSchema.type, "object");
	assert.ok((smokeConfigJsonSchema.properties as Record<string, unknown>).version);
});

test("committed schemas/smoke-config.schema.json matches the zod source (run gen-smoke-config-schema)", () => {
	assert.equal(readFileSync(smokeConfigSchemaPath, "utf8"), smokeConfigSchemaText);
});
