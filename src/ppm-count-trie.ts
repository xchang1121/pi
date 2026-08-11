export type PpmCountTrieRow = {
	readonly context: readonly string[];
	readonly counts: Readonly<Record<string, number>>;
	readonly lastSeen: number;
};

export type PpmProbabilityEstimate = {
	readonly probability: number;
	/** Longest suffix order that contributed evidence for the target. */
	readonly order: number;
	readonly evidence: number;
	readonly escapeMass: number;
};

type TargetCount = {
	count: number;
	lastSeen: number;
};

type CountNode = {
	readonly children: Map<string, CountNode>;
	readonly targets: Map<string, TargetCount>;
	total: number;
	lastSeen: number;
};

/**
 * Bounded-order context count trie with interpolated PPM escape.
 *
 * Context edges are stored newest-event first, so querying every suffix costs
 * O(maxOrder). Counts belong to exact context nodes; observing one transition
 * updates the root and every suffix order exactly once.
 */
export class PpmCountTrie {
	private root = node();
	private populatedContexts = 0;
	private order: number;

	constructor(maxOrder: number) {
		this.order = nonNegativeInteger(maxOrder);
	}

	get maxOrder(): number {
		return this.order;
	}

	get size(): number {
		return this.populatedContexts;
	}

	observe(history: readonly string[], target: string, sequence = 0): void {
		if (!target) return;
		const lastSeen = nonNegativeInteger(sequence);
		this.increment(this.root, target, 1, lastSeen);
		let current = this.root;
		const suffix = history.slice(-this.order);
		for (let index = suffix.length - 1; index >= 0; index--) {
			const token = suffix[index];
			if (token === undefined) continue;
			const child = current.children.get(token) ?? node();
			current.children.set(token, child);
			current = child;
			this.increment(current, target, 1, lastSeen);
		}
	}

	/** Set evidence for one exact context without implicitly changing its suffixes. */
	setCount(context: readonly string[], target: string, count: number, lastSeen = 0): void {
		if (!target || context.length > this.order) return;
		const normalizedCount = positiveCount(count);
		if (normalizedCount === undefined) return;
		let current = this.root;
		for (let index = context.length - 1; index >= 0; index--) {
			const token = context[index];
			if (token === undefined) continue;
			const child = current.children.get(token) ?? node();
			current.children.set(token, child);
			current = child;
		}
		const wasEmpty = current.total === 0;
		const previous = current.targets.get(target)?.count ?? 0;
		current.targets.set(target, { count: normalizedCount, lastSeen: nonNegativeInteger(lastSeen) });
		current.total = safeTotal(current.total + normalizedCount - previous);
		current.lastSeen = Math.max(current.lastSeen, nonNegativeInteger(lastSeen));
		if (wasEmpty && current.total > 0) this.populatedContexts++;
	}

	estimate(history: readonly string[], target: string): PpmProbabilityEstimate | undefined {
		if (!target || this.root.total <= 0) return undefined;
		const suffixNodes: Array<{ readonly node: CountNode; readonly order: number }> = [{ node: this.root, order: 0 }];
		let current = this.root;
		const suffix = history.slice(-this.order);
		for (let index = suffix.length - 1, order = 1; index >= 0; index--, order++) {
			const token = suffix[index];
			if (token === undefined) continue;
			const child = current.children.get(token);
			if (!child) break;
			current = child;
			if (current.total > 0) suffixNodes.push({ node: current, order });
		}

		let remaining = 1;
		let probability = 0;
		let matchedOrder = -1;
		let evidence = 0;
		for (const item of suffixNodes.reverse()) {
			const distinct = item.node.targets.size;
			if (item.node.total <= 0 || distinct <= 0) continue;
			const denominator = item.node.total + distinct;
			const count = item.node.targets.get(target)?.count ?? 0;
			if (count > 0) {
				probability += remaining * (count / denominator);
				if (item.order > matchedOrder) {
					matchedOrder = item.order;
					evidence = count;
				}
			}
			remaining *= distinct / denominator;
		}
		if (matchedOrder < 0) return undefined;
		return {
			probability: clampProbability(probability),
			order: matchedOrder,
			evidence,
			escapeMass: clampProbability(remaining),
		};
	}

	probability(history: readonly string[], target: string): number | undefined {
		return this.estimate(history, target)?.probability;
	}

	snapshot(maxContexts = Number.POSITIVE_INFINITY): readonly PpmCountTrieRow[] {
		const rows: Array<PpmCountTrieRow & { readonly total: number }> = [];
		const visit = (current: CountNode, reverseContext: readonly string[]): void => {
			if (current.total > 0) {
				rows.push({
					context: [...reverseContext].reverse(),
					counts: Object.fromEntries(
						[...current.targets.entries()]
							.sort(([left], [right]) => left.localeCompare(right))
							.map(([target, value]) => [target, value.count]),
					),
					lastSeen: current.lastSeen,
					total: current.total,
				});
			}
			for (const [token, child] of [...current.children.entries()].sort(([left], [right]) =>
				left.localeCompare(right),
			)) {
				visit(child, [...reverseContext, token]);
			}
		};
		visit(this.root, []);
		const root = rows.find((row) => row.context.length === 0);
		const descendants = rows
			.filter((row) => row.context.length > 0)
			.sort(
				(left, right) =>
					right.total - left.total ||
					right.context.length - left.context.length ||
					right.lastSeen - left.lastSeen ||
					contextKey(left.context).localeCompare(contextKey(right.context)),
			);
		const limit = Number.isFinite(maxContexts) ? Math.max(1, Math.floor(maxContexts)) : Number.POSITIVE_INFINITY;
		return [...(root ? [root] : []), ...descendants].slice(0, limit).map(({ total: _, ...row }) => row);
	}

	restore(rows: readonly unknown[]): void {
		this.root = node();
		this.populatedContexts = 0;
		for (const value of rows) {
			const row = countRow(value);
			if (!row || row.context.length > this.order) continue;
			for (const [target, count] of Object.entries(row.counts)) {
				if (typeof count !== "number") continue;
				this.setCount(row.context, target, count, row.lastSeen);
			}
		}
	}

	reconfigure(maxOrder: number, maxContexts: number): void {
		const rows = this.snapshot(maxContexts).filter((row) => row.context.length <= nonNegativeInteger(maxOrder));
		this.order = nonNegativeInteger(maxOrder);
		this.restore(rows);
	}

	trim(maxContexts: number): void {
		const limit = Math.max(1, Math.floor(maxContexts));
		if (this.size <= limit) return;
		this.restore(this.snapshot(limit));
	}

	private increment(current: CountNode, target: string, count: number, lastSeen: number): void {
		const wasEmpty = current.total === 0;
		const previous = current.targets.get(target);
		const nextCount = safeCount((previous?.count ?? 0) + count);
		current.targets.set(target, {
			count: nextCount,
			lastSeen: Math.max(previous?.lastSeen ?? 0, lastSeen),
		});
		current.total = safeTotal(current.total + nextCount - (previous?.count ?? 0));
		current.lastSeen = Math.max(current.lastSeen, lastSeen);
		if (wasEmpty) this.populatedContexts++;
	}
}

function node(): CountNode {
	return { children: new Map(), targets: new Map(), total: 0, lastSeen: 0 };
}

function nonNegativeInteger(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function positiveCount(value: number): number | undefined {
	return Number.isFinite(value) && value > 0 ? safeCount(value) : undefined;
}

function safeCount(value: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER));
}

function safeTotal(value: number): number {
	const maximum = Number.MAX_VALUE / 2;
	return Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : maximum));
}

function clampProbability(value: number): number {
	return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function validContext(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function countRow(value: unknown): PpmCountTrieRow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const row = value as { context?: unknown; counts?: unknown; lastSeen?: unknown };
	if (!validContext(row.context) || !row.counts || typeof row.counts !== "object" || Array.isArray(row.counts)) {
		return undefined;
	}
	return {
		context: row.context,
		counts: row.counts as Record<string, number>,
		lastSeen: typeof row.lastSeen === "number" ? row.lastSeen : 0,
	};
}

function contextKey(context: readonly string[]): string {
	return JSON.stringify(context);
}
