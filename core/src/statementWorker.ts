// Long statements run in workers.
// Termination rolls back statements.

import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { Database } from "./database.js";

////////////////////////////////
//  Interfaces & Types

/** SQL statement and database file. */
export interface Statement {
	file: string;
	sql: string;
}

/** Runs one statement in a worker. */
export type StatementRunner = (statement: Statement) => Promise<void>;

/** Carries SQLite error codes for classification. */
type Reply = { ok: true } | { ok: false; message: string; errcode?: number };

////////////////////////////////
//  Functions & Helpers

function isStatement(value: unknown): value is Statement {
	const candidate = value as Partial<Statement> | null;
	return typeof candidate?.file === "string" && typeof candidate.sql === "string";
}

function failure(error: unknown): Reply {
	const errcode = (error as { errcode?: unknown } | null)?.errcode;
	return {
		ok: false,
		message: error instanceof Error ? error.message : String(error),
		...(typeof errcode === "number" ? { errcode } : {}),
	};
}

/** Closes SQLite before replying. */
function execute({ file, sql }: Statement): Reply {
	let db: Database | null = null;
	try {
		db = Database.open(file);
		db.exec(sql);
		return { ok: true };
	} catch (error) {
		return failure(error);
	} finally {
		db?.close();
	}
}

/** Worker errors retain SQLite codes. */
export const runInWorker: StatementRunner = (statement) =>
	new Promise<void>((resolve, reject) => {
		const worker = new Worker(new URL("./statementWorker.js", import.meta.url), { workerData: statement });
		let answered = false;
		worker.once("message", (reply: Reply) => {
			answered = true;
			if (reply.ok) resolve();
			else
				reject(
					Object.assign(
						new Error(reply.message),
						reply.errcode === undefined ? {} : { errcode: reply.errcode },
					),
				);
			void worker.terminate();
		});
		worker.once("error", (error) => {
			answered = true;
			reject(error);
		});
		worker.once("exit", (code) => {
			if (!answered) reject(new Error(`the statement worker ended with code ${code} before it answered`));
		});
	});

////////////////////////////////
//  Worker entry

if (!isMainThread && parentPort !== null && isStatement(workerData)) parentPort.postMessage(execute(workerData));
