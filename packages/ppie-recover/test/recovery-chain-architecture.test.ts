import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const sourceRoot = path.resolve(import.meta.dirname, "../src");

test("every recovery-chain module stays below the binding 250-line limit", () => {
	const chainFiles = readdirSync(sourceRoot).filter((name) => name.startsWith("recovery-chain"));
	const violations = chainFiles.flatMap((name) => {
		const lines = readFileSync(path.join(sourceRoot, name), "utf8").split("\n").length;
		return lines > 250 ? [`${name}: ${lines} lines`] : [];
	});
	assert.deepEqual(violations, []);
});

test("admission policy lives in its own domain module", () => {
	const chainSource = readFileSync(path.join(sourceRoot, "recovery-chain.ts"), "utf8");
	const admissionPath = path.join(sourceRoot, "recovery-chain-admission.ts");

	assert.equal(readFileSync(admissionPath, "utf8").includes("admitNextRecovery"), true);
	assert.equal(chainSource.includes('from "./recovery-chain-admission.ts"'), true);
});

test("production source modules stay below the binding 250-line limit", () => {
	const productionModules = readdirSync(sourceRoot).filter((name) => name.endsWith(".ts"));
	const violations = productionModules.flatMap((name) => {
		const lines = readFileSync(path.join(sourceRoot, name), "utf8").split("\n").length;
		return lines > 250 ? [`${name}: ${lines} lines`] : [];
	});
	assert.deepEqual(violations, []);
});
