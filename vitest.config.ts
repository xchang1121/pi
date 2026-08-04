import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
		],
	},
});
