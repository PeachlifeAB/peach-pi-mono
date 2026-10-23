import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { smokeConfigJsonSchema } from "../src/smoke-config-schema.ts";

// The zod schema (src/smoke-config-schema.ts) is the single source of truth;
// this regenerates the committed JSON Schema artifact from it. A drift guard
// (test/smoke-config-schema.test.ts) fails if the committed file falls behind.
export const smokeConfigSchemaPath = fileURLToPath(new URL("../schemas/smoke-config.schema.json", import.meta.url));

export const smokeConfigSchemaText = `${JSON.stringify(smokeConfigJsonSchema, null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
	writeFileSync(smokeConfigSchemaPath, smokeConfigSchemaText);
	process.stdout.write(`wrote ${smokeConfigSchemaPath}\n`);
}
