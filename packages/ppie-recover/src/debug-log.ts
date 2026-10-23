import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DebugSettings = { enabled: boolean; path?: string };

export function resolveDebugSettings(input: { configEnabled?: boolean; configPath?: string }): DebugSettings {
	return input.configEnabled && input.configPath ? { enabled: true, path: input.configPath } : { enabled: false };
}

let settings = resolveDebugSettings({});
let ensuredDir: string | undefined;

export function configureDebugLog(input: { enabled?: boolean; path?: string }): void {
	settings = resolveDebugSettings({ configEnabled: input.enabled, configPath: input.path });
	ensuredDir = undefined;
}

export const debugLog = (event: string, data?: Record<string, unknown>) => {
	if (!settings.enabled || settings.path === undefined) return;
	try {
		const dir = dirname(settings.path);
		if (ensuredDir !== dir) {
			mkdirSync(dir, { recursive: true });
			ensuredDir = dir;
		}
		appendFileSync(
			settings.path,
			`${new Date().toISOString()} [ppie-recover] ${event}${data ? ` ${JSON.stringify(data)}` : ""}\n`,
		);
	} catch {
		// Diagnostics cannot interrupt recovery.
	}
};
