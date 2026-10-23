import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, retryConfigJsonSchema } from "../src/retry-config-schema.ts";

export const retryConfigSchemaPath = fileURLToPath(new URL("../schemas/retry-config.schema.json", import.meta.url));
export const retryDefaultConfigPath = fileURLToPath(new URL("../config.default.json", import.meta.url));
export const retryConfigSchemaText = `${JSON.stringify(retryConfigJsonSchema, null, 2)}\n`;
export const retryDefaultConfigText = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
	writeFileSync(retryConfigSchemaPath, retryConfigSchemaText);
	writeFileSync(retryDefaultConfigPath, retryDefaultConfigText);
	process.stdout.write(`wrote ${retryConfigSchemaPath}\nwrote ${retryDefaultConfigPath}\n`);
}
