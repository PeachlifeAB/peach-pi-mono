const INLINE_METADATA_PATTERN = "^_";
const INLINE_METADATA_DESCRIPTION = "Documentation metadata ignored by ppie-recover at runtime.";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null;

export function removeInlineMetadata(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(removeInlineMetadata);
	if (!isObject(value)) return value;

	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !key.startsWith("_"))
			.map(([key, child]) => [key, removeInlineMetadata(child)]),
	);
}

function addInlineMetadataToJsonSchemaNode(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(addInlineMetadataToJsonSchemaNode);
	if (!isObject(value)) return value;

	const schema = Object.fromEntries(
		Object.entries(value).map(([key, child]) => [key, addInlineMetadataToJsonSchemaNode(child)]),
	);
	if (schema.type !== "object") return schema;

	const patternProperties = isObject(schema.patternProperties) ? schema.patternProperties : {};
	return {
		...schema,
		patternProperties: {
			...patternProperties,
			[INLINE_METADATA_PATTERN]: { description: INLINE_METADATA_DESCRIPTION },
		},
	};
}

export function addInlineMetadataToJsonSchema<T>(value: T): T {
	return addInlineMetadataToJsonSchemaNode(value) as T;
}
