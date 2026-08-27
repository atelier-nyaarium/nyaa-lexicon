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

- `protocol/src/daemonMethods.ts`: one table, `DAEMON_METHODS`, method name to `{ request,
  response }` zod schemas for all 48 methods, `as const satisfies`, with a doc line per entry;
  `DaemonMethod`, `RequestOf`, `ResponseOf` derived from it. The ~40 response shapes move out of
  core as schemas; core's modules take their types from them (`StoredDeclaration`, `ReferencesResult`,
  `RenamePlan`, `IndexStatus`, `SymbolSource`, the knowledge and transaction outcomes, the
  anonymous `overview`, `findImports`, `cacheStats` and history answers named at last).
- `core/src/dispatch.ts`: the handler map `satisfies { [M in DaemonMethod]: ... }`; requests parsed
  through the table's request schema, answers parsed through its response schema before the frame
  is written. The switch and the table naming different sets fails a test.
- Residue: no zod method schema outside `protocol/src/daemonMethods.ts`; the sweep asserts it found
  files.
- Not a protocol major: the wire's bytes do not change. Response validation is the one risk, a
  shape core emits today that its own schema would refuse; every method gets a test that its
  answer parses.

## Phase 2 - The client package

- `client/` (`@nyaa-lexicon/client`, depends on protocol only, node-only, no sqlite): `connect({
  workspaceRoot, stateDir?, lexiconRoot? })` returning a session with the named facade derived
  from `DAEMON_METHODS`, `ask`, `close`, `resolveChain`, `awaitIndexed`, and typed errors
  (`NotInstalled`, `Incompatible` naming both versions, `DaemonError`); a warming daemon is waited
  on inside `ask`, bounded by the daemon's countdown.
- Moved from core into the client: `findDaemon`, `ensureDaemon`, `daemonCommand`,
  `spawnDaemonProcess`, `bundleStamp`, the lock rules, `workspacePaths`/`stateRoot`,
  `connectFrames`/`requestOnce`. Core's daemon and the MCP adapter consume the client, so there is
  one spawner. The client never retires a daemon it cannot replace with a newer one.
- The install record: `<stateRoot>/install.json` written by the MCP on every start (checkout root,
  build version, when); `connect` reads it when no daemon is up; a stale root fails by name.
- `--state-dir` on the daemon; the path owner takes the root as a parameter; the registry entry
  records a custom directory; `list_project_stores`, `project_diagnostics`, `stop_project_daemon`,
  `delete_project_store` and `bind_project` reach it.
- Tests: connect against a live daemon in a temp state dir, the spawn race with two clients, the
  version refusal, `stateDir` isolation (two daemons over one workspace), `resolveChain` on each
  answer kind against real providers, the facade's typing (a wrong field fails `tsc` in a test
  fixture), the install record's staleness.
- Docs: `docs/architecture.md` (the client as the one spawner), `docs/client.md` (the end-user
  surface), CHANGELOG.

## Phase 3 - Switchboard's refs resolve through lexicon

- Lexicon as a submodule; `lexicon/protocol` and `lexicon/client` in Switchboard's workspaces.
- `refResolver`'s tree-sitter tier replaced by `resolveChain` plus the existing matchers over the
  resolved range; `ambiguous` rendered by Switchboard's own policy; `none` and `NotInstalled` fall
  through to the text tier as today. Coordinates converted from 0-based once, in one place.
- The wasm grammars, `build-grammars.ts` and `grammarSources.ts` deleted; the manifest's
  `agent_instructions` rewritten for what resolution now guarantees.
- Tests: the existing ref end-to-end cases run against a lexicon daemon over the fixture tree.
