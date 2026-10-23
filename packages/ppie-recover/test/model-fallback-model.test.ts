import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";
import {
	canonicalModelReference,
	resolveFallbackCandidate,
	withoutExpectedFailedAssistantTail,
} from "../src/model-fallback-model.ts";

function model(provider: string, id: string): Model<Api> {
	return { provider, id } as Model<Api>;
}

test("candidate resolution reads the live scope or all available models when scope is empty", () => {
	const candidate = model("anthropic", "backup");
	const other = model("google", "other");
	const empty: readonly ScopedModel[] = [];
	assert.equal(resolveFallbackCandidate("anthropic/backup", empty, []), undefined);
	assert.equal(resolveFallbackCandidate("anthropic/backup", empty, [candidate]), candidate);
	assert.equal(resolveFallbackCandidate("anthropic/backup", [{ model: candidate }], [other]), candidate);
	assert.equal(resolveFallbackCandidate("anthropic/backup", [{ model: other }], [candidate]), undefined);
});

test("canonical references preserve provider and nested model ids", () => {
	assert.equal(canonicalModelReference(model("openrouter", "anthropic/claude")), "openrouter/anthropic/claude");
});

test("continuation removes only the expected failed assistant tail", () => {
	const inputs = [{ role: "system" }, { role: "user" }, { role: "toolResult" }];
	const failed = { role: "assistant", content: "partial" };
	const messages = [...inputs, failed];
	const next = withoutExpectedFailedAssistantTail(messages, failed);
	assert.deepEqual(next, inputs);
	assert.equal(next[1], inputs[1]);
	assert.equal(withoutExpectedFailedAssistantTail(messages, { ...failed }), messages);
});
