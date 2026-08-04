import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import type { ActionKey } from "./common.ts";
import { contains, slash } from "./common.ts";

export const MAX_FINGERPRINT_ENTRIES = 10_000;
const TRUNCATED_FINGERPRINT = { truncated: true, maxEntries: MAX_FINGERPRINT_ENTRIES } as const;

interface FingerprintBudget {
	count: number;
	truncated: boolean;
}

/** Capture a deterministic version for every file or directory resource used by an action. */
export async function fingerprintActionResources(action: ActionKey, cwd: string): Promise<string> {
	const root = path.resolve(cwd);
	const resources = await Promise.all(
		action.resources
			.slice()
			.sort()
			.map(async (resource) => {
				const absolute = path.resolve(root, resource);
				if (!contains(root, absolute)) return { path: resource, invalid: true };
				return fingerprintPath(absolute, root, { count: 0, truncated: false });
			}),
	);
	return JSON.stringify({ tool: action.tool, resources });
}

async function fingerprintPath(absolute: string, root: string, budget: FingerprintBudget): Promise<unknown> {
	if (budget.truncated) return TRUNCATED_FINGERPRINT;
	budget.count++;
	if (budget.count > MAX_FINGERPRINT_ENTRIES) {
		budget.truncated = true;
		return TRUNCATED_FINGERPRINT;
	}

	const relative = slash(path.relative(root, absolute) || ".");
	let stats: Stats;
	try {
		stats = await lstat(absolute);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
		return { path: relative, exists: false, code };
	}

	if (stats.isSymbolicLink()) {
		let target = "<unreadable>";
		try {
			target = await readlink(absolute);
		} catch {
			// Keep the explicit unreadable marker.
		}
		return {
			path: relative,
			type: "symlink",
			target,
			mtimeMs: Math.trunc(stats.mtimeMs),
			size: stats.size,
		};
	}
	if (stats.isFile()) {
		return { path: relative, type: "file", mtimeMs: Math.trunc(stats.mtimeMs), size: stats.size };
	}
	if (!stats.isDirectory()) {
		return { path: relative, type: "other", mtimeMs: Math.trunc(stats.mtimeMs), size: stats.size };
	}

	let entries: Dirent[];
	try {
		entries = await readdir(absolute, { withFileTypes: true });
	} catch {
		return { path: relative, type: "dir", unreadable: true, mtimeMs: Math.trunc(stats.mtimeMs) };
	}
	const children: unknown[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		children.push(await fingerprintPath(path.join(absolute, entry.name), root, budget));
		if (budget.truncated) break;
	}
	return {
		path: relative,
		type: "dir",
		mtimeMs: Math.trunc(stats.mtimeMs),
		children: budget.truncated ? [TRUNCATED_FINGERPRINT] : children,
	};
}
