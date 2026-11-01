const child = Number(process.argv[2]);
const owner = Number(process.argv[3]);
const timer = setInterval(() => {
	try {
		process.kill(owner, 0);
	} catch {
		clearInterval(timer);
		try {
			process.kill(-child, "SIGKILL");
		} catch {}
		try {
			process.kill(child, "SIGKILL");
		} catch {}
		process.exit(0);
	}
}, 200);
