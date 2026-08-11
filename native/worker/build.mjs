import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = process.env.PI_SPECULATIVE_WORKER_RUNTIME || "docker";
const image = process.env.PI_SPECULATIVE_WORKER_IMAGE || "pi-speculative-worker:latest";
const child = spawn(runtime, ["build", "--tag", image, "--file", path.join(root, "Containerfile"), root], {
	stdio: "inherit",
	windowsHide: true,
});

child.on("error", (error) => {
	console.error(`Failed to start ${runtime}: ${error.message}`);
	process.exitCode = 1;
});
child.on("exit", (code) => {
	if (code !== 0) process.exitCode = code ?? 1;
});
