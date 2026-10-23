import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

// Node's --import hook runs before test modules are evaluated, preventing
// import-time policy resolution from reading the operator's real config.
const hermeticHome = mkdtempSync(join(tmpdir(), "ppie-recover-node-home-"));
process.env.HOME = hermeticHome;
process.env.USERPROFILE = hermeticHome;
process.once("exit", () => {
	rmSync(hermeticHome, { recursive: true, force: true });
});
