/**
 * Debug script to reproduce streaming rendering issues.
 * Uses real fixture data that caused the bug.
 *
 * Unlike a hand-rolled render loop, this drives the *actual* provider stream
 * from `src/stream.ts` over a real HTTP connection, so it exercises this
 * package's chunk parsing and AssistantMessageEvent emission end to end and
 * feeds the resulting partials straight into pi's renderer.
 *
 * Run with: node --experimental-strip-types test/streaming-render-debug.ts
 *   (Node 22.6+; on Node 24+ the flag is unnecessary.)
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
// `TUI` became an interface in pi 0.84, with `TuiMainScreen`/`TuiAltScreen` as
// its implementations. This debug harness renders to the main screen.
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { streamOpenAIGeneric } from "../src/stream.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize dark theme with full color support
process.env.COLORTERM = "truecolor";
initTheme("dark");

// Load the real fixture that caused the bug
const fixtureMessage: AssistantMessage = JSON.parse(
	readFileSync(join(__dirname, "fixtures/assistant-message-with-thinking-code.json"), "utf-8"),
);

// Extract thinking and text content
const thinkingContent = fixtureMessage.content.find((c) => c.type === "thinking");
const textContent = fixtureMessage.content.find((c) => c.type === "text");

if (thinkingContent?.type !== "thinking") {
	console.error("No thinking content in fixture");
	process.exit(1);
}

const fullThinkingText = thinkingContent.thinking;
const fullTextContent = textContent && textContent.type === "text" ? textContent.text : "";

/** Characters per simulated token. */
const CHUNK_SIZE = 10;
/** Delay between chunks, in ms. */
const TOKEN_DELAY_MS = 15;
/** Pause between the thinking block and the text block. */
const BLOCK_GAP_MS = 500;

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function* chunkText(text: string, size: number): Generator<string> {
	for (let i = 0; i < text.length; i += size) {
		yield text.slice(i, i + size);
	}
}

/**
 * Serves the fixture in the provider's newline-delimited JSON dialect, pacing
 * the writes so the client observes real partial reads (and mid-chunk
 * boundaries) rather than one buffered response.
 */
function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer(async (_req, res) => {
		res.writeHead(200, {
			"Content-Type": "application/x-ndjson",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		const write = (payload: unknown) => {
			res.write(`${JSON.stringify(payload)}\n`);
		};

		for (const delta of chunkText(fullThinkingText, CHUNK_SIZE)) {
			write({ thinking_delta: delta });
			await sleep(TOKEN_DELAY_MS);
		}

		await sleep(BLOCK_GAP_MS);

		for (const delta of chunkText(fullTextContent, CHUNK_SIZE)) {
			write({ delta });
			await sleep(TOKEN_DELAY_MS);
		}

		write({
			usage: {
				input_tokens: fixtureMessage.usage.input,
				output_tokens: fixtureMessage.usage.output,
			},
		});
		write({ done: true });
		res.end();
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				throw new Error("Failed to bind fixture server");
			}
			resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
		});
	});
}

async function main() {
	const { server, baseUrl } = await startFixtureServer();

	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal);

	// Start with empty message
	const message = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "" }],
	} as AssistantMessage;

	const component = new AssistantMessageComponent(message, false);
	tui.addChild(component);
	tui.start();

	const model: Model<any> = {
		id: fixtureMessage.model,
		name: "Streaming Debug Model",
		api: fixtureMessage.api,
		provider: fixtureMessage.provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	};

	const context: Context = {
		messages: [{ role: "user", content: [{ type: "text", text: "Why does it flicker?" }], timestamp: Date.now() }],
	};

	// Drive the real provider stream and re-render on every partial. Each event
	// carries the in-progress AssistantMessage, so the renderer sees exactly the
	// sequence of states a live session would.
	let events = 0;
	let lastPartial: AssistantMessage | undefined;

	for await (const event of streamOpenAIGeneric(model, context)) {
		events++;
		if ("partial" in event && event.partial) {
			lastPartial = event.partial;
			component.updateContent(event.partial);
			tui.requestRender();
		}
		if (event.type === "done") {
			lastPartial = event.message;
			component.updateContent(event.message);
			tui.requestRender();
		}
		if (event.type === "error") {
			lastPartial = event.error;
			component.updateContent(event.error);
			tui.requestRender();
		}
	}

	// Keep alive for a moment to see the result
	await sleep(3000);
	tui.stop();
	server.close();

	const blocks = lastPartial?.content.map((c) => c.type).join(", ") ?? "(none)";
	console.log(`\nrendered ${events} stream events; final content blocks: ${blocks}`);
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
