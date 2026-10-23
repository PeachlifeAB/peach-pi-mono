import type { Api, Model } from "@earendil-works/pi-ai";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";

function findExactModelReferenceMatch(modelReference: string, models: readonly Model<Api>[]): Model<Api> | undefined {
	const canonical = modelReference.trim().toLowerCase();
	return models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === canonical);
}

export function canonicalModelReference(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function withoutExpectedFailedAssistantTail<Message extends { role?: unknown }>(
	messages: Message[],
	expectedTail: unknown,
): Message[] {
	const last = messages.at(-1);
	return last === expectedTail && last?.role === "assistant" ? messages.slice(0, -1) : messages;
}

export function resolveFallbackCandidate(
	modelReference: string,
	scopedModels: readonly ScopedModel[],
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	const models = scopedModels.length > 0 ? scopedModels.map((entry) => entry.model) : availableModels;
	return findExactModelReferenceMatch(modelReference, models);
}
