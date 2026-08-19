export type PostSettlementFailureHandler = (error: unknown) => void;

/** Ordered, failure-isolated work that must never extend the Actor settlement barrier. */
export class PostSettlementQueue {
	private tail: Promise<void> = Promise.resolve();
	private closed = false;
	private readonly onFailure: PostSettlementFailureHandler;

	constructor(onFailure: PostSettlementFailureHandler = () => {}) {
		this.onFailure = onFailure;
	}

	enqueue(task: () => void | Promise<void>): boolean {
		if (this.closed) return false;
		this.tail = this.tail.then(task).catch((error) => {
			try {
				this.onFailure(error);
			} catch {
				// Diagnostics cannot poison the ordered effects chain.
			}
		});
		return true;
	}

	async flush(): Promise<void> {
		while (true) {
			const observed = this.tail;
			await observed;
			if (observed === this.tail) return;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.flush();
	}
}
