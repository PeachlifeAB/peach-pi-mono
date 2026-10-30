import { readFileSync } from "node:fs";

export function main() {
	const input = JSON.parse(readFileSync(0, "utf8"));
	const scenario = input.tool_input;
	if (scenario.error) {
		process.stderr.write(scenario.error);
		process.exitCode = 2;
		return;
	}
	if (scenario.echo) {
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: JSON.stringify({ input, argv: process.argv, projectDir: process.env.CLAUDE_PROJECT_DIR, terminal: process.stdin.isTTY ?? false }) } }));
		return;
	}
	process.stdout.write(scenario.raw ?? JSON.stringify(scenario.reply));
}
