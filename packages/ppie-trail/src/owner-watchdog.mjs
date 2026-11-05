const child = Number(process.argv[2]);
const owner = Number(process.argv[3]);

if (!Number.isInteger(child) || child <= 1) process.exit(0);

function exists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const timer = setInterval(() => {
	if (!exists(owner)) {
		clearInterval(timer);
		try {
			process.kill(-child, "SIGKILL");
		} catch {}
		try {
			process.kill(child, "SIGKILL");
		} catch {}
		process.exit(0);
	}
	if (!exists(child) && !exists(-child)) {
		clearInterval(timer);
		process.exit(0);
	}
}, 200);
