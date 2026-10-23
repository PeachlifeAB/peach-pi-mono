import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelFallbackRecord } from "./model-fallback-sequence.ts";

const MODEL_FALLBACK_EVENT = "ppie-recover:model-fallback";

function formatRecord(record: ModelFallbackRecord): string {
	return [
		`[${MODEL_FALLBACK_EVENT}]`,
		`sequence=${record.sequenceId}`,
		`outcome=${record.outcome}`,
		`hop=${record.hopIndex}`,
		`failed=${record.failedModel}`,
		record.candidateModel ? `candidate=${record.candidateModel}` : undefined,
		record.servingModel ? `serving=${record.servingModel}` : undefined,
		`reason=${record.reason}`,
		record.status === undefined ? undefined : `status=${record.status}`,
		`elapsed=${record.elapsedMs}ms`,
	]
		.filter((part) => part !== undefined)
		.join(" ");
}

export function createModelFallbackReporter(options: {
	pi: ExtensionAPI;
	mode: () => ExtensionContext["mode"];
	writeStderr?: (line: string) => void;
}): (record: ModelFallbackRecord) => void {
	const writeStderr = options.writeStderr ?? process.stderr.write.bind(process.stderr);
	options.pi.registerEntryRenderer<ModelFallbackRecord>(MODEL_FALLBACK_EVENT, (entry, renderOptions, theme) => {
		const record = entry.data;
		const summary = record ? formatRecord(record) : `[${MODEL_FALLBACK_EVENT}] invalid record`;
		const text =
			renderOptions.expanded && record && "trace" in record
				? `${summary}\n${theme.fg("dim", JSON.stringify(record.trace, null, 2))}`
				: summary;
		return {
			render: () => [text],
			invalidate: () => undefined,
		};
	});

	return (record) => {
		switch (options.mode()) {
			case "tui":
				options.pi.appendEntry(MODEL_FALLBACK_EVENT, record);
				return;
			case "rpc":
				options.pi.events.emit(MODEL_FALLBACK_EVENT, record);
				return;
			case "json":
				writeStderr(`${JSON.stringify({ type: MODEL_FALLBACK_EVENT, ...record })}\n`);
				return;
			case "print":
				writeStderr(`${formatRecord(record)}\n`);
		}
	};
}
