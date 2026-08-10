// One queue per provider.
//
// A provider is a single request-response process, so two concurrent callers must not interleave
// on it. Serializing here rather than at each call site means a caller never has to know that,
// and a slow request delays only its own provider.

////////////////////////////////
//  Interfaces & Types

export interface QueueStats {
	/** Waiting, not counting the one running. */
	pending: number;
	running: boolean;
}

interface Waiting<T> {
	work: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

////////////////////////////////
//  Class

export class RequestQueue {
	private queue: Waiting<unknown>[] = [];
	private running = false;
	private closed: Error | null = null;

	/**
	 * Runs `work` once every earlier request has settled.
	 *
	 * A rejection settles its own caller and nothing else: one failed request must not cancel the
	 * queue behind it, since those callers asked unrelated questions.
	 */
	run<T>(work: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(this.closed);
		return new Promise<T>((resolve, reject) => {
			this.queue.push({ work, resolve, reject } as Waiting<unknown>);
			void this.pump();
		});
	}

	private async pump(): Promise<void> {
		if (this.running) return;
		this.running = true;

		while (this.queue.length > 0) {
			const next = this.queue.shift() as Waiting<unknown>;
			try {
				next.resolve(await next.work());
			} catch (error) {
				next.reject(error);
			}
		}

		this.running = false;
	}

	/**
	 * Rejects everything waiting, and everything that arrives afterwards.
	 *
	 * Used when the provider process dies. Leaving them pending would hang every caller until its
	 * own timeout, one after another, which reads as the whole daemon being stuck.
	 */
	close(reason: Error): void {
		this.closed = reason;
		const waiting = this.queue;
		this.queue = [];
		for (const entry of waiting) entry.reject(reason);
	}

	/** Lets a closed queue serve a restarted provider, rather than being replaced. */
	reopen(): void {
		this.closed = null;
	}

	stats(): QueueStats {
		return { pending: this.queue.length, running: this.running };
	}
}
