const childProcess = require("node:child_process");
const fs = require("node:fs");

const reportPath = process.env.PPIE_SPAWN_REPORT_PATH;

function report(pid, args) {
	if (!reportPath || !pid) return;
	try {
		fs.appendFileSync(reportPath, `${JSON.stringify({ pid, args })}\n`);
	} catch {}
}

function wrap(original) {
	return function (command, args, options) {
		const child = original.apply(this, arguments);
		report(child.pid, [command, ...(args ?? [])].map(String));
		return child;
	};
}

childProcess.spawn = wrap(childProcess.spawn);
childProcess.fork = wrap(childProcess.fork);
