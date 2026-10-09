// The one way core opens a SQLite file. Each SQL text compiles once and is reused, since a statement
// prepared on every call costs more than the write it runs.

import { DatabaseSync, type StatementSync } from "node:sqlite";

////////////////////////////////
//  Interfaces & Types

/** What a row owner needs of a database: its statements, and nothing that opens or closes it. */
export type Statements = Pick<Database, "prepare" | "exec">;

////////////////////////////////
//  Constants

/** Statements one database keeps; past this the least recently used is dropped. */
const STATEMENTS_KEPT = 1_000;

/** How long a write waits on another connection's lock before it fails: past one batch's hold. */
export const BUSY_MS = 2_000;

/** A statement that changes rows. */
const WRITES = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

/** The ways a statement runs. */
const RUNS = new Set<PropertyKey>(["run", "get", "all", "iterate"]);

////////////////////////////////
//  Class

export class Database {
	private readonly statements = new Map<string, StatementSync>();
	/** Kept statements with an iteration open, which any other use of them would end. */
	private readonly iterating = new Set<StatementSync>();

	private constructor(private readonly db: DatabaseSync) {}

	/** `busyMs` 0 suits a best-effort write, which tries once rather than stall its caller. */
	static open(file: string, options?: ConstructorParameters<typeof DatabaseSync>[1], busyMs = BUSY_MS): Database {
		const opened = new Database(options === undefined ? new DatabaseSync(file) : new DatabaseSync(file, options));
		opened.exec(`PRAGMA busy_timeout = ${busyMs}`);
		return opened;
	}

	/**
	 * The statement for `sql`, compiled at its first use. While the kept one is iterating, a fresh one,
	 * so a read nested in the iteration cannot end it.
	 */
	prepare(sql: string): StatementSync {
		const kept = this.statements.get(sql);
		if (kept !== undefined && this.iterating.has(kept)) return this.db.prepare(sql);
		if (kept !== undefined) {
			this.statements.delete(sql);
			this.statements.set(sql, kept);
			return kept;
		}
		const statement = this.tracked(this.db.prepare(sql));
		this.statements.set(sql, statement);
		if (this.statements.size > STATEMENTS_KEPT) {
			const [oldest] = this.statements.keys();
			if (oldest !== undefined) this.statements.delete(oldest);
		}
		return statement;
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	/** These statements, each write passed to `check` before it runs, which refuses by throwing. */
	checkedWrites(check: (sql: string) => void): Statements {
		return {
			prepare: (sql) => {
				const statement = this.prepare(sql);
				if (!WRITES.test(sql)) return statement;
				return new Proxy(statement, {
					get: (target, key) => {
						const value: unknown = Reflect.get(target, key, target);
						if (typeof value !== "function") return value;
						if (!RUNS.has(key)) return value.bind(target);
						return (...args: unknown[]) => {
							check(sql);
							return value.apply(target, args);
						};
					},
				});
			},
			exec: (sql) => {
				if (WRITES.test(sql)) check(sql);
				this.exec(sql);
			},
		};
	}

	close(): void {
		this.statements.clear();
		this.db.close();
	}

	/** Marks a kept statement busy from an iteration's start to its end, finished, broken off or thrown. */
	private tracked(statement: StatementSync): StatementSync {
		const iterate = statement.iterate.bind(statement);
		const iterating = this.iterating;
		statement.iterate = ((...params: never[]) => {
			const rows = iterate(...params);
			iterating.add(statement);
			const done = () => iterating.delete(statement);
			return {
				[Symbol.iterator]() {
					return this;
				},
				next() {
					try {
						const step = rows.next();
						if (step.done === true) done();
						return step;
					} catch (error) {
						done();
						throw error;
					}
				},
				return(value?: unknown) {
					done();
					return rows.return?.(value as never) ?? { done: true, value };
				},
			};
		}) as StatementSync["iterate"];
		return statement;
	}
}
