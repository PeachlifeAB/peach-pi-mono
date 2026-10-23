import assert from "node:assert/strict";
import test from "node:test";
import { isCompactionSummarizationPayload } from "../src/compaction-summarization-payload.ts";
import { createEmergencyPruner } from "../src/emergency-prune.ts";
import { truncateTextRemovingChars } from "../src/emergency-prune-message.ts";
import { pruneProviderPayload } from "../src/emergency-prune-payload.ts";
import { pruneMessagesByChars } from "../src/emergency-prune-text.ts";
import { DEFAULT_PRUNE_MARKERS, DEFAULT_PRUNE_PRIORITIES } from "../src/retry-config.ts";

const omlxOverflowError = "400 Prompt too long: 2000 tokens exceeds max context window of 1000 tokens";
const smallOmlxOverflowError = "400 Prompt too long: 120 tokens exceeds max context window of 100 tokens";
const openAiOverflowError =
	"400: This model's maximum context length is 8192 tokens, however you requested 12000 tokens";
const anthropicOverflowError = "invalid_request_error: context limit: 9000 + 3500 > 10000";
const memoryGuardJsonError =
	'400: {"message":"oMLX prefill memory guard rejected this prompt: Prefill would require ~61.06 GB peak (current 55.98 GB + KV+SDPA 5.08 GB) but static/metal_cap ceiling is 59.50 GB. Reduce context length.","type":"invalid_request_error","code":"prefill_memory_exceeded","estimated_bytes":65592857200,"limit_bytes":63887638528}';

const buildPruner = () =>
	createEmergencyPruner({
		getReserveTokens: () => 1,
		getPriorities: () => DEFAULT_PRUNE_PRIORITIES,
		getMarkers: () => [],
	});

const payload = (chars = 20_000) => ({
	messages: [
		{ role: "assistant", content: "x".repeat(chars) },
		{ role: "user", content: "continue" },
	],
});

test("one overflow arms one provider-request prune but does not erase escalation memory", () => {
	const pruner = buildPruner();

	pruner.rememberOverflow(omlxOverflowError);
	assert.equal(pruner.hasBudget(), true);

	const first = pruner.apply(payload());
	assert.ok(first.removedChars > 0);
	assert.equal(pruner.hasBudget(), false);

	const staleInput = payload();
	const stale = pruner.apply(staleInput);
	assert.equal(stale.removedChars, 0);
	assert.equal(stale.payload, staleInput);
	assert.equal(pruner.hasBudget(), false);
});

test("a later overflow adds residual overage to the prior request-local removal", () => {
	const pruner = buildPruner();

	pruner.rememberOverflow(omlxOverflowError);
	const first = pruner.apply(payload()).removedChars;
	assert.ok(first > 0);
	assert.equal(pruner.hasBudget(), false);

	// Pruning only changes one outgoing request; it does not mutate session
	// history. If that request reports another overflow, the next request starts
	// from the same original payload and must remove the prior amount PLUS the
	// newly reported residual overage.
	pruner.rememberOverflow(omlxOverflowError);
	const second = pruner.apply(payload()).removedChars;
	assert.ok(
		second > first,
		`a repeated overflow after an applied prune must increase the cumulative target (first=${first}, second=${second})`,
	);
	assert.equal(pruner.hasBudget(), false);

	// A larger residual overage raises the cumulative target further.
	pruner.rememberOverflow("400 Prompt too long: 4000 tokens exceeds max context window of 1000 tokens");
	const third = pruner.apply(payload()).removedChars;
	assert.ok(third > second, `a larger overage must raise the target (second=${second}, third=${third})`);
	assert.equal(pruner.hasBudget(), false);
});

test("successful compaction clears queued prune and escalation memory", () => {
	const pruner = buildPruner();

	pruner.rememberOverflow(omlxOverflowError);
	assert.equal(pruner.hasBudget(), true);

	pruner.clear();

	const afterCompactionInput = payload();
	const afterCompaction = pruner.apply(afterCompactionInput);
	assert.equal(afterCompaction.removedChars, 0);
	assert.equal(afterCompaction.payload, afterCompactionInput);
	assert.equal(pruner.hasBudget(), false);

	pruner.rememberOverflow(smallOmlxOverflowError);
	const afterReset = pruner.apply(payload()).removedChars;
	assert.ok(afterReset > 0 && afterReset < 1200, "clear() must reset escalation");
});

test("failed compaction leaves queued emergency prune available", () => {
	const pruner = buildPruner();

	pruner.rememberOverflow(omlxOverflowError);

	const afterFailedCompaction = pruner.apply(payload());
	assert.ok(afterFailedCompaction.removedChars > 0);
	assert.equal(pruner.hasBudget(), false);
});

test("partial message-only prune carries only the remainder into the full provider payload", () => {
	const pruner = buildPruner();
	pruner.rememberOverflow(omlxOverflowError);

	const contextPass = pruner.applyMessagesOnly(
		{
			messages: [
				{ role: "assistant", content: "m".repeat(1000) },
				{ role: "user", content: "latest" },
			],
		},
		0,
	);
	assert.ok(contextPass.removedChars > 0);
	assert.ok(contextPass.shortfallChars > 0);
	assert.equal(pruner.hasBudget(), true);

	const providerPass = pruner.apply({
		tools: [{ description: "t".repeat(20_000) }],
	});
	assert.ok(providerPass.removedChars > 0);
	assert.ok(
		providerPass.removedChars <= contextPass.shortfallChars,
		`provider pass must consume only the remaining target, not restart the full target: provider=${providerPass.removedChars} shortfall=${contextPass.shortfallChars}`,
	);
	assert.equal(pruner.hasBudget(), false);
});

test("message-only prune leaves request-scoped remainder for the full provider payload", () => {
	const pruner = buildPruner();
	pruner.rememberOverflow(omlxOverflowError);

	const contextPass = pruner.applyMessagesOnly({ messages: [] }, 2000);
	assert.equal(contextPass.removedChars, 0);
	assert.equal(
		pruner.hasBudget(),
		true,
		"a context pass that cannot reach tools/schemas must not consume the remainder before before_provider_request",
	);

	const providerPass = pruner.apply({
		tools: [{ description: "x".repeat(20_000) }],
	});
	assert.ok(
		providerPass.removedChars > 0,
		"the immediately following full provider-payload pass must consume the remaining target",
	);
	assert.equal(pruner.hasBudget(), false);
});

test("tool description pruning honors scaled minimum keep chars", () => {
	const result = pruneProviderPayload(
		{
			tools: [
				{
					function: {
						description: "x".repeat(1000),
					},
				},
			],
		},
		900,
		DEFAULT_PRUNE_PRIORITIES,
		[],
		50,
	);

	assert.ok(
		result.removedChars > 600,
		`scaled floor should remove more than the default 400-char floor allowed: ${result.removedChars}`,
	);
});

test("tool description pruning recurses through nested schemas and leaves short descriptions unchanged", () => {
	const nestedInput = {
		tools: [
			"unstructured tool entry",
			{ function: { description: "short", metadata: 1 } },
			{
				function: {
					description: "x".repeat(600),
					parameters: { properties: { nested: { description: "y".repeat(600), descriptionType: 1 } } },
				},
			},
		],
	};
	const result = pruneProviderPayload(nestedInput, 2000, DEFAULT_PRUNE_PRIORITIES, [], 50);

	assert.ok(result.removedChars > 0);
	assert.notEqual(result.payload, nestedInput);
	const tools = (result.payload as typeof nestedInput).tools;
	assert.equal(tools[0], "unstructured tool entry");
	assert.deepEqual(tools[1], nestedInput.tools[1]);
	const nestedTool = tools[2] as {
		function: { description: string; parameters: { properties: { nested: { description: string } } } };
	};
	assert.ok(nestedTool.function.description.length < 600);
	assert.ok(nestedTool.function.parameters.properties.nested.description.length < 600);
});

test("tool description pruning stops recursing when the removal budget is exhausted", () => {
	const input = {
		tools: [{ function: { description: "x".repeat(600) } }, { function: { description: "y".repeat(600) } }],
	};
	const result = pruneProviderPayload(input, 100, DEFAULT_PRUNE_PRIORITIES, [], 50);
	const tools = (result.payload as typeof input).tools;

	assert.ok(result.removedChars > 0);
	assert.ok(result.removedChars <= 100);
	assert.notEqual(tools[0]?.function.description.length ?? 600, 600);
	assert.equal(tools[1]?.function.description.length, 600);
});
test("overflow parser handles OpenAI and Anthropic context overage strings", () => {
	const pruner = buildPruner();

	pruner.rememberOverflow(openAiOverflowError);
	const openAi = pruner.apply(payload()).removedChars;
	assert.ok(openAi > 1000, `OpenAI overage must not fall back to tiny reserve: ${openAi}`);

	pruner.clear();
	pruner.rememberOverflow(anthropicOverflowError);
	const anthropic = pruner.apply(payload()).removedChars;
	assert.ok(anthropic > 1000, `Anthropic context-limit overage must not fall back to tiny reserve: ${anthropic}`);
});

test("memory guard GB overage arms a prune sized from estimated_bytes/limit_bytes, not the tiny flat reserve", () => {
	const pruner = buildPruner();

	pruner.rememberOverflow(memoryGuardJsonError);
	const memoryGuard = pruner.apply(payload()).removedChars;
	assert.ok(
		memoryGuard > 1000,
		`memory_guard GB overage (~1.6GB) must arm a real prune, not the flat reserve fallback: ${memoryGuard}`,
	);
});

test("opaque dynamic-ceiling memory failures geometrically escalate the prior achieved removal", () => {
	const pruner = buildPruner();
	const exactGuard =
		'Summarization failed: 400: {"message":"Prefill context too large for available memory (preflight safety guard, kv_len=17600): predicted peak would require ~50.71 GB (current 49.63 GB + KV 1.07 GB) but prefill safety cap is 48.77 GB","estimated_bytes":54444253734,"limit_bytes":52369621811}';
	const opaqueDynamicCeiling = "Request aborted: process memory limit exceeded (usage 49.6 GB, ceiling 51.3 GB).";

	pruner.rememberOverflow(exactGuard);
	const first = pruner.apply(payload(1_000_000)).removedTokensApprox;
	pruner.rememberOverflow(opaqueDynamicCeiling);
	const second = pruner.apply(payload(1_000_000)).removedTokensApprox;

	assert.ok(first > 30_000, `exact KV evidence must drive the first prune: ${first}`);
	assert.ok(
		second >= first * 1.9,
		`an opaque repeat means the prior reduction failed and must escalate geometrically: first=${first}, second=${second}`,
	);
});

test("positive process usage/ceiling and explicit physical-cap differences are measurable; below-ceiling usage is opaque", () => {
	const pruner = buildPruner();
	pruner.rememberOverflow(
		"Request aborted: process memory limit exceeded (usage 49.6 GB, ceiling 51.3 GB). Reduce context size or lower memory_guard_tier.",
	);
	const opaque = pruner.apply(payload()).removedChars;

	pruner.clear();
	pruner.rememberOverflow(
		"Request aborted: process memory limit exceeded (usage 49.8 GB, ceiling 45.8 GB). Reduce context size or lower memory_guard_tier.",
	);
	const processOverage = pruner.apply(payload()).removedChars;
	assert.ok(
		processOverage > opaque,
		`positive current usage over ceiling must beat the below-ceiling blind reserve: opaque=${opaque}, measurable=${processOverage}`,
	);

	pruner.clear();
	pruner.rememberOverflow(
		"Memory limit exceeded during chunked prefill at 51200/56082 tokens: 46.5GB exceeds physical cap 45.8GB (after reclaim)",
	);
	const physicalCap = pruner.apply(payload()).removedChars;
	assert.ok(physicalCap > opaque, "explicit peak/cap overage must be measurable");
});

// Reported live (session 019f60ad-f136-7d0a-abfa-a6b3a5553017): a 400 with a
// real ~26K-token overage pruned ~28278 tok on attempt 1, then ~33108 tok on
// attempt 2 (a bigger escalated budget legitimately found a bit more to
// remove), then retry.ts's shouldStopUnshrunkOverflowReplay guard terminaled
// on the next attempt. This proves WHY: each beforeProviderRequest call
// prunes from the SAME fresh original payload pi-core rebuilds each retry
// (ppie-recover's pruning is a one-shot per-request transform, never written
// back into session history) — so once a bigger budget stops finding new
// prunable content above the effective MIN_TEXT_KEEP_CHARS floor for that
// attempt, or additional droppable messages (emergency-prune-text.ts's
// `nextMessages.length > 2` floor), a further-escalated budget on the SAME
// original payload produces the identical removedChars, byte for byte.
//
// MIN_TEXT_KEEP_CHARS itself now escalates (halves) per repeated
// stall down to MIN_TEXT_KEEP_CHARS_FLOOR=50 — see the sibling tests below —
// specifically so this exact plateau resolves itself automatically for a
// few more attempts instead of terminaling immediately. This test proves
// the TRUE remaining ceiling: once the floor has bottomed out at
// MIN_TEXT_KEEP_CHARS_FLOOR and the message-count floor is also exhausted,
// there is nothing left shouldStopUnshrunkOverflowReplay's guard could ever
// unstick — pruning genuinely cannot help further, and terminaling is
// correct.
test("escalating the prune budget AND floor on the SAME original payload eventually plateaus once BOTH floors bottom out — the real ceiling shouldStopUnshrunkOverflowReplay exists to catch", () => {
	const pruner = buildPruner();

	// Exactly 3 messages: one old-user message small enough that truncation
	// can't touch it even at the bottomed-out 50-char floor, but that IS
	// droppable as a whole message once the budget justifies it; one
	// prunable assistant message; one small "last user" message, excluded
	// from both truncation and whole-message-drop passes. With only 3
	// messages total, once the old-user message is dropped and the
	// assistant message is at its (eventually bottomed-out) floor,
	// pruneMessagesByChars's whole-message-drop loop requires
	// `nextMessages.length > 2` — with 2 messages left (assistant +
	// last-user), it cannot remove anything more, no matter how large a
	// further-escalated budget or how low the floor goes.
	const oversizedPayload = () => ({
		messages: [
			{ role: "user", content: "old".repeat(10) },
			{ role: "assistant", content: "x".repeat(1000) },
			{ role: "user", content: "continue" },
		],
	});

	// Escalate enough times (well past MIN_TEXT_KEEP_CHARS_FLOOR=50, which
	// bottoms out after a handful of halvings from 400) that the floor has
	// certainly stopped moving, then confirm two more attempts plateau.
	let previous = 0;
	for (let i = 0; i < 8; i++) {
		pruner.rememberOverflow(omlxOverflowError);
		const attempt = pruner.apply(oversizedPayload());
		previous = attempt.removedChars;
	}

	pruner.rememberOverflow(omlxOverflowError);
	const secondToLast = pruner.apply(oversizedPayload());
	pruner.rememberOverflow(omlxOverflowError);
	const last = pruner.apply(oversizedPayload());

	assert.equal(
		last.removedChars,
		secondToLast.removedChars,
		`once both the escalating budget AND the escalating floor have bottomed out, a further-escalated attempt on the same original payload must plateau at the identical removedChars: secondToLast=${secondToLast.removedChars} last=${last.removedChars} (earlier attempt for reference: ${previous})`,
	);
});

// The plateau proven above is real, but MIN_TEXT_KEEP_CHARS=400 is a flat
// constant applied identically on attempt 1 and attempt 100 — it does not
// know a stall already happened. Once shouldStopUnshrunkOverflowReplay's
// "no progress" signal fires once, a smarter recovery should treat that as
// "the normal floor was too conservative for how oversized this session is"
// and try harder before giving up entirely — a truncation marker plus a
// shred of context on every message beats a hard terminal. This is scoped
// to ONLY the per-message truncation floor (MIN_TEXT_KEEP_CHARS), not the
// separate 2-message-minimum whole-drop floor (see the plateau test above),
// which stays fixed: at some point pruning content is no longer possible
// without discarding the conversation's essential shape.
//
// Isolated unit test first — the pure floor math, no budget/escalation
// mixed in, parameterized across normal and extreme keep-floor values so
// the halving/flooring logic itself is proven independent of any specific
// payload shape.
test("truncateTextRemovingChars honors an explicit minKeepChars across normal and extreme values", () => {
	const text = "y".repeat(10_000);

	for (const minKeepChars of [400, 200, 100, 50, 1, 0]) {
		const result = truncateTextRemovingChars(text, 9999, minKeepChars);
		assert.ok(
			result.text.length >= Math.min(minKeepChars, text.length),
			`minKeepChars=${minKeepChars}: kept ${result.text.length} chars, must be >= ${minKeepChars}`,
		);
	}

	// A minKeepChars larger than the text itself must be a no-op, not throw
	// or produce a negative-length result.
	const noop = truncateTextRemovingChars("short", 100, 10_000);
	assert.equal(noop.removedChars, 0, "minKeepChars above text length: nothing removable");
	assert.equal(noop.text, "short");

	// A smaller minKeepChars must never remove LESS than a larger one for
	// the same input and removeChars budget — the floor easing must
	// monotonically permit at least as much truncation, never less.
	const kept400 = truncateTextRemovingChars(text, 9999, 400).removedChars;
	const kept50 = truncateTextRemovingChars(text, 9999, 50).removedChars;
	assert.ok(
		kept50 >= kept400,
		`a lower floor (50) must remove at least as much as a higher floor (400): kept400=${kept400} kept50=${kept50}`,
	);
});

// The main truncation path already keeps a head+marker+tail slice (middle
// cut), not beginning-only — see the headChars/tailChars split below. But
// when there is not enough room left for the marker AND minKeepChars of
// real content (keepBudget <= minKeepChars — increasingly likely at the
// smaller escalated floors, e.g. MIN_TEXT_KEEP_CHARS_FLOOR=50), the function
// falls back to a raw slice with no marker. That fallback must keep the
// TAIL, not the head: for tool results/long outputs the tail usually holds
// the actual result/conclusion, while the head is often the request echo or
// setup — and it stays consistent with the main path's "prefer recency"
// bias (tailChars = keepBudget - headChars, i.e. the tail gets the larger
// share whenever headChars hits its 1000-char cap).
test("truncateTextRemovingChars's no-marker fallback keeps the TAIL of the text, not the beginning", () => {
	const head = "HEAD".repeat(50); // 200 chars, distinguishable
	const tail = "TAIL".repeat(50); // 200 chars, distinguishable
	const text = head + "x".repeat(9600) + tail; // 10,000 chars total

	// minKeepChars=50, removeChars large enough that targetLength lands
	// just above 50 — small enough that keepBudget (targetLength -
	// marker.length, marker is ~92 chars) drops to <= 50, forcing the
	// fallback branch.
	const result = truncateTextRemovingChars(text, 9920, 50);

	assert.ok(
		result.text.includes("TAIL"),
		`fallback must keep content from the tail of the original text, got: ${JSON.stringify(result.text)}`,
	);
	assert.ok(
		!result.text.includes("HEAD"),
		`fallback must not keep the head when only minKeepChars of room exists, got: ${JSON.stringify(result.text)}`,
	);
});

// The tail-preference above is right for message bodies, but a whole
// prompt/input STRING is structurally different — the front usually holds
// system framing/instructions that define how the model should behave at
// all, which matters more than trailing conversation content. keepFrom
// lets a caller opt into the safer, pre-existing head-preserving behavior.
test("truncateTextRemovingChars's no-marker fallback keeps the HEAD when keepFrom='head' is passed explicitly", () => {
	const head = "SYSTEM_FRAMING".repeat(20); // 280 chars, distinguishable
	const tail = "END_OF_CONVERSATION".repeat(20); // 400 chars, distinguishable
	const text = head + "x".repeat(9300) + tail;

	const result = truncateTextRemovingChars(text, 9920, 50, "head");

	assert.ok(
		result.text.includes("SYSTEM_FRAMING"),
		`head-mode fallback must keep the front (system framing), got: ${JSON.stringify(result.text)}`,
	);
	assert.ok(
		!result.text.includes("END_OF_CONVERSATION"),
		`head-mode fallback must not keep the tail, got: ${JSON.stringify(result.text)}`,
	);
});

// End-to-end: prunePromptLikeString (emergency-prune-payload.ts) is the
// real call site this matters for — a provider payload with a raw `prompt`
// string field (not a `messages` array). Confirms it actually passes
// keepFrom: "head" through pruneProviderPayload's public API, not just at
// the unit level above.
test("pruneProviderPayload keeps the HEAD of a raw prompt string in the no-marker fallback, not the tail", () => {
	const head = "SYSTEM_FRAMING".repeat(20);
	const tail = "END_OF_CONVERSATION".repeat(20);
	const payload = {
		prompt: head + "x".repeat(9300) + tail,
	};

	const pruned = pruneProviderPayload(payload, 9920, DEFAULT_PRUNE_PRIORITIES, [], 50);

	assert.ok(typeof pruned.payload === "object" && pruned.payload !== null && "prompt" in pruned.payload);
	const prunedPrompt = (pruned.payload as { prompt: string }).prompt;
	assert.ok(
		prunedPrompt.includes("SYSTEM_FRAMING"),
		`pruned prompt must keep the front (system framing), got: ${JSON.stringify(prunedPrompt)}`,
	);
	assert.ok(
		!prunedPrompt.includes("END_OF_CONVERSATION"),
		`pruned prompt must not keep the tail, got: ${JSON.stringify(prunedPrompt)}`,
	);
});

// Reported live (session 019f3f88-fc14-759b-a722-fdf763ee480e): a memory_guard
// 400 fired right after pi-llm-wiki injected two custom_message wiki notices
// for the turn (customType: wiki-session-notice / wiki-recall-context). By
// the time ppie-recover sees the outgoing payload, pi-core's own convertToLlm
// (messages.js) has already rewritten role:"custom" -> role:"user" with
// content:[{type:"text",text:<original string>}] (documented + verified
// against the installed package). The model's own confused response after
// the retry ("The user seems to have sent a message that contains wiki
// knowledge results...") confirms this conversion happened. This proves
// marker matching + shape preservation both hold at the truncation-priority
// layer: the converted wiki message (now role:"user") is still selected
// FIRST via its marker match (ahead of a large real assistant message),
// and its role/shape survive truncation unchanged.
test("a wiki custom_message, already converted to role:user by pi-core's convertToLlm, is still marker-matched and pruned FIRST — ahead of a large real assistant message", () => {
	const wikiNoticeConvertedToUser = {
		role: "user",
		content: [
			{
				type: "text",
				text: "🧠 LLM Wiki active. Retrieval (inline): recall runs automatically each turn — use wiki_search to query and read to open pages.".repeat(
					20,
				), // long enough to be a real prune candidate
			},
		],
		timestamp: 1,
	};
	const largeAssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "y".repeat(5000) }],
	};
	const latestUserMessage = { role: "user", content: "what?" };

	const markers = DEFAULT_PRUNE_MARKERS.map((m) => m.toLowerCase());
	const result = pruneMessagesByChars(
		[wikiNoticeConvertedToUser, largeAssistantMessage, latestUserMessage],
		500,
		DEFAULT_PRUNE_PRIORITIES,
		markers,
	);

	assert.ok(result.removedChars > 0, "something must have been pruned");

	const prunedWikiMessage = result.messages[0] as {
		role: string;
		content: Array<{ type: string; text: string }>;
		timestamp: number;
	};
	const prunedAssistantMessage = result.messages[1] as {
		role: string;
		content: Array<{ type: string; text: string }>;
	};

	// The wiki message (marker-matched, priority 100) must have been
	// truncated — its text should have shrunk from the marker-driven prune,
	// while the large assistant message (priority 70, no marker) is
	// untouched because the wiki message alone had enough prunable content
	// to satisfy the small 500-char target.
	assert.ok(
		prunedWikiMessage.content[0].text.length < wikiNoticeConvertedToUser.content[0].text.length,
		"the marker-matched wiki message must be the one that got shorter",
	);
	assert.equal(
		prunedAssistantMessage.content[0].text.length,
		5000,
		"the large assistant message must be untouched — the marker-matched message had priority and was pruned first",
	);

	// Shape preservation: role, content array structure, and (for the wiki
	// message) timestamp must all survive truncation unchanged except for
	// the text field itself.
	assert.equal(prunedWikiMessage.role, "user", "role must be preserved");
	assert.equal(prunedWikiMessage.timestamp, 1, "other fields (timestamp) must be preserved, only text truncated");
	assert.equal(prunedWikiMessage.content[0].type, "text", "content part type must be preserved");
});

// A SEPARATE, real gap found while checking shape preservation (fixed): the
// whole-message-DROP phase (as opposed to the truncation phase above) used
// to pick the FIRST non-excluded message with no toolCall/toolResult
// pairing awareness — dropping an assistant message while leaving its
// paired toolResult behind (a dangling toolCallId most OpenAI-compatible
// APIs reject outright), or the reverse. Fixed: pruneMessagesByChars now
// finds every message referencing (or referenced by) the dropped message's
// toolCall ids and drops the whole pair together in the same pass.
test("whole-message drop phase honors marker priority before older ordinary messages", () => {
	const messages = [
		{ role: "user", content: "ordinary old middle" },
		{ role: "assistant", content: "ordinary assistant" },
		{ role: "user", content: `wiki custom_message ${"x".repeat(500)}` },
		{ role: "user", content: "latest" },
	];

	const result = pruneMessagesByChars(messages, 2000, DEFAULT_PRUNE_PRIORITIES, ["wiki custom_message"], 10_000);

	assert.equal(
		result.messages.some((message) => JSON.stringify(message).includes("wiki custom_message")),
		false,
		"marker-matched message must be selected for whole-message drop before ordinary eligible messages",
	);
	assert.equal(
		result.messages.some((message) => JSON.stringify(message).includes("ordinary old middle")),
		true,
	);
});

test("whole-message drop phase drops a toolCall/toolResult pair TOGETHER, never orphaning one half", () => {
	// Real shape verified against session 019f3f88-fc14-759b-a722-fdf763ee480e:
	// a toolCall is a CONTENT BLOCK inside the assistant message's content
	// array ({ type: "toolCall", id, name, arguments }), not a separate
	// top-level field — matching pi-agent-core's AgentToolCall type.
	const messages = [
		{
			role: "assistant",
			content: [
				{ type: "text", text: "checking" },
				{ type: "toolCall", id: "call_1", name: "some_tool", arguments: {} },
			],
		},
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "some_tool",
			content: [{ type: "text", text: "z".repeat(500) }],
		},
		{ role: "user", content: "what?" },
	];

	// Target far larger than any single message can satisfy via truncation
	// alone (all messages are small/already at floor), forcing the
	// whole-message-drop phase to run.
	const result = pruneMessagesByChars(messages, 10_000, DEFAULT_PRUNE_PRIORITIES, []);

	const remainingRoles = result.messages.map((m) => (m as { role: string }).role);

	// Both the assistant message (holding the toolCall) and its paired
	// toolResult are dropped together — no dangling toolCallId anywhere.
	assert.deepEqual(
		remainingRoles,
		["user"],
		"the assistant+toolCall message and its paired toolResult must be dropped together, leaving no orphaned half",
	);
});

// Reverse direction: the pairing fix must work symmetrically regardless of
// which half the drop-phase's first-eligible-index scan reaches first. Here
// a toolResult is placed BEFORE its paired assistant+toolCall message, so
// it is the one selected as dropIndex — dropping it alone would orphan the
// assistant message's toolCall the other way around (a toolCall with no
// result, which most APIs also reject).
test("whole-message drop phase drops the pair together even when the toolResult (not the assistant message) is the first-eligible drop candidate", () => {
	const messages = [
		{
			role: "toolResult",
			toolCallId: "call_2",
			toolName: "some_tool",
			content: [{ type: "text", text: "z".repeat(500) }],
		},
		{
			role: "assistant",
			content: [
				{ type: "text", text: "checking" },
				{ type: "toolCall", id: "call_2", name: "some_tool", arguments: {} },
			],
		},
		{ role: "user", content: "what?" },
	];

	const result = pruneMessagesByChars(messages, 10_000, DEFAULT_PRUNE_PRIORITIES, []);

	const remainingRoles = result.messages.map((m) => (m as { role: string }).role);

	assert.deepEqual(
		remainingRoles,
		["user"],
		"dropping the toolResult first must also drop its paired assistant+toolCall message, not leave a dangling toolCall with no result",
	);
});

// The single-pass pairing fix above only expands ONE hop from the initially
// selected dropIndex — it works for a simple 1 toolCall <-> 1 toolResult
// pair, but breaks when one assistant message carries MULTIPLE toolCall
// blocks: dropping toolResult(call_1) first pulls in the assistant message
// (which also has call_2), but nothing re-expands from that newly added
// assistant message to also pull in toolResult(call_2) — leaving it
// orphaned. Fixed via a proper transitive-closure loop (repeat until a full
// pass adds nothing new).
test("whole-message drop phase computes the FULL transitive closure for an assistant message with multiple toolCalls, not just one hop", () => {
	const messages = [
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "t",
			content: [{ type: "text", text: "z".repeat(500) }],
		},
		{
			role: "toolResult",
			toolCallId: "call_2",
			toolName: "t",
			content: [{ type: "text", text: "z".repeat(500) }],
		},
		{
			role: "assistant",
			content: [
				{ type: "text", text: "checking" },
				{ type: "toolCall", id: "call_1", name: "t", arguments: {} },
				{ type: "toolCall", id: "call_2", name: "t", arguments: {} },
			],
		},
		{ role: "user", content: "what?" },
	];

	const result = pruneMessagesByChars(messages, 10_000, DEFAULT_PRUNE_PRIORITIES, []);

	const remainingRoles = result.messages.map((m) => (m as { role: string }).role);

	assert.deepEqual(
		remainingRoles,
		["user"],
		"both toolResults (call_1 AND call_2) and the assistant message carrying both toolCalls must be dropped together — neither toolResult may survive orphaned",
	);
});

// Integration test: prove emergency-prune.ts actually wires the escalating
// floor through end to end, for a payload that is deliberately sized to be
// stuck at MIN_TEXT_KEEP_CHARS=400 (attempt 1) but NOT stuck at the smaller
// floors later stalls unlock — isolating the floor effect from the
// separate budget-escalation effect (already proven by the plateau test
// above) by keeping the assistant message just large enough that a bigger
// budget alone (without a lower floor) could not have removed more: the
// budget headroom at every attempt below comfortably exceeds what's
// truncatable, so removedChars is bounded ONLY by the floor, not the budget.
test("emergencyPruner.apply wires the escalating MIN_TEXT_KEEP_CHARS floor through pruneProviderPayload on repeated stalls", () => {
	const pruner = buildPruner();

	// content.length=1000: at floor=400, truncatable to 600 removed chars
	// (minus marker overhead); at floor=50, truncatable further. Two
	// messages, matching the real reported plateau shape (assistant +
	// excluded last-user).
	const stuckPayload = () => ({
		messages: [
			{ role: "assistant", content: "x".repeat(1000) },
			{ role: "user", content: "continue" },
		],
	});

	// Use a large reported overage so budgetChars comfortably exceeds what
	// this small payload could ever need removed — isolates the floor as
	// the sole limiting factor, not the budget.
	const bigOverflowError = "400 Prompt too long: 999999 tokens exceeds max context window of 1 tokens";

	pruner.rememberOverflow(bigOverflowError);
	const first = pruner.apply(stuckPayload());

	pruner.rememberOverflow(bigOverflowError);
	const second = pruner.apply(stuckPayload());

	assert.ok(
		second.removedChars > first.removedChars,
		`a repeated stall must escalate the truncation floor and remove more, not plateau: first=${first.removedChars} second=${second.removedChars}`,
	);

	pruner.rememberOverflow(bigOverflowError);
	const third = pruner.apply(stuckPayload());
	assert.ok(
		third.removedChars >= second.removedChars,
		`escalation must never regress on a further stall: second=${second.removedChars} third=${third.removedChars}`,
	);

	// Enough further stalls to certainly reach the MIN_TEXT_KEEP_CHARS_FLOOR
	// (50): further escalation past that point must plateau again — the
	// escalating floor is itself bounded, it cannot shrink text to nothing.
	let previous = third.removedChars;
	for (let i = 0; i < 5; i++) {
		pruner.rememberOverflow(bigOverflowError);
		const attempt = pruner.apply(stuckPayload());
		assert.ok(
			attempt.removedChars >= previous,
			`removedChars must never regress across escalating stalls (attempt ${i + 4}): previous=${previous} now=${attempt.removedChars}`,
		);
		previous = attempt.removedChars;
	}
});

// GGDSD-grounded (session 019f3f88-fc14-759b-a722-fdf763ee480e smoke-test
// investigation): pi-coding-agent's own compaction summarization sub-call
// (compaction.js's generateSummary) sets a real, exported system-prompt
// constant (compaction/utils.js's SUMMARIZATION_SYSTEM_PROMPT, "You are a
// context summarization assistant...") that openai-completions.js's
// convertMessages turns into payload.messages[0] = { role: "system",
// content: <that text> }. This is the ONLY signal available to
// before_provider_request (BeforeProviderRequestEvent exposes only
// { type, payload }, no call-purpose field) to distinguish this sub-call
// from the main turn's own request.
test("isCompactionSummarizationPayload recognizes the real compaction system-prompt shape", () => {
	assert.equal(
		isCompactionSummarizationPayload({
			messages: [
				{
					role: "system",
					content:
						"You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.",
				},
				{ role: "user", content: "<conversation>...</conversation>" },
			],
		}),
		true,
		"must recognize the real SUMMARIZATION_SYSTEM_PROMPT opening sentence",
	);

	assert.equal(
		isCompactionSummarizationPayload({
			messages: [
				{
					role: "developer",
					content: "You are a context summarization assistant. Your task is to read a conversation...",
				},
			],
		}),
		true,
		"reasoning models get role:'developer' instead of role:'system' (compat.supportsDeveloperRole) — must still match",
	);
});

test("isCompactionSummarizationPayload does NOT false-positive on a normal turn's payload with an unrelated system message", () => {
	assert.equal(
		isCompactionSummarizationPayload({
			messages: [
				{ role: "system", content: "You are a helpful coding assistant." },
				{ role: "user", content: "fix the bug in retry.ts" },
			],
		}),
		false,
		"a normal turn's own system prompt must not be mistaken for the compaction marker — it must remain fully prunable",
	);

	assert.equal(
		isCompactionSummarizationPayload({
			messages: [{ role: "user", content: "no system message at all" }],
		}),
		false,
	);

	assert.equal(isCompactionSummarizationPayload({ messages: [] }), false, "empty messages array");

	assert.equal(isCompactionSummarizationPayload(null), false, "null payload must not throw");

	assert.equal(isCompactionSummarizationPayload("not an object"), false, "non-object payload must not throw");
});
