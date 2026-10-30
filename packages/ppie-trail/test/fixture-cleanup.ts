import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export function archiveFixtures(directories: string[]) {
	const trash = path.join(homedir(), ".Trash");
	mkdirSync(trash, { recursive: true });
	for (const directory of directories.splice(0)) {
		const destination = path.join(trash, `ppie-trail-${path.basename(directory)}-${Date.now()}`);
		execFileSync("mv", ["-n", "--", directory, destination]);
	}
}
