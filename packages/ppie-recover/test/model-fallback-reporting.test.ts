import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createModelFallbackReporter } from "../src/model-fallback-reporting.ts";
import type { ModelFallbackRecord } from "../src/model-fallback-sequence.ts";

const record: ModelFallbackRecord = Object.freeze({
	sequenceId: "sequence-1",
	timestamp: "2026-01-01T00:00:00.000Z",
	hopIndex: 1,
	failedModel: "openai/primary",
	candidateModel: "anthropic/backup",
	servingModel: "anthropic/backup",
	outcome: "hop",
	reason: "permanent",
	status: 503,
	elapsedMs: 20,
});

type TestEntryRenderer = (
	entry: { data?: ModelFallbackRecord },
	renderOptions: { expanded: boolean },
	theme: { fg: (style: string, text: string) => string },
) => { render: () => string[]; invalidate: () => void };

function harness(initialMode: ExtensionContext["mode"]) {
	const mode = initialMode;
	const entries: unknown[] = [];
	const events: Array<{ channel: string; payload: unknown }> = [];
	const stderr: string[] = [];
	let rendererType: string | undefined;
	let renderer: TestEntryRenderer | undefined;
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		events: { emit: (channel: string, payload: unknown) => events.push({ channel, payload }) },
		registerEntryRenderer: (customType: string, callback: TestEntryRenderer) => {
			rendererType = customType;
			renderer = callback;
		},
	} as unknown as ExtensionAPI;
	const report = createModelFallbackReporter({
		pi,
		mode: () => mode,
		writeStderr: (line) => stderr.push(line),
	});
	return {
		entries,
		events,
		stderr,
		report,
		renderer: () => renderer,
		rendererType: () => rendererType,
	};
}

test("tui appends a persistent custom entry with a registered renderer", () => {
	const h = harness("tui");
	h.report(record);
	assert.equal(h.rendererType(), "ppie-recover:model-fallback");
	assert.deepEqual(h.entries, [{ customType: "ppie-recover:model-fallback", data: record }]);
	assert.deepEqual(h.events, []);
	assert.deepEqual(h.stderr, []);
});

test("rpc emits the common structured record", () => {
	const h = harness("rpc");
	h.report(record);
	assert.deepEqual(h.events, [{ channel: "ppie-recover:model-fallback", payload: record }]);
	assert.deepEqual(h.stderr, []);
});

test("json writes one structured stderr record", () => {
	const h = harness("json");
	h.report(record);
	assert.equal(h.stderr.length, 1);
	assert.deepEqual(JSON.parse(h.stderr[0] ?? ""), { type: "ppie-recover:model-fallback", ...record });
});

test("print writes one human-readable stderr record", () => {
	const h = harness("print");
	h.report(record);
	assert.equal(h.stderr.length, 1);
	assert.match(h.stderr[0] ?? "", /sequence-1.*openai\/primary.*anthropic\/backup.*permanent/);
});

test("print defaults to process.stderr.write when no writer is injected", () => {
	const originalWrite = process.stderr.write;
	let written = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		written += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		const pi = { registerEntryRenderer: () => {} } as unknown as ExtensionAPI;
		createModelFallbackReporter({ pi, mode: () => "print" })(record);
		assert.match(written, /sequence-1.*openai\/primary.*anthropic\/backup.*permanent/);
	} finally {
		process.stderr.write = originalWrite;
	}
});

test("registered renderer shows valid records, expanded trace, and invalid entries", () => {
	const h = harness("tui");
	const renderer = h.renderer();
	assert(renderer);
	const theme = { fg: (_style: string, text: string) => `dim:${text}` };

	const compact = renderer({ data: record }, { expanded: false }, theme).render();
	assert.match(compact[0] ?? "", /sequence-1.*openai\/primary/);

	const tracedRecord = { ...record, trace: [record] } as ModelFallbackRecord;
	const expanded = renderer({ data: tracedRecord }, { expanded: true }, theme).render();
	assert.match(expanded[0] ?? "", /dim:/);

	const invalid = renderer({ data: undefined }, { expanded: true }, theme).render();
	assert.deepEqual(invalid, ["[ppie-recover:model-fallback] invalid record"]);
});
