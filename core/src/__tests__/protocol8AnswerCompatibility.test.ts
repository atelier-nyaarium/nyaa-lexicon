import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { connect as netConnect } from "node:net";
import { DAEMON_METHODS, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { z } from "zod";
import { downgradeAnswerForClientMajor, MAJOR_8_DOWNGRADE_METHODS } from "../answerCompatibility.js";
import { type FrameServer, serveFrames } from "../socketTransport.js";
import {
	Protocol8IndexStatusSchema,
	Protocol8ModuleStatusSchema,
	Protocol8NoteOutcomeSchema,
	Protocol8NoteSchema,
	Protocol8ProviderReferenceSchema,
	Protocol8RefactorBeforeImageSchema,
	Protocol8RefactorSettledImageSchema,
	Protocol8StoredDeclarationSchema,
	Protocol8SymbolSourceSchema,
	Protocol8SymbolSummarySchema,
	Protocol8TypeInfoSchema,
} from "./fixtures/protocol8Answers.js";

////////////////////////////////
//  Constants

const TOKEN = "0123456789abcdef0123456789abcdef";
const POINT = { line: 0, character: 0 };
const RANGE = { start: POINT, end: POINT };

////////////////////////////////
//  Interfaces & Types

type WireFrame = { kind?: string; id?: number; ok?: boolean; result?: unknown };
type SchemaEntry = { response: z.ZodType };
type CompatibilityPolicy = "same" | "additive" | "downgrade" | "new";
type CompatibilityEntry = { policy: CompatibilityPolicy; legacyHash: string | null; hash: string };

////////////////////////////////
//  Fixtures

const note = {
	symbolId: "ts:src/a.ts:class:A",
	recordedAs: "src/a.ts",
	revision: 1,
	text: "An example note.",
	summary: "An example note.",
	restAt: 16,
	author: null,
	authoredAt: 1,
	editedBy: null,
	editedAt: 1,
	sourceChanged: false,
	links: [{ written: "[[module:secret.env]]", current: "secret.env", kind: "file", state: "withheld" }],
};

const summary = {
	symbolId: "ts:src/a.ts:function:run",
	name: "run",
	kind: "function",
	module: "src/a.ts",
	valueStatus: "set",
	visibility: "public",
};

const storedDeclaration = {
	...summary,
	factId: "lexfact declaration one",
	range: RANGE,
};

const answers = {
	readNote: note,
	writeNote: { outcome: "saved", note },
	moduleStatus: { module: ".env", exists: true, claimed: true, indexed: true },
	typeOf: { status: "unknown", reason: "NotImplemented" },
	findByName: [summary],
	declarationOf: storedDeclaration,
	indexStatus: {
		state: "ready",
		done: 0,
		total: 0,
		failures: 0,
		failed: [],
		scopeNotes: ["scope note"],
		stored: 0,
		fullFiles: 0,
		outlineFiles: 0,
	},
	symbolSource: {
		found: true,
		module: "src/a.ts",
		name: "run",
		kind: "function",
		range: RANGE,
		valueStatus: "set",
		text: "function run() {}",
		contentHash: "a".repeat(64),
	},
	refactorBeforeImage: { tracked: false, reason: "module withheld" },
	refactorSettledImage: { held: false, reason: "module withheld" },
} satisfies Record<string, unknown>;

////////////////////////////////
//  Test Helpers

let server: FrameServer | undefined;

async function serve(): Promise<FrameServer> {
	server = await serveFrames({
		token: TOKEN,
		handle: async (method, params) => {
			const refused =
				params !== null &&
				typeof params === "object" &&
				!Array.isArray(params) &&
				(params as Record<string, unknown>)["refused"] === true;
			return method === "writeNote" && refused
				? { outcome: "refused", reason: "revision changed", current: note }
				: answers[method as keyof typeof answers];
		},
	});
	return server;
}

async function connectPeer(
	port: number,
	protocolVersion?: string,
): Promise<{
	ask(method: string, params?: unknown): Promise<unknown>;
	close(): void;
}> {
	const socket = netConnect({ port, host: "127.0.0.1" });
	let buffer = "";
	const queued: WireFrame[] = [];
	const waiters: Array<{ matches: (frame: WireFrame) => boolean; resolve: (frame: WireFrame) => void }> = [];
	const receive = (frame: WireFrame): void => {
		const at = waiters.findIndex((waiter) => waiter.matches(frame));
		if (at < 0) {
			queued.push(frame);
			return;
		}
		(waiters.splice(at, 1)[0] as (typeof waiters)[number]).resolve(frame);
	};
	const waitFor = (matches: (frame: WireFrame) => boolean): Promise<WireFrame> => {
		const at = queued.findIndex(matches);
		if (at >= 0) return Promise.resolve(queued.splice(at, 1)[0] as WireFrame);
		return new Promise((resolve) => waiters.push({ matches, resolve }));
	};
	socket.on("data", (chunk) => {
		buffer += chunk.toString();
		for (;;) {
			const end = buffer.indexOf("\n");
			if (end < 0) break;
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			receive(JSON.parse(line) as WireFrame);
		}
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	socket.write(
		`${JSON.stringify({ kind: "hello", token: TOKEN, ...(protocolVersion === undefined ? {} : { protocolVersion }) })}\n`,
	);
	await waitFor((frame) => frame.kind === "welcome");
	let nextId = 0;
	return {
		ask: async (method, params = {}) => {
			const id = nextId++;
			socket.write(`${JSON.stringify({ kind: "request", id, method, params })}\n`);
			const frame = await waitFor((candidate) => candidate.kind === "response" && candidate.id === id);
			if (frame.ok !== true) throw new Error("daemon refused the compatibility fixture request");
			return frame.result;
		},
		close: () => socket.destroy(),
	};
}

function schemaHash(schema: z.ZodType): string {
	return createHash("sha256")
		.update(JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" })))
		.digest("hex");
}

function unregisteredShapes(
	methods: Record<string, SchemaEntry>,
	registry: Record<string, CompatibilityEntry>,
): string[] {
	const problems: string[] = [];
	for (const [method, entry] of Object.entries(methods)) {
		const registered = registry[method];
		if (registered === undefined || schemaHash(entry.response) !== registered.hash) problems.push(method);
	}
	for (const method of Object.keys(registry)) if (!(method in methods)) problems.push(method);
	return problems.sort();
}

function misclassifiedShapes(registry: Record<string, CompatibilityEntry>): string[] {
	return Object.entries(registry)
		.filter(([_, entry]) => {
			if (entry.legacyHash === null) return entry.policy !== "new";
			if (entry.legacyHash === entry.hash) return entry.policy !== "same";
			return entry.policy !== "additive" && entry.policy !== "downgrade";
		})
		.map(([method]) => method)
		.sort();
}

afterEach(async () => {
	await server?.close();
	server = undefined;
});

////////////////////////////////
//  Tests

describe("major-8 daemon answer compatibility", () => {
	it("downgrades note states before transport", () => {
		expect(Protocol8NoteSchema.safeParse(note).success).toBe(false);
		expect(Protocol8NoteOutcomeSchema.safeParse(answers.writeNote).success).toBe(false);
		expect(
			Protocol8NoteOutcomeSchema.safeParse({ outcome: "refused", reason: "revision changed", current: note })
				.success,
		).toBe(false);

		const read = Protocol8NoteSchema.parse(downgradeAnswerForClientMajor("readNote", note, 8));
		const written = Protocol8NoteOutcomeSchema.parse(
			downgradeAnswerForClientMajor("writeNote", answers.writeNote, 8),
		);
		const refused = Protocol8NoteOutcomeSchema.parse(
			downgradeAnswerForClientMajor(
				"writeNote",
				{ outcome: "refused", reason: "revision changed", current: note },
				8,
			),
		);

		expect(read.links[0]?.state).toBe("broken");
		expect(written.outcome === "saved" && written.note?.links[0]?.state).toBe("broken");
		expect(refused.outcome === "refused" && refused.current?.links[0]?.state).toBe("broken");
		expect(downgradeAnswerForClientMajor("readNote", note, 9)).toBe(note);
		expect(Protocol8NoteSchema.safeParse(downgradeAnswerForClientMajor("readNote", note, 9)).success).toBe(false);
	});

	it("downgrades note links and keeps changed answers parseable", async () => {
		const running = await serve();
		expect(Protocol8NoteSchema.safeParse(note).success).toBe(false);
		expect(Protocol8NoteOutcomeSchema.safeParse(answers.writeNote).success).toBe(false);
		expect(
			Protocol8NoteOutcomeSchema.safeParse({ outcome: "refused", reason: "revision changed", current: note })
				.success,
		).toBe(false);
		const peer = await connectPeer(running.port, "8.0.0");
		try {
			const read = Protocol8NoteSchema.parse(await peer.ask("readNote", { symbolId: note.symbolId }));
			const written = Protocol8NoteOutcomeSchema.parse(await peer.ask("writeNote", { symbolId: note.symbolId }));
			const refused = Protocol8NoteOutcomeSchema.parse(await peer.ask("writeNote", { refused: true }));

			expect(read.links[0]?.state).toBe("broken");
			expect(written.outcome === "saved" && written.note?.links[0]?.state).toBe("broken");
			expect(refused.outcome === "refused" && refused.current?.links[0]?.state).toBe("broken");
		} finally {
			peer.close();
		}
		const unversioned = await connectPeer(running.port);
		try {
			expect(
				Protocol8NoteSchema.parse(await unversioned.ask("readNote", { symbolId: note.symbolId })).links[0]
					?.state,
			).toBe("broken");
		} finally {
			unversioned.close();
		}
	});

	it("keeps additive answers inside released schemas", async () => {
		const running = await serve();
		const peer = await connectPeer(running.port, "8.0.0");
		try {
			const module = Protocol8ModuleStatusSchema.parse(await peer.ask("moduleStatus", { module: ".env" }));
			const type = Protocol8TypeInfoSchema.parse(await peer.ask("typeOf", { symbolId: "a" }));
			const found = Protocol8SymbolSummarySchema.parse(
				((await peer.ask("findByName", { name: "run" })) as unknown[])[0],
			);
			const declaration = Protocol8StoredDeclarationSchema.parse(
				await peer.ask("declarationOf", { symbolId: "a" }),
			);
			const index = Protocol8IndexStatusSchema.parse(await peer.ask("indexStatus", {}));
			const source = Protocol8SymbolSourceSchema.parse(await peer.ask("symbolSource", { symbolId: "a" }));
			const before = Protocol8RefactorBeforeImageSchema.parse(
				await peer.ask("refactorBeforeImage", { module: "a" }),
			);
			const settled = Protocol8RefactorSettledImageSchema.parse(
				await peer.ask("refactorSettledImage", { module: "a" }),
			);

			expect(module.provider).toBeUndefined();
			expect(type).toMatchObject({ status: "unknown" });
			expect(found).not.toHaveProperty("valueStatus");
			expect(declaration).not.toHaveProperty("valueStatus");
			expect(index).not.toHaveProperty("scopeNotes");
			expect(source).not.toHaveProperty("valueStatus");
			expect(before).toEqual({ tracked: false });
			expect(settled).toEqual({ held: false });
			expect(
				Protocol8ModuleStatusSchema.safeParse({ ...(answers.moduleStatus as object), indexed: "yes" }).success,
			).toBe(false);
		} finally {
			peer.close();
		}
	});

	it("leaves protocol-9 note states unchanged", async () => {
		const running = await serve();
		const peer = await connectPeer(running.port, PROTOCOL_VERSION);
		try {
			const read = await peer.ask("readNote", { symbolId: note.symbolId });
			const written = await peer.ask("writeNote", { symbolId: note.symbolId });

			expect(DAEMON_METHODS.readNote.response.parse(read)).toMatchObject({ links: [{ state: "withheld" }] });
			expect(DAEMON_METHODS.writeNote.response.parse(written)).toMatchObject({
				outcome: "saved",
				note: { links: [{ state: "withheld" }] },
			});
			expect(Protocol8NoteSchema.safeParse(read).success).toBe(false);
		} finally {
			peer.close();
		}
	});
});

describe("daemon answer schema compatibility registry", () => {
	it("pins every response schema to a major-8 decision", () => {
		expect(unregisteredShapes(DAEMON_METHODS, MAJOR_8_RESPONSE_SHAPES)).toEqual([]);
	});

	it("classifies every released schema difference", () => {
		const classified = Object.entries(MAJOR_8_RESPONSE_SHAPES);
		const downgraded = classified
			.filter(([, entry]) => entry.policy === "downgrade")
			.map(([method]) => method)
			.sort();
		const added = classified
			.filter(([, entry]) => entry.policy === "new")
			.map(([method]) => method)
			.sort();
		const safe = classified
			.filter(([, entry]) => entry.policy === "additive")
			.map(([method]) => method)
			.sort();

		expect(misclassifiedShapes(MAJOR_8_RESPONSE_SHAPES)).toEqual([]);
		expect(DAEMON_METHODS).not.toHaveProperty("bind");
		expect(
			Protocol8ProviderReferenceSchema.safeParse({ binding: { status: "unknown", reason: "NotImplemented" } })
				.success,
		).toBe(false);
		expect(downgraded).toEqual(["readNote", "writeNote"]);
		expect(downgraded).toEqual([...MAJOR_8_DOWNGRADE_METHODS].sort());
		expect(added).toEqual(["moduleSecretModes", "moduleView"]);
		expect(safe).toEqual([
			"admittedModules",
			"callHierarchy",
			"declarationOf",
			"declarationsIn",
			"describe",
			"findByName",
			"findReferences",
			"hubs",
			"indexStatus",
			"indexWorkspace",
			"moduleDeclarations",
			"mostReferenced",
			"outlineModule",
			"overview",
			"refactorBeforeImage",
			"refactorSettledImage",
			"relationCandidates",
			"relationGaps",
			"relationsBetween",
			"relationsOf",
			"scopeSymbols",
			"searchSymbols",
			"symbolEdges",
			"symbolSource",
			"typeHierarchy",
			"usesFrom",
			"writeRelation",
		]);
	});

	it("detects an unregistered answer schema change", () => {
		const planted = {
			...DAEMON_METHODS,
			findByName: { ...DAEMON_METHODS.findByName, response: z.string() },
		} as Record<string, SchemaEntry>;
		const misclassified = {
			...MAJOR_8_RESPONSE_SHAPES,
			findByName: { ...MAJOR_8_RESPONSE_SHAPES.findByName, legacyHash: "0".repeat(64), policy: "same" },
		} as Record<string, CompatibilityEntry>;

		expect(unregisteredShapes(planted, MAJOR_8_RESPONSE_SHAPES)).toContain("findByName");
		expect(misclassifiedShapes(misclassified)).toContain("findByName");
	});
});

const MAJOR_8_RESPONSE_SHAPES = {
	findByName: {
		policy: "additive",
		legacyHash: "ab188a1005ca42e58264b53a0d34612f696cbf2ea155e8553a40da2ebe54707e",
		hash: "ab167b0cdc530c20d36d948e2d98b7c01f6e29860eb7f1e6b666b885530cace1",
	},
	describe: {
		policy: "additive",
		legacyHash: "9a89912a19cbc98453090f0ce4c246924a3519e016d98f08c5973620aa9d5998",
		hash: "46a649cbee1f40f7d4570e8479aa11d5688013142145899e9c95dcb7e67a81ae",
	},
	declarationOf: {
		policy: "additive",
		legacyHash: "b72cdda564f7fd79a89aa2c27e038c3eb196d499719a940fda7c34a202d2006e",
		hash: "586ec9f9966a5389a8729e97d4cfd62b71514fa5f9d3d9aa07c0e595acc34f8e",
	},
	declarationsIn: {
		policy: "additive",
		legacyHash: "096d57d8bf9056abaf2d23f6c0ed55ddb17cba723070dbffff423f766194625f",
		hash: "298cfe64dcadad54fb503b8adf765f2bc6ab8618ad4bc2058a1943cc1ac159e1",
	},
	typeHierarchy: {
		policy: "additive",
		legacyHash: "7f474fb70960f5ace702b4140fc6fc8d488d1656ad68e8df047b38b6d93efcb3",
		hash: "bfadb8e28814a7842d91da5e7a4bec917a4e8ab968dd492f07e100961b3424c3",
	},
	callHierarchy: {
		policy: "additive",
		legacyHash: "9ed1468e2eaaa00f1a5da71ef8ab7636fdf53717b27ca31e6b14afdf0c19bc6d",
		hash: "71e6df2a6c8c68c1d601773c3c8b9bf8360ed83a8efdc682e4e8a7f17a4fb124",
	},
	symbolEdges: {
		policy: "additive",
		legacyHash: "726fa31582fd779c232025d18ddc569b57ff8601298a666899688e1e41759098",
		hash: "4676186b4363e094685482e917b4fbb32216393a276a458eee9d191a849843c1",
	},
	findReferences: {
		policy: "additive",
		legacyHash: "3eabbaf0d9f2535287c96686d01bb50bf79eae33f592589ffcf9f61f10fddd1d",
		hash: "4b8d58ee3bd1dee80895f0d3e14c20ab0823dda85b1637de85574bd21586a6f0",
	},
	usesFrom: {
		policy: "additive",
		legacyHash: "42fbe497b019dcca129f5df7c16f3110fc4e54d55a57aae005ee1dfdac4e88f7",
		hash: "e29e09160550bafd252d3fb77d4f97b4281b38db358d618a274b651263f0c5d8",
	},
	resolveImport: {
		policy: "same",
		legacyHash: "b8ffcfb57fa87843c827d788ef8a33a57a4017f81c57a77d0f7f8abdf773834e",
		hash: "b8ffcfb57fa87843c827d788ef8a33a57a4017f81c57a77d0f7f8abdf773834e",
	},
	indexStatus: {
		policy: "additive",
		legacyHash: "f5115420134e4e81305f227290504bd8f90543148c3fd9d0f70898ba3005730f",
		hash: "df907ceecc1805d1c6c252e6de1ed91253400db5f3788f1c474d5378a389a1a3",
	},
	discoverSubmodules: {
		policy: "same",
		legacyHash: "216e45d6df556ba2ccc2cba0eef4893acf7b44795bf0d117fdf28fe64bc3cfc3",
		hash: "216e45d6df556ba2ccc2cba0eef4893acf7b44795bf0d117fdf28fe64bc3cfc3",
	},
	indexWorkspace: {
		policy: "additive",
		legacyHash: "f5115420134e4e81305f227290504bd8f90543148c3fd9d0f70898ba3005730f",
		hash: "df907ceecc1805d1c6c252e6de1ed91253400db5f3788f1c474d5378a389a1a3",
	},
	findLiterals: {
		policy: "same",
		legacyHash: "d075fbb230957986b6af22141921b8c32c0401386c1b462fc2af5a80453875b0",
		hash: "d075fbb230957986b6af22141921b8c32c0401386c1b462fc2af5a80453875b0",
	},
	findComments: {
		policy: "same",
		legacyHash: "4cdcddccd75775b65ce83edde573a3acc0968e84efe73ec5b33d4b53e4ef98f3",
		hash: "4cdcddccd75775b65ce83edde573a3acc0968e84efe73ec5b33d4b53e4ef98f3",
	},
	findDocs: {
		policy: "same",
		legacyHash: "04c4da2489a6bb0c97cb877df03e35cffc70350ecfe2fd0bb7cffe0be32148d2",
		hash: "04c4da2489a6bb0c97cb877df03e35cffc70350ecfe2fd0bb7cffe0be32148d2",
	},
	sharedLiterals: {
		policy: "same",
		legacyHash: "75bad5269d9494986415cc084655519a0fad3f56d05704f0404ab7a9b8cfbe0d",
		hash: "75bad5269d9494986415cc084655519a0fad3f56d05704f0404ab7a9b8cfbe0d",
	},
	moduleCycles: {
		policy: "same",
		legacyHash: "534ec17c9d7cd4c79624294edae7cbb282a284afc2548e45e30e3fedc315a22e",
		hash: "534ec17c9d7cd4c79624294edae7cbb282a284afc2548e45e30e3fedc315a22e",
	},
	moduleProblems: {
		policy: "same",
		legacyHash: "1b3a82c1fcddd5b6d94a5b9db9808b173051f0c618dfdf881a5a33da8935453d",
		hash: "1b3a82c1fcddd5b6d94a5b9db9808b173051f0c618dfdf881a5a33da8935453d",
	},
	mostReferenced: {
		policy: "additive",
		legacyHash: "0240a3ec7b6d4de40c43e051f1d5a63a6e14e0163dd29673705d6346521b6dec",
		hash: "9a907be0aa5e706851eb62828bdc8156caab8e892ddb9ab8c450a1aa1dff9d16",
	},
	hubs: {
		policy: "additive",
		legacyHash: "0240a3ec7b6d4de40c43e051f1d5a63a6e14e0163dd29673705d6346521b6dec",
		hash: "9a907be0aa5e706851eb62828bdc8156caab8e892ddb9ab8c450a1aa1dff9d16",
	},
	cacheStats: {
		policy: "same",
		legacyHash: "f532cc72a8280d4fa53a710b04064d403d6fc4f38eb835b39bda7f57b4050135",
		hash: "f532cc72a8280d4fa53a710b04064d403d6fc4f38eb835b39bda7f57b4050135",
	},
	searchSymbols: {
		policy: "additive",
		legacyHash: "946461c6e18afb26ed92844cd157b396a35490732d65ce14fb24d278085a3e61",
		hash: "07c196ccc4431fe1207cd21571499cf230772cac82fff5f9880dc5f2a8f8bb9a",
	},
	outlineModule: {
		policy: "additive",
		legacyHash: "ab188a1005ca42e58264b53a0d34612f696cbf2ea155e8553a40da2ebe54707e",
		hash: "ab167b0cdc530c20d36d948e2d98b7c01f6e29860eb7f1e6b666b885530cace1",
	},
	fileNotes: {
		policy: "same",
		legacyHash: "74be3d910750b5288f4b37b875fa53a25daff6174d46e8b68bf070bc397a2306",
		hash: "74be3d910750b5288f4b37b875fa53a25daff6174d46e8b68bf070bc397a2306",
	},
	moduleStatus: {
		policy: "same",
		legacyHash: "a729fc4d3550eb641a00ef8da7ceefe233ad6fb96cf644ce1c564c61227c03f5",
		hash: "a729fc4d3550eb641a00ef8da7ceefe233ad6fb96cf644ce1c564c61227c03f5",
	},
	admittedModules: {
		policy: "additive",
		legacyHash: "aa07673961300763c06fa2a31e47c10a0e0014b58a4c0e7cef22d0603b73423d",
		hash: "8b52f8a0185cc487c5fbac1a994bc20b923c201d8b3ddb773dd2c7f1ea367608",
	},
	moduleSecretModes: {
		policy: "new",
		legacyHash: null,
		hash: "4c7f6cb71f7bf0152181e608a3cad85780f832b133cea2561741e0045d30b19d",
	},
	moduleView: {
		policy: "new",
		legacyHash: null,
		hash: "2f75ba31f5cb1264a1f23a60073d32665e4aff54d9a40d96a6e026bb91d44868",
	},
	moduleDeclarations: {
		policy: "additive",
		legacyHash: "0bab242858ca5859ef2de5b5bac70e0b182575a23927ae521c567f1d5e0de6e6",
		hash: "1333a2199878f38a05888a5ed5e6da6e5b40b0010170ac64a9e67ef27a381d9a",
	},
	moduleFacts: {
		policy: "same",
		legacyHash: "167b914d4eb5725e1193f529847fba38316cda837dffc3aeb54f90cf71c26eca",
		hash: "167b914d4eb5725e1193f529847fba38316cda837dffc3aeb54f90cf71c26eca",
	},
	parseFacts: {
		policy: "same",
		legacyHash: "1ac1826db9bf9c05dc411b37f9afa40022908364049b2b3b9f09e5bfbc987b12",
		hash: "1ac1826db9bf9c05dc411b37f9afa40022908364049b2b3b9f09e5bfbc987b12",
	},
	previewImport: {
		policy: "same",
		legacyHash: "838fa7454c9c18332935036e454138980334a340e63a5c60c216b3e8683c6dc8",
		hash: "838fa7454c9c18332935036e454138980334a340e63a5c60c216b3e8683c6dc8",
	},
	symbolAt: {
		policy: "same",
		legacyHash: "0270694e38b87527d452c4cd24978e064f9b4624674d6c228df29e23a7b34f2b",
		hash: "0270694e38b87527d452c4cd24978e064f9b4624674d6c228df29e23a7b34f2b",
	},
	findImports: {
		policy: "same",
		legacyHash: "96de7f4dd5f8265b98d979b1d5ce6f1643e8a4d6a0d95eb8455c83eabcacc86c",
		hash: "96de7f4dd5f8265b98d979b1d5ce6f1643e8a4d6a0d95eb8455c83eabcacc86c",
	},
	overview: {
		policy: "additive",
		legacyHash: "adaacafc4a23f1e4c433ef1c55b6674f7f3d39434e30b111de89ac66de6b2a18",
		hash: "e48291218090af5f762062959aecbd3cf1d3c644c143056b74f2ef3428281e60",
	},
	coChangedWith: {
		policy: "same",
		legacyHash: "da3e944a4ba323bf6b42f093d5683be9a50b497b4d40df7a622a2505e2bc3839",
		hash: "da3e944a4ba323bf6b42f093d5683be9a50b497b4d40df7a622a2505e2bc3839",
	},
	fileHistory: {
		policy: "same",
		legacyHash: "685ef4baa0940306e1748a74eceb3e832f2ccdcae8098e7442f733c26b309b95",
		hash: "685ef4baa0940306e1748a74eceb3e832f2ccdcae8098e7442f733c26b309b95",
	},
	commitsMentioning: {
		policy: "same",
		legacyHash: "c2068530a8180643f76b6f9f6717a6a535aedffe615b6bb96ced1cfa15901b19",
		hash: "c2068530a8180643f76b6f9f6717a6a535aedffe615b6bb96ced1cfa15901b19",
	},
	scopeSymbols: {
		policy: "additive",
		legacyHash: "8667e88b2067747f8211967584e916e9bc75aeb8cb4e8926d0c8f64f2e19acba",
		hash: "f6423dbfbf66494affc99f74bc1786a6939cfa184dfa67b5c976817ee0f1fbae",
	},
	readNote: {
		policy: "downgrade",
		legacyHash: "a6bc8542367b19aa1b58a2064962547dd63c3ded2f1eb50713f046a8c7eb9186",
		hash: "389f4339c2a0e1d195fbfa8d4c8f1ea20cbc4e43ed2a41adefa274a6eba8b841",
	},
	writeNote: {
		policy: "downgrade",
		legacyHash: "9f995b132c9b5a5c1a29d5d9fca40da6b934c568dad4d0cb8f6f42244f712f86",
		hash: "1c3b3026e7aedd2bf9be290e921cea327c5737b3b1195a49b4daf69ea9c913ff",
	},
	noteBacklinks: {
		policy: "same",
		legacyHash: "63e2ffc3e2e232d8c2facc93a4161028366dc6b42011c4303753b22894c3d02c",
		hash: "63e2ffc3e2e232d8c2facc93a4161028366dc6b42011c4303753b22894c3d02c",
	},
	relationsOf: {
		policy: "additive",
		legacyHash: "c71dd44e93d47ef6d54415713fe5d4a6ed2e4f59566e3a6bb0d31b11839e288f",
		hash: "c1855546891448e5692e40f79aa9c695d79203ba02fdb0e6a042a04dbbdeef34",
	},
	relationsBetween: {
		policy: "additive",
		legacyHash: "c3104fcddc08d4a0b088f26b15e357db31309c4494943aea6f9856a6c4be6e55",
		hash: "6f311bc1069b83a06f5255173b7dca9c22d750ed6d26ae5e413a7169991394f9",
	},
	relationCandidates: {
		policy: "additive",
		legacyHash: "9545fd3f3195663997b40279af0b56fc26ffde240891a035994114711b6dd9a9",
		hash: "cd6c0c9754e92682c766b153b24f6f5ea58f4bec6a0f17c4ecd82287cad19f12",
	},
	relationGaps: {
		policy: "additive",
		legacyHash: "c72e5cac07438c75f6e6ae44d004355f6cf7d7cfccd885be849cde508c27d29c",
		hash: "ae40ebb1e0420c4a3a55e5464bc9265a593dadd70a926e46f88777f524e4fc26",
	},
	writeRelation: {
		policy: "additive",
		legacyHash: "a9c6fb79d3d409e580bccd066a551980ac51e1c072400a266a9de2f458f9f5ba",
		hash: "ab9bbf7df14e105c81654f3ecf4641545398fb3f5ae05503a546ddc7a179d0c9",
	},
	answerRelationGap: {
		policy: "same",
		legacyHash: "6a0d9604984ffe9b2b51655298db0ddcd3592253fbb89de48aa29013961ba306",
		hash: "6a0d9604984ffe9b2b51655298db0ddcd3592253fbb89de48aa29013961ba306",
	},
	relationFeedback: {
		policy: "same",
		legacyHash: "f471a2540ae2cc5604ebadcfde13ff552769a37b05ddaa17b8a8f8e32426bbb1",
		hash: "f471a2540ae2cc5604ebadcfde13ff552769a37b05ddaa17b8a8f8e32426bbb1",
	},
	searchRefs: {
		policy: "same",
		legacyHash: "e664fbc166c742de23e896ea990f63dcf2979492671588d1729eb4eb48ffd555",
		hash: "e664fbc166c742de23e896ea990f63dcf2979492671588d1729eb4eb48ffd555",
	},
	diagnoseSubject: {
		policy: "same",
		legacyHash: "5f08ee1aa4d6d2d9856dec6e3c730b7d400d0b7df00c7dcc1d47b36f0443c559",
		hash: "5f08ee1aa4d6d2d9856dec6e3c730b7d400d0b7df00c7dcc1d47b36f0443c559",
	},
	typeOf: {
		policy: "same",
		legacyHash: "c7136bde3ad2aab7975d9a34b3bc59f99b9839b230b4961b7e20b8da03bd35b0",
		hash: "c7136bde3ad2aab7975d9a34b3bc59f99b9839b230b4961b7e20b8da03bd35b0",
	},
	prepareRename: {
		policy: "same",
		legacyHash: "19b8fb9262713405031e528f633a0ed1991848aa705ffa60c54c0aa859437a3b",
		hash: "19b8fb9262713405031e528f633a0ed1991848aa705ffa60c54c0aa859437a3b",
	},
	renameEdits: {
		policy: "same",
		legacyHash: "e2ffa46efe9f447d2174265657766109a99689264ccb62ef5720d0c0592f86f3",
		hash: "e2ffa46efe9f447d2174265657766109a99689264ccb62ef5720d0c0592f86f3",
	},
	planMove: {
		policy: "same",
		legacyHash: "fb053d1a595e2e2e763f8af4958bae197e8b188d8123cb5ca5bd8f8618babc2a",
		hash: "fb053d1a595e2e2e763f8af4958bae197e8b188d8123cb5ca5bd8f8618babc2a",
	},
	previewMove: {
		policy: "same",
		legacyHash: "f95fbd93018aae44356bb4e2470781c1f92b22af9fe405b853d2796ccc2e583e",
		hash: "f95fbd93018aae44356bb4e2470781c1f92b22af9fe405b853d2796ccc2e583e",
	},
	previewArrange: {
		policy: "same",
		legacyHash: "ff9859144d1517a5ba610953655c53bff1abdc8bc711bbe8cd9d810fb109bbd1",
		hash: "ff9859144d1517a5ba610953655c53bff1abdc8bc711bbe8cd9d810fb109bbd1",
	},
	previewInsert: {
		policy: "same",
		legacyHash: "0ab9f7643f725ddf78dba2e173fc69af891cee16ab440889bf026986f7371d7c",
		hash: "0ab9f7643f725ddf78dba2e173fc69af891cee16ab440889bf026986f7371d7c",
	},
	previewReplace: {
		policy: "same",
		legacyHash: "d058ca3492f4714b3e76c28ae5acc75a5bbed89df5611aa9cc89269f5f2f963d",
		hash: "d058ca3492f4714b3e76c28ae5acc75a5bbed89df5611aa9cc89269f5f2f963d",
	},
	indexFile: {
		policy: "same",
		legacyHash: "c4eebcc4fd0bc3c2721da90d7bc35b406dd38c5694453433e46d4c332e02e448",
		hash: "c4eebcc4fd0bc3c2721da90d7bc35b406dd38c5694453433e46d4c332e02e448",
	},
	symbolSource: {
		policy: "additive",
		legacyHash: "b908b85277567cb957b204210e6a828fc21552780aff16c5a3e6f1ecd5ae4606",
		hash: "a3c709167e5d240edde0ef2dc10fe9e19fd0c231b31ecc878224bf7020616090",
	},
	refactorStart: {
		policy: "same",
		legacyHash: "c30c482cb24d2d1c088fc8c1054c3aea1f887ccb12e29691e807e12dd60e156a",
		hash: "c30c482cb24d2d1c088fc8c1054c3aea1f887ccb12e29691e807e12dd60e156a",
	},
	refactorStatus: {
		policy: "same",
		legacyHash: "ea6eb2b909f48801f6ec1ad1926aa5a16c58bc3492b1222569bdeecbe1a49c99",
		hash: "ea6eb2b909f48801f6ec1ad1926aa5a16c58bc3492b1222569bdeecbe1a49c99",
	},
	refactorTrack: {
		policy: "same",
		legacyHash: "a8098f91ac265120c62fb2ac31a54dc5a5242e0e94fd7b5a124a9cfd6ba8d9c2",
		hash: "a8098f91ac265120c62fb2ac31a54dc5a5242e0e94fd7b5a124a9cfd6ba8d9c2",
	},
	refactorNoteWrite: {
		policy: "same",
		legacyHash: "9ca9a209684d8ead885cc13ec5eddadff3d5c1a3752ea20d278da8e812eccbf2",
		hash: "9ca9a209684d8ead885cc13ec5eddadff3d5c1a3752ea20d278da8e812eccbf2",
	},
	refactorBeforeImage: {
		policy: "additive",
		legacyHash: "64d35133536b5f58f6a83871242b70bd8494b8eac914a77c138cc89309140d7b",
		hash: "f58306157c3c48333dbaa45bfa690a7517d67d73a3b91362018dfb815a5e65fb",
	},
	refactorSettlements: {
		policy: "same",
		legacyHash: "cb77b6e826899e7aa0618e307c54f67eeb98ded64513c4574a7ada43e80d6185",
		hash: "cb77b6e826899e7aa0618e307c54f67eeb98ded64513c4574a7ada43e80d6185",
	},
	refactorSettledImage: {
		policy: "additive",
		legacyHash: "42b9222ef321e197b5cbe8ef769f08953d08b2f36ac9eb9fbb0b03180a8e0b52",
		hash: "c2c72e69c7f51535998ebe0378285e1245a978b9e0a253b3a3aa91f491e4147a",
	},
	refactorWriteFile: {
		policy: "same",
		legacyHash: "12339b17e45003b865a4742988704f3b5bcfaa7b6108934d110ce3d317b4f50f",
		hash: "12339b17e45003b865a4742988704f3b5bcfaa7b6108934d110ce3d317b4f50f",
	},
	refactorUndo: {
		policy: "same",
		legacyHash: "122c7930046fe3cd51c3356933e64548d8df3a7cc551f434cd81effd83bb4fae",
		hash: "122c7930046fe3cd51c3356933e64548d8df3a7cc551f434cd81effd83bb4fae",
	},
	refactorRevert: {
		policy: "same",
		legacyHash: "8bb5b6f3c7407e6a39bdd92d81fea5125d166d6dc2508bb20f4a3bc072631374",
		hash: "8bb5b6f3c7407e6a39bdd92d81fea5125d166d6dc2508bb20f4a3bc072631374",
	},
	refactorCommit: {
		policy: "same",
		legacyHash: "dc8846c56580b22cef6192ef5dcd534b6be29146438ca432260aee19fe57a4d6",
		hash: "dc8846c56580b22cef6192ef5dcd534b6be29146438ca432260aee19fe57a4d6",
	},
	refactorReplace: {
		policy: "same",
		legacyHash: "a5dbbbffa7d0cbc37a39ac20881bfea75f59d33f8a955a7c3b693ef570f19db5",
		hash: "a5dbbbffa7d0cbc37a39ac20881bfea75f59d33f8a955a7c3b693ef570f19db5",
	},
	refactorReplaceSpan: {
		policy: "same",
		legacyHash: "a7f9ef2c081f6b43d2216b885435cc22d237d81648bd0304ae0e585faa096127",
		hash: "a7f9ef2c081f6b43d2216b885435cc22d237d81648bd0304ae0e585faa096127",
	},
	refactorInsert: {
		policy: "same",
		legacyHash: "d2b5f0b6b95568c971f687b69f79b10edc9455fa01eb2f102980f5166cd0eada",
		hash: "d2b5f0b6b95568c971f687b69f79b10edc9455fa01eb2f102980f5166cd0eada",
	},
	refactorRename: {
		policy: "same",
		legacyHash: "c7abd0549117601d8840b41e1d4ff7c1b1756d4fded1467fa3c860e172b95f03",
		hash: "c7abd0549117601d8840b41e1d4ff7c1b1756d4fded1467fa3c860e172b95f03",
	},
	refactorMove: {
		policy: "same",
		legacyHash: "cc52efa92a325b2c64277c0732b5840d35b66457899c0f5029a8728bcd23646a",
		hash: "cc52efa92a325b2c64277c0732b5840d35b66457899c0f5029a8728bcd23646a",
	},
	refactorArrange: {
		policy: "same",
		legacyHash: "cc52efa92a325b2c64277c0732b5840d35b66457899c0f5029a8728bcd23646a",
		hash: "cc52efa92a325b2c64277c0732b5840d35b66457899c0f5029a8728bcd23646a",
	},
	refactorRenameCommitted: {
		policy: "same",
		legacyHash: "b3ffea1d84a6b7553bb1d40da5dcb9d36bdbacae48cf40bce6d6e00ea5e5c150",
		hash: "b3ffea1d84a6b7553bb1d40da5dcb9d36bdbacae48cf40bce6d6e00ea5e5c150",
	},
	refactorMoveCommitted: {
		policy: "same",
		legacyHash: "b3ffea1d84a6b7553bb1d40da5dcb9d36bdbacae48cf40bce6d6e00ea5e5c150",
		hash: "b3ffea1d84a6b7553bb1d40da5dcb9d36bdbacae48cf40bce6d6e00ea5e5c150",
	},
	refactorStepOutcome: {
		policy: "same",
		legacyHash: "b026084b0ce12606bddc1ecfd178132c070f4c2f3aeea3652b5a92491bb6829c",
		hash: "b026084b0ce12606bddc1ecfd178132c070f4c2f3aeea3652b5a92491bb6829c",
	},
	refactorStepCancel: {
		policy: "same",
		legacyHash: "62167cf8dcde67333f813e39260b4201596a856dff1f15a656c22b3e45bf2bd2",
		hash: "62167cf8dcde67333f813e39260b4201596a856dff1f15a656c22b3e45bf2bd2",
	},
} as const satisfies Record<string, CompatibilityEntry>;
