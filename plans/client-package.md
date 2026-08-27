# Questionaire

A way for other node projects to use lexicon: Switchboard first, whose `ref://` resolver is a
second, weaker indexer over tree-sitter, and which shares the workspace's daemon with the sessions
already running there. Premises the owner set before the questions: the daemon stays the one
engine and the one writer; a consumer talks to it rather than embedding the indexer; and a
consumer may name its own store location, managing that daemon explicitly.

## Question 1 - Who owns the daemon wire contract?

Q: The protocol package, a new dependency-free package with its own version, or the client
redeclaring what it needs?
A: The protocol package. Request and response schemas for every method in one table keyed by
method name; dispatch validates both directions; core's modules take their types from it; the
client derives its types from the same table; a residue test forbids a method schema anywhere else.

Recommendation reason: `PROTOCOL_VERSION` already governs the daemon's compatibility (the welcome
frame carries it, the lock compares it, a removed method costs a protocol major), so the owner of
the version becomes the owner of the shapes. About forty response shapes move out of core; none
crosses the wire as a class instance. Drift between what the daemon answers and what a client
expects becomes inexpressible.

## Question 2 - Who spawns a daemon, and how does a consumer find lexicon?

Q: The client package owns connect and spawn with lexicon registering where it is installed; the
client only connects; or the consumer passes the root itself?
A: The client package owns connect and spawn, and lexicon's MCP becomes its first consumer, so
there is one spawner. On every start the MCP writes an installation record beside the project
registry (`<stateRoot>/install.json`: checkout root, build version, when); `connect()` reads it to
spawn; a `lexiconRoot` option overrides; a stale record fails as "lexicon is not where it was last
seen". Each environment has its own state root, so the record is per environment.

Rules that came out of the discussion: two consumers on one workspace share one daemon (the lock's
hard-link claim decides any spawn race, as it does for concurrent sessions today); the daemon
binary always comes from the lexicon install named in the record, never from a consumer's bundle;
a client rides a newer daemon within a protocol major and retires an older one; a client a
protocol major AHEAD of the installed lexicon refuses with the versions rather than spawning.

Recommendation reason: one spawner in the package every consumer uses, and the "where is lexicon"
fact written by the one party that knows it, when it knows it.

> "what's that mean if there's Lexicon MCP and Switchboard MCP running at the same time?"

## Question 3 - What shape is the client's API?

Q: One generic `ask` typed by the table, one hand-written function per method, or raw frames?
A: Named methods derived from the table: `lexicon.searchSymbols({ text, within })` for every
method, built by one loop over the table's keys and typed by a mapped type over it, so nothing is
hand-written and the next daemon method costs one schema entry. `ask(method, params)` stays
underneath for callers that choose methods dynamically. Helpers (`resolveChain`, `awaitIndexed`)
are the only hand-written members, each justified by a consumer that would otherwise copy the
composition. Errors are typed: `NotInstalled`, `Incompatible` naming both versions, a warming
daemon waited on inside, `DaemonError` carrying the daemon's message.

Recommendation reason: a real library reads as named calls with autocomplete and a doc line per
method; hand-writing them was what made that shape drift-prone, and derivation removes it.

> "what feels cleaner like it was a real library for end users?"

## Question 4 - How does `stateDir` work?

Q: A `connect` option with a daemon flag and the registry knowing, the environment variable only,
or the option with such a store invisible to the management tools?
A: The option, the flag, and the registry knows. The path owner takes the state root as a
parameter instead of reading the environment; the daemon is spawned with `--state-dir`; a project
registered under a custom directory records it in its registry entry, so `list_project_stores`,
`project_diagnostics`, `stop_project_daemon` and `delete_project_store` reach that store like any
other, and lexicon's own MCP can bind to a store a consumer manages. Isolation is the lock's
location: a different directory is a different lock.

Recommendation reason: one path owner with one parameter, and the registry is already the place
that knows which stores exist.

## Question 5 - What does a ref ask of the client, and what does ambiguity answer?

Q: When several declarations satisfy a chain: candidates only, the first in document order with a
count, or the shallowest first?
A: Exact or ambiguous, never guessed. `resolveChain(module, segments)` answers `exact` with the
declaration's id, kind, name, range, selection range and container path; `ambiguous` with every
candidate and no range chosen; `none` with a reason (module not indexed, no match). Segments match
any descendant of the previous; `arguments` names a parameter list, a following segment a
parameter; a dotted or `::` segment may match a run of names. Coordinates are the protocol's,
0-based; the consumer converts. `awaitIndexed(module)` rides along for a file newer than its index.
The degrade policy ("never fail the send") stays in Switchboard, which can rank the candidates as
it does today in one line.

Recommendation reason: a helper that picks lies to its next consumer; a list is honest for every
consumer and loses Switchboard nothing.

## Question 6 - How does Switchboard depend on the client?

Q: Publish to npm, a bundled artifact taken as a git dependency, or a runtime load from the
installed plugin?
A: A git submodule of this repository inside Switchboard, importing the two packages' sources
through Switchboard's own bun workspace. Conditions that make it work: Switchboard's root
`workspaces` lists `lexicon/protocol` and `lexicon/client` and nothing else from the submodule, so
`@nyaa-lexicon/client` resolves by name and its `workspace:*` dependency on protocol resolves
too; Switchboard's tsconfig references the two projects and its biome ignores the submodule; the
client stays bundle-safe (no `bun:` imports, nothing node cannot strip matters because
Switchboard bundles). The daemon still comes from the installed lexicon plugin through the install
record, never from the submodule, and the "client a protocol major ahead of the install refuses"
rule covers a submodule that is newer than the plugin. Publishing can come later without changing
any code.

> "I will include it as a Git submodule. It can import the src directly."

# Plan

Three phases, each committable alone, in dependency order. The first two are lexicon releases;
the third is Switchboard's.

## Phase 1 - The protocol package owns the daemon wire

Audited (lap 1, five angles: shapes, runtime validation, dispatch and residue, protocol
boundaries, tests). What follows is the plan as rethought.

### The table

- `protocol/src/daemonMethods.ts`: `DAEMON_METHODS`, method name to `{ request, response }` zod
  schemas, mirroring `METHOD_SCHEMAS`'s shape for providers but a separate table, since the two
  wires have different owners. One entry per `case` label in today's dispatch, `hubs` included as
  its own entry aliasing `mostReferenced`'s schemas, so the wire's accepted method set is unchanged.
  `as const satisfies Record<string, { request: ZodType; response: ZodType }>`, a JSDoc line on
  each entry (it survives the homomorphic mapped types the facade and the handler map use;
  `.describe()` does not reach editor hover and the package uses none). `DaemonMethod`,
  `RequestOf<M>`, `ResponseOf<M>` derived from it.
- Request schemas: the ones in `core/src/dispatch.ts` today, moved (many are shared: `BySymbol`,
  `ByModule`, `References`, `Paged`); the six no-parameter methods get an empty object schema.
- Response schemas, about 43, one per distinct shape. The wire schema OWNS each shape and core's
  modules derive their types from it: a store row that crosses the wire (`StoredDeclaration`,
  `StoredReference`, `StoredLiteral`, `StoredImport`, `StoredFact`) keeps its name and becomes
  `z.infer` of its schema, with `rowToX` building to it, so the store cannot drift from the wire.
  The knowledge shapes (`Answer`, `Doubt`, `RecordOutcome`, `RecalledAnswer`, `InvalidateOutcome`,
  `KnowledgeGaps`, `FactSet`), the planner and transaction shapes (`RenamePlan`, `RenameEditPlan`,
  `MovePlan`, `TransactionStatus`, `RefactorIssue`) and dispatch's four outcomes move the same way.
  Every anonymous answer is named: `SearchSymbolsResult`, `FindImportsResult`, `OverviewResult`,
  `CoChangedWithResult`, `CommitsMentioningResult`, `ResolveFactsResult`, `SharedLiteralsResult`,
  `MostReferencedResult`, and the five transaction results (`Start`, `Track`, `Undo`, `Revert`,
  `Commit`). `ImportResolution` and `TypeInfo` are protocol types already and are reused.
- Unknown keys: plain `z.object` everywhere, which strips. On the daemon that is the contract
  enforced: nothing leaves that the table does not name. On a client it means an older client
  drops fields a newer daemon added, which it could not have typed anyway. No `strict`, no
  `passthrough`: one rule.
- Export surface: the table, the three derived types, and the nested shape schemas and types core
  builds with (the rows, `SymbolSummary`, `Answer`, the plans). Per-method response schemas are
  reached through the table, and core aliases a response type locally where readability wants
  (`type ReferencesResult = ResponseOf<"findReferences">`). The barrel stays curated.
- `PROTOCOL_VERSION` stays `2.0.0`: the bytes on the wire do not change, and `decideFromLock`
  rides forward on a minor anyway. Conformance is untouched; it reads the provider table only.

### Dispatch

- `createDispatch` builds a handler map inside itself, capturing `write`, `read`, `transactions`
  and `treeFirst` as the switch does now, `satisfies { [M in DaemonMethod]: (params:
  RequestOf<M>) => Promise<ResponseOf<M>> | ResponseOf<M> }`. The dispatcher looks the method up,
  keeps the exact `unknown method: <m> (this daemon runs <build>)` error a stale client relies on,
  parses params through `DAEMON_METHODS[method].request`, and parses the answer through
  `.response` before returning it to the frame writer. A failed answer parse throws, which the
  transport already turns into an error frame. Always on, both directions, as requests are today.
- `DaemonChannel.ask` becomes `ask<M extends DaemonMethod>(method: M, params: RequestOf<M>):
  Promise<ResponseOf<M>>`, so the MCP adapter's and the LSP's calls are typed by the table with no
  change to their runtime, and the LSP's explicit generic on `refactorStatus` goes.

### Proofs

- Equality: `Object.keys(DAEMON_METHODS)` equals `Object.keys(handlers)`, both ways, enumerated at
  runtime; the MCP residue that parses dispatch's `case` labels from source is rewritten to the
  same enumeration.
- Residue, two tokens, each checked against every instance on disk first: `core/src/dispatch.ts`
  constructs no schema (no `z.` call in that file); `.parse(params)` appears in `core/src` exactly
  once, the generic entry, and the sweep asserts it found that one.
- Parse every answer: `core/src/__tests__/daemonAnswers.test.ts`, one fixture workspace (code
  through the reference provider, a markdown file, a data file, `git init` with one commit, failing
  loudly if git cannot run), a real store, `createDispatch` with a `TransactionManager` and a
  `WorkspaceGate`. A samples table keyed by method whose key set must equal the table's, so a
  method without a sample fails; each sample's answer must satisfy `parse(answer)` deep-equal to
  `answer`, which is what catches a field core emits that the schema forgot. Knowledge runs in
  order (`factsFor`, `recordAnswer`, `invalidateAnswer`, `recallAnswer`, `reaffirmAnswer`,
  `resolveFacts`) and refactor in order (`refactorStart`, `refactorTrack`, `refactorReplace`,
  `refactorUndo`, `refactorRevert`, `refactorCommit`) with at least one successful step, since
  their answers depend on earlier ones. The history answers accept the empty non-git shape.
- Three adapter tests move their type imports from core to protocol; no field changes anywhere.

### Docs

- `docs/daemon-protocol.md`, new: the local socket, the frames, the method table, compatibility
  (ride forward within a major, retire an older build), response validation. The provider document
  stays about providers. One sentence in `docs/architecture.md`: the protocol package owns the
  daemon methods' shapes, core remains the sole socket implementation and validates both sides.
- CHANGELOG: one paragraph; nothing an agent sees changes unless an answer was malformed, in which
  case the daemon now says so instead of shipping it.

## Phase 2 - The client package

Audited (lap 2, five angles: the move out of core, the install record and spawn semantics, the
state directory, the facade and helpers and errors, tests and build and docs). The plan as
rethought.

### Package and boundaries

- `client/` (`@nyaa-lexicon/client`), depending on `@nyaa-lexicon/protocol` only, node built-ins
  otherwise, no `node:sqlite`, no `bun:` import, nothing node cannot run. The dependency direction
  becomes `protocol <- client <- core <- adapters`: core's daemon and the MCP adapter consume the
  client, so there is one spawner and one client transport, and core keeps the daemon side.
- Moved out of core, split so the cycle between `client.ts` and `ensureDaemon.ts` cannot survive
  the move: `lock.ts` (the lock rules, pure), `paths.ts` (`stateRoot`, `workspaceKey`,
  `storePaths`, `workspacePaths`, the one path owner, now taking the state root as a parameter),
  `transport.ts` (`connectFrames`, `requestOnce`, the starting/retry loop, `ConnectionLostError`),
  `discover.ts` (`findDaemon`, `bundleStamp(root)`, `daemonCommand(root, workspaceRoot)`,
  `spawnDaemonProcess`, `retire`), `ensure.ts` (`ensureDaemon` over those primitives) and
  `channel.ts` (one lazy socket, one reconnect on loss, `close`). Nothing in the client walks up
  from its own file: every root is an argument.
- The lock schema and the install record schema move to protocol beside `daemonWire.ts`: both are
  contracts the daemon writes and a client reads. So "protocol only" is literally true, and the
  daemon's claim in core builds the lock to the protocol's shape.
- core's own readers of the path owner (`daemonCli`, `daemon.ts`, `diagnostics`,
  `projectRegistry`, `projectStores`, `workspaceAdmission`, `drift`) import it from the client;
  `serveFrames` and the lock claim stay in core as the daemon side of the socket.
- Wiring: `client` in the root workspaces and `tsconfig.json` references; the MCP and LSP adapters
  depend on it directly; biome sweeps it as it sweeps everything; no `dist/client.js`, since the
  three shipped bundles inline the workspace link and Phase 3 imports sources through a submodule;
  the release build's version SET reaches `client/package.json` through the workspace list.

### Discovery and spawn

- The install describes itself: the build writes `dist/version.json` (`buildVersion`,
  `protocolVersion`) beside the bundles, so a client learns what a checkout is without running it.
- The install record only points: `<stateRoot>/install.json` is `{ root, when }`, written atomically
  (staging file then rename, as the registry does) by the MCP at process start, before any
  registration, and by the daemon at start, since a daemon runs without an MCP. Each environment's
  state root has its own record.
- `connect({ workspaceRoot, stateDir?, lexiconRoot?, patience? })`: an explicit `lexiconRoot`
  wins; otherwise the record's root; a root whose `dist/daemon.js` or `dist/version.json` is
  missing fails as `NotInstalled` naming the root ("lexicon is not where it was last seen"); no
  record at all fails as `NotInstalled` ("no lexicon is installed here").
- Versions, three of them, kept apart: the client's own `PROTOCOL_VERSION` (from the protocol
  package it bundles), the install's (`dist/version.json`), the running daemon's (the lock). The
  refusal comes first: a client whose protocol major is ahead of the install's fails as
  `Incompatible` naming both, before any lock is read. Then `decideFromLock` runs with "ours" being
  the INSTALL's build version and the stamp of the install's `dist/daemon.js`, never the consumer's
  package: ride a newer daemon within the major, retire an older one and spawn the install's.
- Retire is graceful first: the `shutdown` method over the socket after `refactorStatus` says no
  transaction is open, then the lock-vanish wait, then `SIGTERM` as today's fallback.
- `connectFrames` checks the welcome frame's protocol version against the client's, so a direct
  connection cannot bypass the lock's rule.
- Handover stays the daemon's: it notices a newer bundle between requests and spawns its successor
  with `--warm` (and `--state-dir` when it has one). A foreign client and a handover cannot produce
  two daemons over one store, because the lock is claimed by a hard link before any store opens;
  the one wrong turn a client can take is spawning from a root that is not the install, which the
  record and the version file close.

### The state directory

- `--state-dir <dir>` on the daemon, parsed explicitly (the argv filter today only knows `--warm`);
  `workspacePaths(host, workspaceRoot, stateDir?)` is the one place it is applied; `startDaemon`
  gets it in its options and `lostLock` rereads the lock it claimed; the handover passes it on.
- A store's identity is its directory. The registry entry becomes `{ key, root, stateDir? }`,
  unique by (key, stateDir), so one workspace may have a default store and a custom one; `register_project` takes the directory; `list_projects` shows it; a `SessionProject`
  carries it; `bind_project` opens `daemonChannel({ workspaceRoot, stateDir })`, so lexicon's MCP
  reaches a store a consumer manages.
- `list_project_stores` enumerates the default root's children and the registry's custom
  directories, deduplicated, each with its directory; `project_diagnostics`, `stop_project_daemon`
  and `delete_project_store` take the directory the listing showed, validated against that listing
  before any filesystem operation, never a path joined from input.
- A custom directory is created `0700`, must be owned by the user and not group- or world-writable,
  and a symlinked one is refused; the daemon never widens permissions. `reports/` keeps its own
  hardening.

### Session, facade, helpers, errors

- A session is one lazy socket per `connect()`, reconnecting once on loss, closed by `close()`.
  `stopDaemon()` sends the daemon's `shutdown` frame and waits for its lock to vanish, for a
  consumer that manages a daemon of its own and for tests; the MCP's `stop_project_daemon` uses it.
- The facade is a built object cast to the mapped type `{ [M in DaemonMethod]: (params:
  RequestOf<M>) => Promise<ResponseOf<M>> }`, so JSDoc from the table survives hover; `ask` sits
  underneath; a wrong field or an unknown method fails to compile.
- Errors: `NotInstalled` (no record, or a root that no longer holds an install), `Incompatible`
  (both versions named), `DaemonError` (the daemon's own message, `unknown method` included, with
  `waitingFor` when the wait ran out), a connection lost twice as a `DaemonError` too. Ambiguity is
  never an error: `resolveChain` catches the daemon's "is ambiguous" refusal and answers with the
  candidates.
- The starting wait: a warming daemon answers "retry me" with its countdown; the client polls at
  250 ms and gives up at the earlier of `patience` (default five minutes, as the MCP has today) and
  the daemon's countdown, as a `DaemonError` naming what it waited on.
- `resolveChain(module, segments)`: `declarationsIn(module)`, then a walk over `containerId`
  where each segment matches any descendant of the previous; a dotted or `::` segment matches
  either a declaration whose name holds the dots or a run of nested names; an occurrence `[2]` is a
  distinct candidate; `arguments` names the span from the first parameter to the last, and a
  segment after it a parameter declaration (providers emit them with `(x)` descriptors). Answers:
  `exact` (id, kind, name, range, selection range, container path), `ambiguous` (every candidate,
  no range chosen), `none` with a closed reason: `unclaimed` (no provider owns the file),
  `unread` (owned, not yet indexed: `awaitIndexed` helps), `missing` (the file is gone), `noMatch`.
- `awaitIndexed(module)`: `indexFile` on the wire, under the daemon's write gate; `indexed` and
  "already indexed" succeed, `unclaimed` and `forgotten` become the matching `none`, a parse
  failure is a `DaemonError` carrying the provider's reason.

### Proofs

- Live daemon tests start the daemon in-process (`startDaemon` over a temp state dir, as the MCP
  end-to-end test does) with real providers: connect, the facade, `resolveChain` on each answer
  kind (a class with a method with a parameter, a C# namespace with dots from the conformance
  corpus, a repeated name), `awaitIndexed`, `stateDir` isolation (two in-process daemons over one
  workspace, two state dirs), the version refusal, the stale record, the welcome check.
- The spawn race: two `startDaemon` calls concurrently over one state dir; exactly one holds the
  lock and the other returns before any store exists, observable in-process and deterministic.
- The facade's typing: a `// @ts-expect-error` fixture inside the client's own `tsc --build`
  project, so the lint gate proves the wrong field is an error.
- Residues: `node:net` is imported by the client's transport and core's server transport only,
  swept over client, core and adapters; the index-writer residue sweeps `client/` (it must never
  write index state); the language residue does not (the client is language-blind by
  construction); the id-grammar residue sweeps `client/`.
- The MCP and LSP end-to-end tests keep passing through the client package.

### Docs

- `docs/architecture.md`: the client package is the one spawner and the client half of the
  socket; core is the daemon half and the sole writer; the hard-link claim before the store opens
  is unchanged.
- `docs/client.md`, new: `connect` and its options, the facade and `ask`, `resolveChain` and
  `awaitIndexed`, the errors, the warming wait, `stateDir` and what the management tools show,
  the install record and the version file, the three versions and the refusal.
- CHANGELOG: one paragraph, in the file's voice; the MCP and the daemon behave as before, and
  another project can now depend on the client.

## Phase 3 - Switchboard's refs resolve through lexicon

Audited (lap 3, four angles: submodule wiring, the resolver swap, deleting tree-sitter, tests with
a daemon). In the switchboard repository. The plan as rethought.

### Wiring

- Switchboard has no `workspaces` today, no project references, a hoisted `node_modules`, no
  `.gitmodules`, and a CI that fetches no submodules and pins no node. So: `lexicon/` as a
  submodule at the root; root `package.json` gains `workspaces: ["lexicon/protocol",
  "lexicon/client"]` and nothing else from the submodule; `bun install` lands their pins in
  `bun.lock` (`zod` is already 4.4.3 on both sides; `vscode-jsonrpc` 9.0.1 is new); the frozen
  lockfile is regenerated once.
- TypeScript: Switchboard is one program with `strict`, `exactOptionalPropertyTypes`,
  `moduleResolution: bundler` and `verbatimModuleSyntax`, the same four lexicon's base sets, so the
  two packages compile as imported sources through the workspace links; no project references
  needed. Biome gains `!**/lexicon`. Its residue and sweep scripts already stop at `src/`,
  `android/` and `node_modules/`, so none reaches the submodule.
- CI: `actions/checkout` with `submodules: true`, `actions/setup-node` pinned to node 24 (the
  daemon needs 22.5+ for `node:sqlite`; vitest runs on node either way), `bun install
  --frozen-lockfile` against the regenerated lock.

### The resolver swap

- One coordinate helper replaces `lineOf`, `columnOf` and the tree-sitter offsets: a protocol
  `Range` (0-based, half-open) becomes Switchboard's `Resolution` (1-based inclusive lines,
  0-based columns, as its wire schema already allows) and, for the matchers, becomes offsets into
  the text `loadRefFile` already holds. `applyMatcher` is unchanged and runs over the resolved
  range's offsets.
- Field mapping: `exact` gives quality `exact`, lines from `range`, `span` from `selectionRange`,
  `matchCount` 1. `ambiguous` gives Switchboard's pick, fewest container-path entries then document
  order, with `ambiguous: true` and the count, from a list it can see. `none` takes the text tier
  (`fuzzyLineMatch`, else `wholeFile`) with the reason worded from the daemon's closed reason
  (`unclaimed`, `unread`, `missing`, `noMatch`). `unread` first asks `awaitIndexed(module)` once
  and resolves again; no other reason does.
- Errors degrade too, since the file tier is Switchboard's only hard failure: `NotInstalled`,
  `Incompatible` and a `DaemonError`, a warming daemon included, take the text tier with a banner
  naming the cause ("lexicon is not installed; matched by text", "index warming; matched by
  text", "lexicon 2.x installed, this client needs 3; matched by text").
- The session is module state in `attachRefs.ts` beside `enabled`: connected lazily on the first
  in-workspace ref with `connect({ workspaceRoot, patience: 10_000 })`, closed from the MCP's
  shutdown path in `src/mcp/index.ts`. `referenceRoot()` becomes the workspace root the MCP was
  started for. A bare path resolves as a workspace module; an absolute or `~/` path outside the
  workspace never reaches the daemon and takes the text tier, while `loadRefFile` still snapshots
  it as today.
- Grammar forms against the contract: `:arguments` and `:arguments:qty` map to the parameter
  span and the parameter declaration; `Acme.Services` and `Acme:Services` both match through the
  chain walk; `A::B::m` collapses as it does now. The ref grammar has no occurrence selector, so a
  repeated name is answered as ambiguous and picked by the policy; adding `[2]` to the grammar is
  not in this phase.
- The file tier is untouched: missing, not text, too large. The manifest's "a secret" refusal
  never existed in code; the rewrite stops claiming it.

### Deleting tree-sitter

- Gone: `grammarSources.ts`, `scripts/build-grammars.ts`, `grammars/` (seven wasm, 12.9 MB, and
  its manifest), `web-tree-sitter` and the seven `tree-sitter-*` dev dependencies with their lock
  records, the build's copy of `web-tree-sitter.wasm` beside the bundle, `dist/web-tree-sitter.wasm`,
  and `grammars.test.ts`. `dist/main-mcp.js` is rebuilt and committed without the runtime.
- Coverage does not shrink: every language the grammar table named (TypeScript, TSX,
  JavaScript, C++, C#, Python, GDScript) has a lexicon provider, and C, Rust, Kotlin, XML, HTML,
  markdown, JSON, YAML and plain text are new. What no provider claims takes the text tier, as it
  did with no grammar.
- Stays: the lexer, the grammar and canonical key, the scanner, `refFile.ts`, the artifact builder,
  the viewer, and their tests.
- Teaching: the manifest's `agent_instructions` say what resolution now guarantees, in its
  current tone and length: exact when the index holds one declaration; ambiguous with a count and a
  banner when it holds several, so qualify the chain; text match with a banner when no provider
  claims the file or the index is not ready; `arguments` as before; paths outside the workspace by
  text. `skills/crosstalk/SKILL.md`'s ref lines say the same in short, and `CLAUDE.md`'s ref section
  loses the committed-wasm bullets and restates "the file tier fails loudly, resolution degrades"
  with the new three-way answer. The sandbox fixture's expectations (`SandboxFixtures.kt`,
  `switchboard-references.json`) move to the new vocabulary.

### Tests

- One fixture suite over `tests/fixtures/ref-project` (TypeScript, TSX, JavaScript, C++, C#,
  Python, GDScript, a PNG): a daemon spawned through the client from the submodule's committed
  `dist/` (`connect({ workspaceRoot: fixtureRoot, lexiconRoot: submodulePath, stateDir: tmp })`)
  in `beforeAll`, stopped in `afterAll` through the client's `stopDaemon()`, so it tests what ships
  and touches no real store. Assertions: the exact cases of today's grammar suite with explicit
  ranges from the index; the ambiguous case with the candidate count; a renamed chain falling to
  text with its reason; the PNG refused by the file tier; an absolute path outside the workspace
  taking the text tier; the warming banner with a `patience` of zero.
- The lexer, grammar, scanner, artifact and file tests stay as they are.
- The MCP bundle builds without the runtime and its size is recorded in the commit.
