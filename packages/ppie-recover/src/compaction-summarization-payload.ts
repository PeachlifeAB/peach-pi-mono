// pi-coding-agent's internal compaction summarization sub-call reaches
// before_provider_request through the same stream function as a normal turn.
// It legitimately has a tiny output budget and a large serialized conversation;
// pruning or restoring its budget would corrupt a request that is not overflowing.
// The host event provides no call-purpose field, so this content-based classifier
// recognizes the distinctive opening of Pi's exported summarization prompt.
const COMPACTION_SUMMARIZATION_SYSTEM_PROMPT_MARKER = "context summarization assistant";

export function isCompactionSummarizationPayload(payload: unknown): boolean {
	if (typeof payload !== "object" || payload === null) return false;
	const record = payload as Record<string, unknown>;
	const messages = record.messages;
	if (!Array.isArray(messages) || messages.length === 0) return false;
	const first = messages[0];
	if (typeof first !== "object" || first === null) return false;
	const firstRecord = first as Record<string, unknown>;
	if (firstRecord.role !== "system" && firstRecord.role !== "developer") {
		return false;
	}
	const content = firstRecord.content;
	return typeof content === "string" && content.toLowerCase().includes(COMPACTION_SUMMARIZATION_SYSTEM_PROMPT_MARKER);
}
