import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

describe("declared pi resources", () => {
	// Pi walks every resource type in the manifest (package-manager.ts:2174-2186),
	// so a declared path that is absent or unpublished makes the package work only
	// on the machine where someone placed the file by hand.
	const declared: [string, string][] = Object.entries(manifest.pi ?? {}).flatMap(([type, paths]) =>
		(paths as string[]).map((p) => [type, p] as [string, string]),
	);

	it("declares the extension and its skill", () => {
		expect(manifest.pi.extensions).toContain("./src/index.ts");
		expect(manifest.pi.skills).toContain("./skills/graft/SKILL.md");
	});

	it.each(declared)("%s entry %s exists on disk", (_type, declaredPath) => {
		expect(fs.existsSync(path.join(root, declaredPath))).toBe(true);
	});

	it.each(declared)("%s entry %s is inside the published file set", (_type, declaredPath) => {
		const top = declaredPath.replace(/^\.\//, "").split("/")[0];
		expect(manifest.files).toContain(top);
	});

	it("ships a skill carrying the frontmatter pi reads", () => {
		const skill = fs.readFileSync(path.join(root, manifest.pi.skills[0]), "utf8");
		expect(skill).toMatch(/^---\n(?:.*\n)*?name: \S+/);
		expect(skill).toMatch(/\ndescription: \S+/);
	});
});
