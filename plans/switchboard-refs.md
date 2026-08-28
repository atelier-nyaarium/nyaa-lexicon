# Questionaire

Switchboard's `ref://` feature rebuilt on lexicon, as a clean break. Supersedes Phase 3 of
`plans/client-package.md`, which was written to swap the resolver in place; the owner's mandate is
to analyze both sides, keep only what earns its place, and take no compatibility shims.

Premises the owner set: the daemon stays the one engine (Q2 of the client plan); Switchboard takes
lexicon as a git submodule and imports the client's sources (Q6); the console is the owner's own app
and may change, at the cost of an APK release, so a wire change has to earn that cost.

What the analysis established before the first question, verified in code:

- The syntax boundary is sound and stays: the lexer, the grammar and canonical key (a cross-runtime
  contract held to the Kotlin twin by `tests/fixtures/refs/vectors.json`), the scanner over the
  console's own markdown parser, the file tier's decoding and limits, the artifact builder's
  snapshot-equals-segments invariant, and the name helpers.
- The semantic boundary is tree-sitter's and goes: `refResolver.ts`'s scope walk, `searchAreas`,
  the shallowest-first pick, the grammar table and the 12.9 MB of committed wasm. Matchers survive
  as a search over a resolved range's text.
- Defect classes to make inexpressible rather than fix: an ambiguous pick that reports itself
  `exact`; an open `quality` string the viewer renders as exact when unknown; snapshots keyed by
  the written path so aliases ship twice; two coordinate systems mixed in one module; a workspace
  root guessed from cwd; a manifest promising a "secret" refusal no code implements.
- Nothing on the daemon wire binds an answer to the content hash the index holds, so index
  coordinates cannot yet be called exact against bytes Switchboard read itself: a lexicon addition
  comes first. Measured: 3 ms after a write, `resolveChain` still answered `exact` at the old line
  and `moduleStatus` was byte-identical before and after (it never hashes); the watcher healed it at
  74 ms; a file under an ignored directory (`dist/`, `node_modules/`) never heals. `awaitIndexed`
  always re-parses over the wire (the dispatch passes no `skipIfCurrent`), 6 ms on a small file.
- Cost, measured on a 990-file copy of Switchboard: `connect()` 105 ms; first answered call 5.7 s
  from an empty store (outline warm, 966 files, 37752 declarations) and 373 ms on a warm restart;
  full facts 20 s in the background; `resolveChain` 5-10 ms; store 118 MB. A chain resolved exact
  at outline depth, so a ref never waits for full facts.
- The daemon reads any module string it is given: `../outside.txt` and `conf/../README.md` are
  joined onto the root with no normalization or containment, and each spelling is a distinct,
  permanently `unread` key. Containment belongs at the query boundary.
- Markdown headings are declarations (`ref://README.md:Install` resolves, the section as range and
  the heading as selection); the text provider claims `.conf` and `.txt` and declares nothing, so a
  chain on them answers `noMatch` and a `#matcher` is the honest form.
- Two shapes the manifest teaches as headline examples answer `noMatch` in lexicon today: the C++
  out-of-line definition `Physics::World::step` (the C++ provider mints one declaration named
  `step` with no qualifier containers) and the split C# namespace spelling
  `Acme:Services:Service:Compute` (the declaration is named `Acme.Services`; the dotted spelling
  resolves). C# `arguments` answers `noMatch` too (parameters minted as `term`). GDScript
  `class_name`, TSX members, JavaScript anonymous nesting and the TypeScript chain resolve.
- The wire (`RefKeyMeta`) can carry everything lexicon adds without a field change: `span` from the
  declaration's `selectionRange` lights the viewer's existing amber name highlight; the emulator
  asset `switchboard-references.json` is dead (nothing reads it).
- `[n]` is plain segment text to the canonical key on both runtimes, so an ordinal costs no Kotlin
  change. A `#matcher` needs no chain, so an author always has an honest fallback that does not
  depend on the index.
- The daemon spawn uses `process.execPath`, which is bun under `bun run`; the daemon needs node.

## Question 1 - What stops a send?

Q: Which resolution outcomes refuse the send and which degrade with a banner: refuse what the
author can fix now, refuse ambiguity only, or never refuse as today?
A: Refuse what the author can fix now. `ambiguous` fails the send and the error lists every
candidate as a paste-ready exact ref (full container path, `[n]` on the ambiguous segment).
`noMatch`, and a chain on a file no symbol provider declares anything for, fail naming the module's
declarations and the `#text` form, which needs no chain. Only infrastructure absence degrades (not
installed, index warming past the budget, daemon error, version mismatch): text tier, banner, and
one line per ref in the tool result. A chain is a claim about the index and a matcher a claim
about the text; each is exact or refused.

Recommendation reason: a chip is an assertion. Every refusal comes with a one-paste fix, and a
provider blind spot surfaces in the session where it gets fixed instead of shipping to the phone as
a plausible wrong target. Today's doctrine was written for a resolver whose misses were its own.

## Question 2 - When does Switchboard's MCP reach for the daemon?

Q: Lazily on the first ref with a budget per reply, prewarmed at MCP start when lexicon is
installed, or lazily with the client's full patience?
A: Lazily, on the first ref, and the reply waits for the index rather than timing out to the text
tier: the budget is generous (the client's patience, not a short cap), so "index warming" is a
degrade only when the daemon itself gives up. A session that never writes a ref never spawns a
daemon. Measured: a cold index answers its first ref in 5.7 s on a 990-file workspace, 0.4 s on a
warm restart, and the daemon lingers 30 minutes after its last client.

> "Since it's session MCP side, we can be generous with waiting for it to resolve. no need to be
> impatient and time it out."

Routine calls made without a question: the workspace root is the git toplevel of the MCP's cwd,
else cwd, with `REFERENCE_ROOT` kept for tests; paths are realpath'd and classified once (inside
the root is a module, outside is file tier only, and a chain on an outside path refuses and names
`#text`); every ref with a chain asks the one hash-bound method, and `awaitIndexed` runs only when
the hashes say the index is behind.

## Question 3 - In what order do the two repositories ship?

Q: Lexicon 3.0 first with every fix, a lexicon minor first and the provider majors later, or
Switchboard first against 2.2?
A: Lexicon 3.0 first, one major carrying the hash-bound answers, containment, the prefix match,
the C# parameter descriptors, the C++ qualifier, the spawn fix and the closed reasons, plus the
unreleased Phases 1 and 2 of the client plan; stored facts retire once. Then Switchboard against
the 3.0 pin, with every manifest example resolving exact from day one. The major is lexicon's own
rule: two of the fixes change what a provider emits for unchanged source, and the store's
compatibility key is the major.

> "ok major it"

Recommendation reason: the C++ example is the manifest's headline; a feature whose headline
refuses teaches agents to avoid it, and a major that retires stored facts should happen once.

# Plan

Two releases, in order: lexicon 3.0 first (Phases 0 and 1, one major), then Switchboard against
that pin.

## Phase 0 - Lexicon runs on bun ✅

Shipped as 90ad711 and c94a5ee, released with Phase 1 as 3.0.0 through 3.0.2. The two-host
smoke passed on 3.0.2 (Claude Code through its update path, Copilot through its install path,
both spawning and sharing one daemon under bun); the transcripts are on the GitHub Release
v3.0.2.

Audited (lap 3, six angles on Sol with Opus fallback: entry points and spawn, the store, `bun
test`, diagnostics, build and release and the smoke, principles). The plan as rethought.

Decided on the owner's word ("Our only users are up to date on bun. Make the decision. If it's
maintenance hell, we cut dist support and point the MCP json to bun"). What was hell is the
dev-on-bun, ship-on-node split; the audit found its premise already false: bun 1.4 ships
`node:sqlite` (verified: `DatabaseSync`, `StatementSync`, `Session`, `backup`; WAL, blob round
trips, `readOnly`, `undefined` on no row and null-prototype rows all identical to node), and the
committed `--target node` bundle runs under bun unmodified (`bun dist/daemon.js` starts). So the
store is untouched and the bundle stays as built; what gets cut is node as the runtime lexicon
runs, tests and ships on. The bundle stays because the plugin hosts differ at install (Claude Code
runs `bun install` in every installed plugin, verified in `~/.claude/plugins/cache`; Copilot
copies the repository and runs nothing, verified by installing `switchboard@atelier-nyaarium`
through its CLI), and a Copilot-only work machine gets lexicon through the same marketplace as a
plain copy, where a source-run lexicon would die at its first import. Rides the same 3.0 major as
Phase 1.

- **Entry points.** `.mcp.json` runs `bun ${CLAUDE_PLUGIN_ROOT}/dist/main.js`. The host looks
  `bun` up on PATH before any lexicon code runs, so `adapters/mcp/src/main.ts` and
  `adapters/lsp/src/main.ts` assert their own runtime and floor on their first line and exit with
  a named message (each is a bootstrap that judges the runtime, then imports `serve.ts`; the
  bundle hoists builtin imports above it, so the sentence is guaranteed on any node that has
  `node:sqlite`, the oldest node lexicon 2 ran on); the build refuses to bundle an entry point
  whose source does not call `refuseRuntime(`, the conformance CLI excepted, since the build is
  where the set of entry points is known; bun on PATH is the documented prerequisite.
  The editor command becomes
  `bun <install>/dist/lsp.js`, a breaking change the CHANGELOG lists, since no manifest owns it
  today. The client spawns `bun <root>/dist/daemon.js`; the daemon spawns bundled providers
  through the same executable (today `core/src/providers.ts` spawns `process.execPath`, labels
  bundled providers `runtime: "node"`, and injects node-only report arguments; the label and the
  arguments go). `dist/version.json`, the install record and `lexiconRoot()` are unchanged.
  `bundleStamp` widens from `dist/daemon.js` alone to every bundle under `dist/`, since a
  provider-only dogfood rebuild is invisible today, and becomes a digest of the bundles' BYTES
  rather than their mtimes: two hosts install one release as two copies with two sets of mtimes,
  and equal-version daemons with different stamps retire each other on every connect (verified by
  probe). Copilot updates a plugin IN PLACE (same path, new bytes), the case the stamp exists to
  detect, and `decideFromLock` retires an equal-version daemon on a stamp change (verified); the
  daemon's own drift check settles on the newest of every bundle, not the daemon's alone, and
  both read the one inventory, `bundleFiles(root)` in the client, so identity and settling cannot
  disagree about what a bundle is. One install record per state root, shared by every host on
  a machine, last writer wins between the MCP and the daemon: pre-existing, recorded by the smoke,
  not redesigned here.
- **One runtime owner.** The client owns one bun executable, shared by the client spawn, the
  daemon's handover and the provider spawn; the spec (`bunExecutable(host)`, `PlatformEnv` gaining
  `execPath` and `bunVersion`, the closed `noBunRuntime` outcome) lives in Phase 1. Phase 0 lands
  the owner module, `client/src/runtime.ts`, with the verdict and the refusal sentence the entry
  points print; Phase 1 adds the executable to that same module, so the spawn sites that say
  `process.execPath` until then are the sites it takes over. The floor is
  MEASURED before it is written: the full gate plus the store, the watcher, the localhost TCP
  transport, a detached daemon, a handover and the provider smoke run on the candidate floor and
  on the latest bun, pinned as a CI matrix; `node:sqlite` availability in bun bounds it from
  below.
- **Store.** No change. A `bun:sqlite` swap was refused on evidence: it answers `null` where
  `node:sqlite` answers `undefined`, which silently inverts `transactions.ts : imageFor`
  (`refactorRevert` would restore nothing), `store.ts : fileNotes` and `tableExists`, and it
  throws on the `readOnly` option `projectStores.ts` passes, which that function's own `catch`
  would swallow. No `bun:` import in production source (tests import `bun:test`): `client/` and
  `protocol/` must stay node-neutral (Switchboard's vitest imports them under node), and a
  residue in `protocol/` forbids a quoted `bun:` specifier across protocol, client, core, formats
  and the adapters (none existed before; planted and seen to fire). Bun's own APIs are reached
  through `globalThis.Bun`.
- **Tests.** vitest goes; the script becomes `bun test --parallel --timeout 30000
  --path-ignore-patterns '**/temp/**' --path-ignore-patterns '**/dist/**'` (verified: without
  the patterns `bun test` collects `temp/` and `dist/`, so the blind corpora would run as our
  suite; `--parallel` implies `--isolate`, which restores vitest's per-file process for the 61
  files that `mkdtemp`, 16 that spawn daemons or providers and 3 that mutate `XDG_STATE_HOME`).
  Surface: 163 files import from `vitest` (one a helper); `vi.fn` becomes `mock`;
  `vi.setSystemTime` (in `store.test.ts` alone) becomes `bun:test`'s top-level `setSystemTime`,
  since bun's `vi` lacks it; the one `advanceTimersByTimeAsync` site (`warmupIndex.test.ts`
  bounding `ensureTreeForModule`) is answered by `LexiconService` gaining a `clock?` option for
  its one raw `setTimeout` and `service.ts` joining `ROUTED` in `clock-residue.test.ts`, the gate
  that keeps it there. Matchers, `it.each`, `skipIf`, the residue sweeps (anchored on
  `import.meta.dirname`) and the conformance CLI are unchanged; the `whenBuilt` gates stay.
- **Diagnostics.** Verified on bun 1.4: it accepts node's report flags and ignores them, and the
  high-water signal (`SIGUSR2`) KILLS the target, so today's collector would kill every provider;
  `process.report` exists but reports a zero heap; `bun:jsc` exports `heapStats` and the
  snapshot is `Bun.generateHeapSnapshot`. So: the flag and signal path is deleted and provider
  high-water collection is dropped and said to be dropped; memory comes from
  `process.memoryUsage()`, and the high-water mark is the daemon's resident size against the
  host's memory from procfs, because bun states no heap limit (`v8.getHeapStatistics()` answers a
  figure the heap grows straight past, measured) and the OS is what kills; `LEXICON_HEAP_SNAPSHOT=1`
  writes `Bun.generateHeapSnapshot("v8")`, which answers a string, atomically under the existing
  `Heap.*` name; the schema gains `runtime` and loses the heap limit, with `signal` and
  `nodeHeapLimit` legacy-only behind one normalizer so existing report directories still render. Nothing is sent to a provider any more, and a test asserts
  that a provider past the mark gets no signal and no report; a planted residue forbids the
  report flags outside the legacy reader.
- **Build and release.** `scripts/build.ts` keeps the ritual (bump, set every workspace and the
  plugin manifest, bundle, start every bundled provider on bun, commit `Build x.y.z`, which Phase
  2's pin check reads); `--target node` and the UMD gate stay. Root `engines` names bun at the
  measured floor (`engines.bun`, `engines.node` gone); `_test.yml` drops its `Setup Node` step
  and the comment that bun has no `node:sqlite`, and runs `bun run build --build-only` after the
  suite so the provider smoke meets both matrix versions; `_lint.yml` and `_audit.yml` are
  already bun-only. One release for Phases 0
  and 1: one CHANGELOG, `bun run build major` once, push, smoke; the smoke transcripts go in a
  GitHub Release, not in a commit after the `Build 3.0.0` HEAD that Phase 2 pins.
- **Docs.** CLAUDE.md's Development and Releasing sections rewritten (bun is the one runtime; the
  store runs everywhere the suite runs; `bun test`), and the three comments that state the old
  premise: `scripts/build.ts`'s header ("bun has no `node:sqlite`", and its Windows justification,
  which the plan answers with: a host without bun cannot launch the manifest's command, the bundle
  still runs on node, and bun on PATH is the requirement), `core/src/socketTransport.ts` and
  `client/src/transport.ts`. `docs/architecture.md`, `docs/client.md` (the spawn command), the
  CHANGELOG paragraph (bun required, node dropped, the LSP command).
- **Smoke on both hosts, after the release.** Phase 0 is not done at a green suite: the release
  is bumped and pushed, then the plugin is taken through each host's own install path in a tmux
  session and watched from the outside. Claude Code: update the plugin, open a session, `/mcp`
  shows lexicon connected, one prompt on a query tool (`overview` on a bound project, since
  `bind_project` never contacts the daemon), `ps` shows `bun .../dist/daemon.js` and the workspace
  holds its `daemon.json`. Copilot: `copilot plugin install lexicon@atelier-nyaarium` (a plain
  copy, the no-install-step case), open a session, `/mcp` shows the plugin-contributed server
  connected, the process list shows `bun .../installed-plugins/.../dist/main.js`, a daemon spawned
  by it holds the workspace lock; then a plugin update in place, which must retire the running
  daemon through the bundle stamp. On each machine the state root and its `install.json` are
  recorded. Both transcripts go in the GitHub Release.
- **Consumers.** Switchboard keeps its bundle for the same reason, built and run by bun
  (`bun ${CLAUDE_PLUGIN_ROOT}/dist/main-mcp.js`), the lexicon client inlined from the submodule
  at build time as Q6 said; the submodule stays dependency-free, so Switchboard's tests spawn the
  pinned daemon from the submodule's committed `dist/` and nothing nested can shadow the root's
  pins. Switchboard's release ritual is unchanged. Copilot resolves `${CLAUDE_PLUGIN_ROOT}` in a
  plugin's `.mcp.json` (verified: it launched Switchboard's bundle from its own copy).

## Phase 1 - Lexicon 3.0: what a ref needs from the index ✅

Shipped as 5cebf74 (the index contract, containment, the runtime owner, the providers) and
60e3751 (the architecture pass), released as 3.0.0 (fb05661), then 3.0.1 (f6f10c1) and 3.0.2
(336ed77) for the two defects the two-host smoke found. The smoke passed on 3.0.2 on both hosts;
its transcripts are on the GitHub Release v3.0.2, shared with Phase 0.

Audited twice (lap 1, eight angles; lap 4, six angles after the Phase 2 additions, on Opus once
Sol's window ran out). The plan as rethought.

### One method binds an answer to its bytes

- A new daemon method, `moduleDeclarations` (request `ByModule`), answers from ONE `SourceRead`
  and one synchronous store read: the `ModuleStatus` fields, `read` (a closed value,
  `text | missing | binary | tooLarge`, with the detail text; today `moduleStatus` derives
  `exists` from that read and discards the bytes, and `binary` and `tooLarge` are recorded as a
  `failure` indistinguishable from a parse error), `contentHash` (the hash the index holds, null
  when no row), `diskHash` (the hash of the bytes that same read loaded, null unless `text`),
  `failure` (the last parse failure, if any) and the declaration rows. The answer lives in its
  own small module whose residue forbids `await` and `async`, since run-to-completion is what
  makes the hash and the rows one snapshot (`readSource` and the store are synchronous, verified).
  Two requests cannot deliver "cannot disagree": `resolveChain` makes two today (`moduleStatus`,
  then `declarationsIn`), neither takes the read gate, and a watcher batch lands between them.
- `declarationsIn` and `moduleStatus` keep their shapes; the method table only grows.
  `PROTOCOL_VERSION` becomes `3.0.0`, a clean break with no migration window, said so in the
  CHANGELOG as `protocol/CLAUDE.md` allows: today `refuseAhead` compares majors only, so a client
  at protocol 2.1 against an installed 2.0 would connect and fail every `moduleDeclarations` call
  as `unknown method` instead of `Incompatible`; a major makes the stale-install case honest, and
  `decideFromLock` still rides a 2.x session's client forward onto a 3.0 daemon (newer is ridden,
  never retired; verified). What a stale install looks like to a consumer is one sentence in
  `docs/client.md`.
- `resolveChain` asks the one method, returns `contentHash` and `diskHash` on every answer, and
  answers `none` with `{ reason, detail?, contentHash, diskHash, matched, available }`. The reason
  enum closes over every refusal the daemon can send, in this precedence: `missing`, then `binary`
  or `tooLarge` (from `read`), then `unclaimed`, then `parseFailed` (a recorded failure with NO
  rows; a file whose outline pass succeeded and whose full upgrade failed still has correct rows
  at the current hash and resolves at outline depth), then `unread`, then `noMatch`. `matched` is
  `{ containerPaths: string[][]; consumed: number; count: number }`, since the fold holds a set of
  steps (the first segment matches at any depth, so there is no "top level" frontier), where the
  failing segment is `segments[consumed]` and `count` is how many matches its base name had;
  `available` is every declaration name beneath the frontier (every name in the module when
  nothing matched), deduped, in document order, capped, with `availableTotal` beside it.
- `awaitIndexed` stops throwing on a recorded failure: `IndexOutcome` gains a closed `cause`, and
  `awaitIndexed`'s `indexed: false` branch shares the `none` reason enum, so a content refusal
  never reaches a consumer as infrastructure (today `awaitIndexed` throws `DaemonError` for
  binary, oversized and parse-failed alike, and matches English for the rest). `skipIfCurrent`
  does NOT go on the wire: the skip fires only when the held depth satisfies the requested one,
  the wire default is `full`, and Phase 2 calls `awaitIndexed` only when the hashes already say
  a re-parse is due.
- Errors are closed at the client boundary: `DaemonError` gains a closed `cause`
  (`unknownMethod | refusedModule | spawnFailed | connectionLost | daemon`), set at both wrap
  sites, and `transport.ts`'s non-`starting` failure branch wraps instead of throwing a bare
  `Error`; a wire refusal carries lexicon's own wording, never a zod blob.
- `connect` gains `onWaiting({ waitingFor, retryInMs, elapsedMs })`, threaded from `connect` to
  `channel` to `connectFrames` beside `patience`, deduped by `waitingFor` (the frames arrive per
  250 ms retry), and also fired during the spawn wait inside `ensureDaemon`, which emits no frame
  today, so a cold spawn is not silent. The reconnect-once rule covers connect-time loss too:
  `connectFrames` sits inside the retry loop but outside its `try` in `channel.ts`, so a daemon
  closing before its welcome (the 30-minute linger exit under a session held for hours) escapes
  as a first-try `DaemonError`; it moves inside the `try` with the catch still narrowed to
  `ConnectionLostError`, and a test in `client/src/__tests__` pins reconnect-once, which nothing
  covers today.
- `hashContent` moves to `protocol/` (which already hashes in `factId.ts`) and core re-exports it,
  so the daemon and a consumer that imports protocol and client share one implementation. Its
  contract, stated in `docs/daemon-protocol.md` and tested: the first 32 hex characters of the
  sha256 of the file's UTF-8 DECODED text; BOM and CRLF are part of the text; equal to a hash of
  the raw bytes exactly when they are valid UTF-8. The residue forbids `createHash(` in any
  spacing across `core/src` and `client/src`, allowing the three hashes of something other than
  text (`core/src/transactions.ts` over image bytes, `client/src/paths.ts` over a workspace key,
  `client/src/discover.ts` over bundle bytes); `watcher.ts` re-exports the protocol's and hashes
  nothing itself, and `protocol/src/factId.ts` is the grammar's own. Planted and seen to fire.
  `awaitIndexed` carries `detail` on every refusal, `missing` included. Documented
  divergences from Switchboard's file tier: lexicon's 4 MiB source cap against Switchboard's 8 MB,
  and UTF-16 (lexicon calls it binary, Switchboard decodes it); both end in a refusal, never a
  wrong chip.

### Containment, reads and writes

- The owner exists: `protocol/src/symbolId.ts : normalizeModulePath` (NFC, separators, refuses
  absolute and `..`, drops `.` and empty segments, refuses control characters). Phase 1 makes it
  the wire's: a `ModulePath` schema in `protocol/src/daemonMethods.ts` TRANSFORMS every
  path-valued request field through it (`ByModule`, which `indexFile` and `refactorTrack` share,
  `Move.toModule`, `Comments.module`, `Docs.module`, `Resolve.fromModule`, `Insert.module`,
  `CoChange.module`, `FindByName.module`, `Gaps.module`, `FindImports.module`), refusing an escape
  with lexicon's own wording before any read or write. A transform, not a refine: `isCanonicalModule`
  is false for `./src/a.ts` and for any NFD filename, and no adapter pre-normalizes, so a
  refine-only schema would hard-refuse live macOS and MCP traffic. Filter fields (`within`,
  substring and regex matches) are not paths and are left alone. The dispatch residue forbids `z.`
  in `dispatch.ts`, so the schema cannot live there.
- The hole is `refactorTrack`: `TransactionManager.track` has no validation and reaches
  `path.join(this.workspaceRoot, module)`, so `refactorTrack("../secret.md")` answers
  `{ tracked: true }` today and `refactorRevert` then overwrites that file above the root.
  `refactorInsert` and `refactorMove` already pass `refactorPlanner.ts : workspaceModule`, which
  normalizes; the wire schema is defence in depth for them. The adapters' local fallbacks meet
  the same wire: the MCP's in-process backend asks `createDispatch(service)` through the one
  table the daemon backend asks over the socket, and the LSP's URI-to-module conversion is the
  protocol's `workspaceModule`, so no adapter path reaches core with a raw module. A wire refusal
  is worded by dispatch (`<method> refused: <field>: <the grammar's sentence>`), never a zod
  blob, and the client reads `refusedModule` from those words.
- `readSource` stays total (`text | missing | binary | tooLarge`; `moduleStatus` derives `exists`
  from `missing`). The assert against a non-canonical module lives in the wire transform, not in
  `readSource`: the watcher feeds OS-supplied filenames to `readSource` inside its `fs.watch`
  callback, `normalizeModulePath` refuses control characters that POSIX filenames permit, and
  `daemonCli.ts` turns any uncaught exception into a shutdown, so a throwing `readSource` would
  turn a legal filename into a dead daemon. Instead the two places that mint module keys, the
  watcher's `toModule` and `fileScope.ts`'s `git ls-files` set, route through
  `normalizeModulePath` and DROP an unrepresentable name as out of scope, so a file indexes and
  is queried under one NFC key. No case folding and no realpath at query time: two names are two
  modules, stated in `docs/daemon-protocol.md`.
- The primitive exists: `protocol/src/providerKit.ts : workspaceFile(root, module)`, already
  gated by a residue sweep for providers. `sourceRead`, `sourceWorkspace`, `transactions.full`
  and `applyEdits` route through it, and that sweep extends to `core/src` forbidding its narrow
  token; a `path.join(` allowlist would name 12 of the 12 files that use it (22 calls, most of
  them not module joins), which is the "match the token, never the context" failure.
- CHANGELOG names this as workspace containment, not a security fix: the socket is loopback with a
  token and every client already runs as the user.

### Qualified definitions and chain matching

- No schema field. The C++ provider mints the written scope of an out-of-line definition as
  DESCRIPTORS on the symbol id (it already builds the qualifier array and discards it), so
  `void Physics::World::step()` becomes `Physics/World#step().` rather than a positional `step`
  and `step(1)` whose ids swap when the source reorders and carry recorded knowledge to the wrong
  function. A qualifier segment declared in the same parse takes that declaration's descriptor
  kind; one that is not takes `namespace`, a convention `docs/provider-protocol.md` states as
  identity, not as a claim about the language. The C# provider does the same for an explicit
  interface implementation. Conformance pins both through the existing `descriptors` expectation.
- A prototype and its definition in one parse become one symbol by an explicit provider
  de-duplication, not by construction: `findQualifiedParent` already resolves a written qualifier
  against the parse, so both drafts share a parent today and `assignDisambiguators` numbers them
  positionally (`step().` and `step(1).`); when the qualifier does not resolve, both drafts have no
  parent, the same key groups them, and reordering the source swaps the ids. So (a) the
  disambiguator's group key becomes the full descriptor path, and (b) `parseFunction` merges a
  definition into an existing prototype draft of the same qualifier and signature, keeping the
  definition's range, before disambiguators are assigned. Then `Physics::World::step` never
  answers `ambiguous` against itself.
- `containerPath` is the id's own descriptor names (`parseSymbolId`), the identity every provider
  mints, and the container chain only for an id carrying no path of its own: a written scope
  nothing declares (an out-of-line definition, an explicit interface implementation inside its
  class) is then on the path even where `containerId` names the class. The scope carried between
  segments is a descriptor PREFIX, so a segment may match a descriptor name at any prefix depth:
  the split spelling `Physics:World:step` the manifest teaches resolves, and `segments` can tell
  two candidates apart. The C# explicit implementation keeps its enclosing class in the id
  (`Service/IRun#Go()`), so two classes implementing one member never collide.
- Run matching: a run of segments matches a declaration name IN FULL when joined
  (`Acme:Services` reaches `Acme.Services`), never a proper prefix, since `QUALIFIER` applies to
  every language and a markdown heading `Node.js setup` must not answer `README.md:Node`.
  `resolveChain` tries the plain fold first, then the longest joined run, and a tie across readings
  answers `ambiguous`. The same rule reads INSIDE one segment: `Physics::World::step` as a single
  segment matches the descriptor names and the name joined, so the manifest's headline spelling
  resolves with no split.
- `ChainCandidate` gains `segments`, the chain that reaches exactly that candidate (container names
  as written, `[n]` where needed), minted by `chain.ts` and re-resolved to `exact` in a test, so a
  consumer can offer paste-ready refs. `docs/client.md` states the two ordinal readings side by
  side: the id grammar's `name[n]` counts same-name siblings of one container from 2; the chain's
  `[n]` counts matches of a segment across depths from 1, in document order.
- The occurrence convention needs no provider work: `protocol/src/serve.ts` wraps every
  provider's `parseFile` answer in `withOccurrences` (all thirteen go through `serveProvider`),
  and `core/src/factAdmission.ts` refuses a duplicate id before anything is written. The first
  audit's silent-overwrite story was wrong, and so was the note that
  `providers/python/src/extract.py` reimplements the convention: it mints method disambiguators
  for same-named declarations, which is identity, not occurrences, and nothing needs filing.
- `core/src/__tests__/language-branch-residue.test.ts` sweeps `client/src` too (the qualifier
  work lands in `chain.ts`) and `LANGUAGE_NAMES` gains the names it lacks (cpp, c++, kotlin,
  markdown, c). It lands green (no quoted language name in `client/src` today), so it is planted
  before it is trusted (planted with a quoted `kotlin` in `chain.ts`; it fired).

### C# parameters

- The provider mints a parameter with the `parameter` descriptor, `(name)`, like every other
  provider; today `languageKind: "parameter"` falls through to `term` and `isParameterSymbol`
  never sees it. Fixed in the provider, not by loosening the client (TypeScript sets no
  `languageKind`, Kotlin spells constructor parameters `constructorVal`). Conformance pins it.

### Spawn runtime and session

- One owner, `bunExecutable(host, probe)` (Phase 0 names it; the spec is here) in the client over
  the `PlatformEnv` seam `paths.ts` already has, which gains `execPath` only (21 files build a
  `PlatformEnv`; a second required field is a suite-wide break, and a version on a data record
  cannot stub the PATH branch a test must pin): `process.execPath` when it is bun, else `bun` from
  PATH (`bun.exe` on Windows, then `BUN_INSTALL/bin`), the version read through an injected probe
  that runs `--version` once per process and caches it, refusing missing, malformed and
  below-floor by name. The daemon's provider spawn and handover take the same executable, so the
  `runtime: "node"` label and the node report arguments in `core/src/providers.ts` go with it.
  Enforced by a residue forbidding a `process.execPath` read, in either spelling, in production
  source outside `runtime.ts` and the live-host seam `paths.ts` (`currentHost()`), planted and
  seen to fire; `scripts/build.ts`'s smoke spawns on the bun running the build, the owner's own
  first answer, since tsc's `rootDir` keeps the client source out of `scripts/`. The build
  already refuses an entry point whose source lacks a `refuseRuntime(` call (Phase 0,
  `checkEntryGuards`, the conformance CLI excepted).
- `classifyWorkspaceRoot(path)` moves from `core/src/workspaceAdmission.ts` to the client (core
  imports it), so a consumer knows before its first spawn that the daemon would refuse `/` or
  `$HOME` as a workspace, and `docs/client.md` says so. `daemonCommand` returns a closed outcome
  (`command | unbuilt | noBunRuntime`), `EnsureResult` carries the reason as a closed value, and
  `NotInstalled` stays what it is (no install to spawn from). The daemon's handover
  (`core/src/providers.ts` and `daemonCli.ts`) spawns through the same owner, and `drift.ts` stops
  reading `null` as "no bundle".
- The install source becomes a thunk, re-derived once per invocation at all four sites that read
  it today (`ensureDaemon`, the channel, and `findDaemon` inside both `lock()` and
  `stopDaemon()`), re-running `locateInstall` each time; a mid-session `NotInstalled` is thrown
  from that call and cached by nobody. Today `connect` captures the install's `bundleStamp` once,
  so a session held for hours re-spawns from a frozen root after the linger exit, a rebuild in
  place (a Copilot plugin update, or dogfooding) makes `decideFromLock` answer `replace` forever,
  and a Claude plugin update leaves it on a retired directory. "Once per invocation", not per
  poll: `ensureDaemon` re-reads the lock while waiting.
- The client's default patience stays five minutes (Q2).

### Tests

- Per-language shapes belong to CONFORMANCE, which already pins provider output through
  `ExpectedDeclarationSchema` and its `descriptors` against every provider: the C++ out-of-line
  definition and the prototype it collapses into, the C# file-scoped namespace and `arguments`,
  the GDScript `class_name`, the TSX member, the JavaScript anonymous nesting and the markdown
  heading are corpus cases, not a second copy of Switchboard's fixture that would diverge with no
  drift check. The corpus's TypeScript cases carry a `tsconfig.json` with `allowJs` and `jsx`:
  the provider's `FALLBACK` options apply only when no tsconfig is found, so a found config must
  say so itself.
- `core/src/__tests__/chain.test.ts` (daemon-backed, `whenBuilt`-gated, providers from source
  under bun) keeps only what needs a daemon: the hash after an edit, `parseFailed` with and
  without rows, `binary` and `tooLarge` through `read`, a module denied by scope answering
  `unclaimed`, `ChainCandidate.segments` re-resolving exact for the ambiguous set, the full-name
  run, the descriptor-prefix split spelling, and the prefix that must not match (a dotted markdown
  heading).
- `client/src/__tests__/chain.test.ts` (stub-backed) covers the fold and run order, the tie, and
  `matched`/`available`; `client/src/__tests__/discover.test.ts` pins `bunExecutable` against a
  stubbed host and probe and the closed `daemonCommand` outcomes; a `channel` test pins
  reconnect-once including connect-time loss; `connect.test.ts` pins `refuseAhead` on a stale
  install; `core/src/__tests__/watcher.test.ts` pins `toModule` NFC and the dropped name.
- Containment: refusals and transforms on every path-valued field, planted; the `workspaceFile`
  sweep extended to `core/src` and planted against the four sites; `refactorTrack("../x")`
  refused.
- `daemonAnswers.test.ts` gains the new method's sample (the mapped type makes a missing sample a
  compile error). Conformance across every provider.

### Docs and release

- `docs/daemon-protocol.md` (the method, the hash contract, containment, the ordinal readings),
  `docs/client.md` (`resolveChain` answers, `segments`, `bunExecutable`, the source thunk),
  `docs/provider-protocol.md` (qualifier descriptors, the occurrence convention as required).
- CHANGELOG by hand and COMMITTED before the build (the build refuses dirty tracked files and
  stages only the version targets and `dist/`): retitle `## Unreleased` to `## 3.0.0`, fold in
  Phases 0 and 1 beside the two client-plan phases, say that every store re-indexes once and that
  recorded answers survive as stale (`salvageKnowledge` carries them), name workspace containment,
  the protocol major as a clean break with no window, bun as the runtime and the LSP command.
  Then `bun run build major` once for both phases.
- Verification: the suite, conformance across every provider, `grade.js` against the switchboard
  checkout (extraction and resolution both change), then the consumer probe against the built
  install. Known and older than this phase: the conformance gate
  `literals/claimed-tier-is-tested/literals` fails for every code provider, since the corpus
  holds no literals case with a code fixture; the CLI exits 1 on it at HEAD before this work and
  after it. The gate is right and the corpus is short; a literals case per code language is its
  own change.

### As shipped

Reconciled after the red-team and architecture passes of lap 2. Where this differs from the text
above, this is what the code does.

- The method table marks the twelve non-idempotent writes, the knowledge writes and the refactor
  steps, `mutates: true`, read through `methodMutates`. `daemonChannel` asks a read again after a
  lost connection even when its frame was sent, and reports a sent write as `connectionLost` with
  the outcome unknown. `ReadMethod` derives the read set from the table and types the LSP
  adapter's asks, so a write asked there fails to compile. `ensureFailure` in `ensure.ts` is the
  one mapping from `EnsureReason` to a `DaemonError` cause. `runtimeVerdict` compares through
  `lock.ts`'s `newerBuild`, one comparator. `stopDaemon` judges the install before closing the
  channel, so a refusal leaves the session whole. A client that cannot read an answer names the
  field, never zod's issue list.
- `IndexOutcome` carries the cause `fault` beside `providerDown`. At the `supervisor.ask` boundary
  in `indexFile` a dead provider is `providerDown` and any other ask failure (a timeout, a
  malformed answer) is `parseFailed` with the failure recorded; an error escaping `indexFile` or
  `indexOne` in the scan, upgrade and watcher loops is `fault`, unrecorded, excluded from the
  background retry. One private constructor owns every outcome's action and reason. A warmup
  pass with any outage or fault ends `failed`, every request says so until a restart, and a
  watcher batch does not revive it. A pruned file that left scope is `forgotten` with cause
  `unclaimed`; `awaitIndexed` throws `DaemonError` for `fault` as for `providerDown`.
- `qualifierDescriptors(names, declared)` and `angleDelta(text)` in `providerKit` own the
  qualifier rule and angle-bracket depth; both parsers keep qualifier names on their records and
  settle descriptors after the whole parse, so a qualifier's kind does not depend on declaration
  order. The C++ merge key is the canonical signature: parameter types with names and default
  arguments dropped and integral spellings folded, then the cv and ref qualifiers, so `f() const`
  stays apart from `f()` and `f(unsigned)` merges with `f(unsigned int)`. The prototype's name
  token is a `read` reference to the merged symbol and the definition's is the declaration.
  Overloads sharing a path are numbered by their final source position, stated in
  `docs/provider-protocol.md`. Known limit, not fixed: a qualified definition written BEFORE its
  class (ill-formed C++) settles to the right path but is not merged with the later prototype;
  the two ids do not collide.
- `insideWorkspace` also refuses a write through a directory link that leaves the real root; the
  chain compares names NFC on both sides; `moduleStatus` and `declarationsIn` stay as older views
  of the same store, documented as such, not as projections.
- Found by the smoke, shipped as 3.0.1: a 3.0.0 client could not retire a 2.x daemon. `retire`
  asks `refactorStatus` through `connectFrames`, whose welcome check refused the older daemon
  before the question was sent, so every request on a workspace with a lingering 2.x daemon
  failed as `spawnFailed` ("it would not say whether a refactor is open"). `connectFrames` takes
  `acceptOlder`, `callDaemon` passes it, and `ensureDaemon`'s default ask sets it; the retirement
  is the one conversation across a major, since `refactorStatus` and `shutdown` are answered by
  every major. Pinned over the real socket in `ensure.test.ts`; the injected-ask tests had
  replaced the seam that failed.
- Found by the same smoke, shipped as 3.0.2: switchboard's C++ fixture `engine.cpp` (an
  out-of-line `Physics::World::step` with no class in the file) made the provider name a
  `containerId` the file never declares; the store's admission refused it, the refusal escaped as
  a `fault`, the fault failed the whole warmup pass, and a daemon whose warmup failed refused
  every request, `refactorStatus` included, so it could not be retired and the workspace stayed
  unusable across restarts. The provider names a container only when the file declares it (the
  written scope stays in the id and `containerPath` reads it from there); an admission refusal is
  that file's `parseFailed`; a `fault` is recorded in its own words against the file and no longer
  fails the pass, which fails only on a provider outage; `refactorStatus` is answered by a
  warmup-failed daemon and, for daemons that still refuse it, `retire` reads the
  `warmup failed:` prefix (owned by the protocol package) as "no transaction is open".

## Phase 2 - Switchboard: the resolver rebuilt on the index ✅

Audited (lap 2, seven angles: wiring and build, workspace and paths, the pipeline, errors and
session, teaching and console, tests and CI, principles and scope). The plan as rethought.

### Wiring

- The bundle stays (Phase 0, Consumers: Copilot's plugin install is a plain copy with no install
  step). `.mcp.json` runs it under bun, `bun ${CLAUDE_PLUGIN_ROOT}/dist/main-mcp.js`, so the
  daemon spawn shares one runtime with lexicon; `bun-floor.ts`'s verdict guards the MCP entry as
  it guards the gateway. `bun run build minor` (8.4.0) bumps, bundles and commits as today, minus
  the wasm copy. The lexicon client is inlined from the submodule at build time; nothing under
  `lexicon/` is read at runtime.
- The pins are `protocol`'s, not the client's: `client/package.json` depends only on
  `@nyaa-lexicon/protocol`, and `vscode-jsonrpc` 9.0.1 and `zod` 4.4.3 sit in
  `lexicon/protocol/package.json`. The root pins both and the build asserts every protocol
  dependency is pinned at the root to the same string. The submodule stays dependency-free: a
  dogfooded submodule's own `node_modules` (`lexicon/protocol/node_modules/{zod,vscode-jsonrpc}`,
  gitignored) shadows those pins through the symlink for both `bun build` and `tsc` (a bundle
  carrying two zods was reproduced), so the build refuses while any `lexicon/*/node_modules`
  exists, and a post-build assertion counts one zod in the output.
- `lexicon/` submodule pinned at the release commit, for types and tests, kept OUT of bun's
  package graph. Proven in a scratch copy: Claude Code runs `bun install` in the installed plugin
  directory and a marketplace clone leaves the submodule empty (and has no `.git`), so
  `workspaces` naming `lexicon/protocol` fails every consumer's install ("Workspace not found"); a
  glob over-matches `core` and `formats` when the submodule is present; npm rejects `workspace:*`
  outright. Instead a root `postinstall` script (`scripts/link-lexicon.mjs`, run by node so an npm
  install without bun survives; bun runs a root's own lifecycle scripts by default) links
  `lexicon/protocol` and `lexicon/client` into `node_modules/@nyaa-lexicon/` for `tsc` and vitest:
  `rmSync` the old link first (`existsSync` is false on a broken symlink while `symlinkSync` still
  throws `EEXIST`), exit 0 silently when `lexicon/<pkg>/package.json` is absent, fail loudly when
  it is present and linking fails. `tsc` sees 35 source files and no tests; vitest resolves the
  symlinked package with no `preserveSymlinks`.
- The daemon-backed tests spawn the pinned daemon from the submodule's committed `dist/`
  (`lexiconRoot: <repo>/lexicon`), which needs no install in `lexicon/`.
  `scripts/check-module-residue.ts` names the `@nyaa-lexicon` scope as a link (today a symlink
  fails its `isDirectory()` test and is invisible), and a test asserts each link's realpath is
  under `lexicon/`.
- `biome.json` gains `!**/lexicon` (without it biome aborts on the nested root config);
  `vitest.config.ts` restricts the suite to `src/**/*.test.ts` (without it 162 lexicon test files
  are collected) and sets `testTimeout` and `hookTimeout` for the daemon-backed suite; CI checks
  out with `submodules: true`, sets up bun (the daemon and its providers run on it; vitest keeps
  running on the runner's node as it does today), needs `python3` on the runner (a provider
  outage becomes a thrown `DaemonError` and degrades every `.py` ref), installs frozen at the
  root. `tsconfig.json` needs no change.
- `scripts/build.ts` asserts the submodule is POPULATED (`git submodule status` with no `-`
  prefix) BEFORE reading its HEAD subject, since `git -C lexicon log -1 --format=%s` on an empty
  submodule walks up to the superproject, whose own subject `Build 8.x.y` matches the pattern;
  then asserts the subject reads `Build x.y.z` (lexicon has no tags; that subject is the one
  signal it mints per release). `dirtyTrackedFiles` reads porcelain v2 submodule records
  explicitly: a record whose third field starts with `S` refuses unless it is exactly `.M S..U`
  (untracked files inside); `SC..` (pin moved unstaged), `M. S...` (pin move staged) and `S.M.`
  refuse. Fixtures beside the existing `N...` ones in `build.test.ts`. An empty submodule emits no
  record at all, hence the populated assertion.
- The console update rides the same push: `main-push.yml` builds the APK on `android/**`,
  `tests/fixtures/**` and `src/shared/**` changes, all of which this phase makes. Until the owner
  installs it, an installed console still teaches "resolution never fails" from its manifest, so
  the console update is sequenced with the plugin reload, not after it.

### The workspace and paths

- `refWorkspace.ts`, one owner. The root: git toplevel of the MCP's cwd (`git rev-parse
  --show-toplevel`), else cwd, `REFERENCE_ROOT` overriding, captured once at start; the container
  branch of today's `referenceRoot` goes. A root the daemon would refuse (`/`, `$HOME`, through
  the client's `classifyWorkspaceRoot`) is known before any spawn and every chain in that session
  degrades with cause `noWorkspace`.
- The written path: the shell rule moves here from `refFile.ts` (bare is root-relative, `/` is
  the filesystem root, `~/` is home, `~user` stays literal); `loadRefFile` takes the classified
  absolute path and never sees a root, so `ref-file.test.ts` changes and the plan says so. A
  residue test forbids `os.homedir(`, `realpath` and `path.resolve` in any other module under
  `mcp/references/`.
- Classification is LEXICAL: `path.relative(root, absolute)`; outside when empty, absolute or
  starting with `..`; else `normalizeModulePath(relative)` from `@nyaa-lexicon/protocol` (NFC,
  separators), the same function the daemon keys by. The realpath (`realpathSync.native`, as the
  client's `canonicalRoot` does) is only the snapshot's dedupe identity, so aliases ship once.
  Realpath-first classification would be wrong for a tracked symlink inside the root pointing
  outward: lexicon lists it through `git ls-files`, follows it on read, and answers `exact`.
- Outside the root: file tier only; a matcher runs over the whole text; a chain refuses naming the
  `#text` form; `refPath` on the wire stays as written.

### Coordinates

- `refCoordinates.ts`, one owner of conversion, and the new home of `Quality`, `Span` and
  `Resolution`: a protocol `Range` (0-based, half-open, UTF-16 columns over the decoded text
  Switchboard also holds) to 1-based inclusive lines (an end at character 0 closes on the previous
  line) and to offsets into the snapshot text for the matchers. Tests on a leading newline, a file
  without a trailing newline, a match at offset 0, the last line, CRLF.
- `span` is the declaration's `selectionRange`; for `arguments` (no selection) the range itself,
  so the parameter list lights; a matcher's span overrides.
- The producer's `Quality` union closes here (`exact | fuzzy | unresolved`). `RefKeyMeta.quality`
  STAYS an open string on the wire: the gateway and federation validate inbound files with the
  same schema on a different update trigger, and the schema's own comment records why an unknown
  tier must render plain rather than reject the reply. No wire change.

### The pipeline

`refResolve.ts`, per ref, in this order; every ref is resolved before any refusal, and a refusal
carries one block per failing ref (today the first problem wins, and under Q1 refusals are the
normal path).

1. File tier: written path to absolute (`refWorkspace`), load (missing, not a file, over the
   source limit, not text): hard error as today; "a secret" is gone from the wording.
2. No chain: the whole file (`exact`, lines 1 to n), or a matcher over the whole text. The daemon
   is never touched: a matcher is a claim about the text, and routing it through the index would
   import lexicon's 4 MiB cap and its UTF-16 refusal into a ref that needs neither. `resolveChain`
   answers `noMatch` for an empty chain, which Q1 would turn into a refusal of the most common ref.
3. A chain on an outside path: refuse, naming the `#text` form.
4. A chain on a module: the session (lazy, below), `resolveChain(module, segments)` over the one
   method. The answer's `contentHash` and `diskHash` against the snapshot's `hashContent(text)`,
   imported from protocol, never reimplemented:
   - `contentHash` equals the snapshot's: bound.
   - `diskHash` equals the snapshot's, `contentHash` does not: the index is behind;
     `awaitIndexed` once, resolve again.
   - `diskHash` differs from the snapshot's: the file moved under the reply; re-read into a fresh
     snapshot, resolve again once.
   - Still apart: refuse ("the index and the file disagree; send again, or use `#text`"). Never
     degrade here: a banner over coordinates that do not describe the shipped bytes is the defect
     the hash exists to kill, and Q1 reserves degrading for infrastructure absence.
5. `exact`: the range and span through `refCoordinates`; a matcher applies over the range's text;
   a matcher that finds nothing inside an exact scope refuses (the author can fix the text; the
   error quotes the scope's lines).
6. `ambiguous`: refuse, listing each candidate as `ref://<path as written>:<candidate.segments
   joined by :>` (the canonical key of the written path, the candidate's `segments` and the ref's
   own matcher), each re-resolved to `exact` before it is offered.
7. `none`, by reason: `noMatch`, refuse naming `matched.containerPaths` (how far the chain got,
   and how many matches the failing segment's base name had), `available` (what is declared
   there, with `availableTotal` when capped) and the `#text` form; `unclaimed`, or a module with
   nothing `available`, refuse naming `#text`; `parseFailed` (the provider could not parse the
   file and holds no rows), refuse naming the provider's reason and `#text`, since the index can
   claim nothing about the file and a text match would be the plausible wrong target Q1 refuses;
   `binary` or `tooLarge` on a file the file tier just read: the index refused what Switchboard
   accepted (lexicon caps at 4 MiB and calls UTF-16 binary), cause `indexRefused`, degrade;
   `unread` after the hash loop, cause `warming`, degrade; `missing` on a file read a moment ago:
   the file vanished, hard error.
8. Infrastructure: `NotInstalled`, `Incompatible` (a stale install at protocol 2.x meets a 3.0
   client at `connect`, before any spawn), `DaemonError` (its closed `cause` is what the notice
   names), a connection lost past the client's reconnect, warming past the budget,
   `noWorkspace`, `indexRefused`: the text tier
   (`fuzzy` on the last segment's first occurrence, else `unresolved`), a `reason` rendered from
   the closed cause enum in one renderer (`refNotices.ts`, also the 256-character wire prose), and
   a notice.

### Errors, notices and the session

- Cause enum: `notInstalled | incompatible | warming | daemonError | connectionLost | noWorkspace |
  indexRefused`. One renderer owns the prose for the wire `reason` and for the notices.
- `AttachResult` gains `notices: string[]`, deduped by cause; the two call sites
  (`channel/channelReply.ts`, `channel/humanTools.ts`) print them after their own success text
  ("Reply sent." lives in `bridge/replyTool.ts`, which never sees refs; `postReply` gains a
  `notices?` option or the call sites append). The author learns what drifted without blocking.
- Session: `let sessionPromise: Promise<Session> | null` in `attachRefs.ts`, created on the first
  chain ref inside the root, cleared on any throw (an install can appear mid-session, and a stale
  daemon's `Incompatible` heals on its own), so two replies in flight share one socket; closed on
  stdin end; `stopDaemon` never called (the daemon is shared).
- Patience: an explicit per-reply budget of 45 s under the MCP SDK's 60 s default request
  timeout, which the caller applies and the server cannot lengthen; a cancelled tool call whose
  handler still posts double-sends to the phone on retry. Past it: cause `warming`, text tier, and
  a notice saying to send again. Q2's generosity is the daemon's (lazy, shared, lingering), not the
  agent-to-MCP hop's; `onWaiting` from Phase 1 feeds the notice with what the daemon was waiting
  on. Measured cold index on a 990-file workspace is 5.7 s, so the budget is a tail guard.

### Deleting tree-sitter

- Gone: `grammarSources.ts`, `scripts/build-grammars.ts`, `grammars/`, `web-tree-sitter` (a
  dependency) and the seven `tree-sitter-*` dev dependencies with their lock records,
  `dist/web-tree-sitter.wasm`, the `RUNTIME_WASM` copy in `build.ts`, the grammars mention in
  `plugin-root.ts`'s doc comment, the CLAUDE.md wasm bullets, `grammars.test.ts`,
  `ref-resolver.test.ts` (inline tree-sitter snippets). `refResolver.ts` is emptied of its
  tree-sitter half: the types move to `refCoordinates.ts`, `applyMatcher` and its helpers to the
  pipeline; `artifactBuilder.ts` and `ref-artifacts.test.ts` change their imports only.
  `ref-end-to-end.test.ts` is rewritten over the daemon.
- Residue: `lineOf`, `columnOf`, `path.resolve` on a ref path and `referenceRoot` forbidden
  outside their owners, planted.

### Teaching

- The manifest's `agent_instructions` (an APK asset: see Wiring), `skills/crosstalk/SKILL.md`,
  `CLAUDE.md`'s section and the two tool descriptions say the same thing: exact is one
  hash-verified declaration; ambiguity and a missing name refuse with a fix to paste; `[n]` picks
  among repeats; `#text` needs no chain and is the form for files without symbols and paths
  outside the workspace; only lexicon's absence degrades, and the reply says so. Examples: the TSX
  example becomes `App:render` (the fixture declares no `handleSubmit`); `util.js` gains a second
  `deepHandler` so `[2]` earns an example; the C++ and C# examples stay, since Phase 1 makes them
  resolve. Two tests: every example parses; every example whose path lies inside the fixture
  resolves `exact` with the lines read off the file; the absolute and home examples are
  parse-only.

### Console

- The APK is built by the same push (Wiring). It carries the corrected sandbox keys (`isJoinable`
  at 33-36, span 33:9 to 33:19; today both keys claim lines 1-12) with the exact ref's new `span`,
  and the deletion of the dead emulator asset `switchboard-references.json`. `noticeFor` is
  unchanged; the never-applied `link-fuzzy` rule stays (no behaviour, no test); GDScript
  highlighting waits for a later APK.

### Tests

- The daemon-backed fixture suite: `tests/fixtures/ref-project/tsconfig.json` (the provider is
  project-model driven; it sets `allowJs` itself); `stateDir` from `mkdtemp` BEFORE
  `mountBlobWire()`, which repoints `TMPDIR`; `connect({ workspaceRoot: fixtureRoot, lexiconRoot:
  <repo>/lexicon, stateDir, patience })` in `beforeAll` (180 s), warming each fixture file through
  `awaitIndexed` there so no `it` pays the index; `stopDaemon()` then the wire disposed in
  `afterAll`; gated on the submodule's `dist/daemon.js` existing, so a marketplace clone skips.
  Assertions: the explicit 1-based lines per manifest example (`cart.ts` add 5-10, Cart 2-11,
  Shop 1-12; `engine.cpp` step 3-5; `Svc.cs` Compute 4-6; `belt.gd` advance 13-14, Slot 4-6;
  `App.tsx` render 2; `util.js` deepHandler 3); the ambiguous refusal's candidates re-resolving
  exact; the `noMatch` refusal's `available`; `[n]`; `arguments` with its span; a matcher over a
  resolved range and a matcher miss refusing; the hash loop both ways (index behind, file moved);
  the outside-root chain refusal; the no-chain ref never touching the daemon; the PNG.
- Degraded paths without a daemon, through `lexiconRoot`: an empty directory (`NotInstalled`); a
  `dist/daemon.js` file with a `dist/version.json` claiming a lower protocol major
  (`Incompatible`, before any spawn); `dist/daemon.js` as a directory with a `version.json` at the
  client's own `PROTOCOL_VERSION` (`DaemonError` from the closed `unbuilt` outcome, no wait); the
  warming banner through a test-only session-factory setter in `attachRefs.ts` with a fake
  `Session`.
- Surviving unchanged: lexer, grammar (plus two `[n]` vectors in `vectors.json`:
  `ref://src/app.ts:run[2]` canonical to itself, and `run%5B2%5D` to the same key, read by the
  Kotlin test without an edit), scanner, artifacts (imports only), guidance reach (extended),
  reply files.
- No floor constant of Switchboard's own for the daemon: the client's `noBunRuntime` cause is the
  surface, and `bun-floor.ts` guards the MCP entry (Wiring). Kotlin unit tests run in
  `main-push.yml` on the same push (`tests/fixtures/**` and `android/**` trigger it).
- Ladder: Switchboard's suite, lexicon's suite and conformance, `grade.js`, then the release
  bumped and pushed, then the same two-host smoke as Phase 0 (Claude Code and Copilot in tmux,
  `/mcp` connected, the bundle running under bun from each host's own copy), then a live reply
  with refs to the owner's console from each host.

### As shipped

Reconciled after the red-team and architecture passes of lap 3. Where this differs from the text
above, this is what the code does.

- Wiring: the post-build zod count is not asserted. One zod copy in the bundle carries the
  `$ZodAny` marker twice, so a count gate on the marker refused a correct bundle; the
  `lexicon/*/node_modules` refusal and the root pin assertion stay and are the guard. `main-mcp.ts`
  runs the bun-floor verdict first and only then imports the server, so the verdict is printed
  before the SDK is loaded on a runtime that cannot load it. `.mcp.json`, the submodule pin at
  `Build 3.0.2`, `scripts/link-lexicon.mjs` (run as `bun ... || node ...`), the porcelain v2
  submodule records, `biome.json`, `vitest.config.ts` and CI are as written. "Dependency-free"
  above means the submodule INSTALLS nothing under the superproject; `lexicon/protocol/package.json`
  still declares its two pins, and the root's copies are the ones a build resolves.
- Paths: `loadRefFile(absolute, written)` takes the classified path; the residue forbids
  `os.homedir(`, `realpath` and `path.resolve(` outside `refWorkspace.ts`, `function lineOf(` and
  `function columnOf(` outside `refCoordinates.ts` (the definitions, not their uses: a use is what
  the owners export), and `referenceRoot`, `web-tree-sitter` and `grammarSources` anywhere under
  `src/`. Two spellings of one file (an alias, `./`) ship one snapshot under the first spelling
  seen, keyed by `identityOf`.
- The pipeline: refusals are values. `Refusal` in `refNotices.ts` is a closed union (`file`,
  `matcher`, `outsideChain`, `vanished`, `unclaimed`, `parseFailed`, `disagree`, `ambiguous`,
  `noMatch`) and `renderRefusal` is the one place their sentences are written, beside the notices
  and the wire reason; `refResolve.ts` builds the value and never a sentence. The hash loop brings
  the index up once and re-reads a moved file once, then refuses; a `none` answer for `noMatch`,
  `parseFailed` and `unread` speaks for the file's bytes and joins the loop, the other reasons do
  not. Every daemon ask runs inside `withinBudget`, a race against the reply's deadline
  (`REPLY_PATIENCE_MS`, 45 s from `appendRefArtifacts`), and a spent budget degrades as `warming`;
  `onWaiting` is not wired, since `DaemonError.waitingFor` already names what the daemon waited on
  and the notice prints it. An install whose `dist/daemon.js` is not a file answers `NotInstalled`
  (the client's `unbuilt` outcome maps there), not `DaemonError`.
- Teaching: the four texts say lexicon being UNABLE TO ANSWER degrades (not installed,
  incompatible, still warming, a daemon that failed, or an index that refuses the workspace or the
  file), which is the `DegradeCause` enum in words; "absence" was narrower than the code. The
  absolute and home examples are illustrative and parse-only, as planned. A chain on an outside
  path is refused naming the workspace root and the `#text` form.
- Console: the wire keeps `ambiguous` and `matchCount` on `RefKeyMeta`, since an installed console
  reads them; the producer no longer emits them. `noticeFor` and the `link-fuzzy` rule are
  unchanged.
- Tests: the daemon-backed suite runs over a temp copy of `tests/fixtures/ref-project` with its own
  `git init` and `XDG_STATE_HOME`, so the fixture directory is never written and no state leaks
  into the developer's own; the daemon is stopped in `afterAll` and each test disposes its own
  blob wire in `afterEach`. `ref-resolve.test.ts` pins the budget (a deadline already spent, and
  one that runs out mid-ask) and the alias spelling over a fake session. The session seams
  (`setReferencesEnabled`, `setLexiconRoot`, `setSessionFactory`) stay three module-level setters;
  an owning `ReferenceRuntime` value is recorded under Painpoints rather than built under the
  release.
- Released as 8.4.0 (`Build 8.4.0`, 74390817) with the submodule at `Build 3.0.2`. Smoke: both
  hosts updated through their plugin commands and showed the server connected in `/mcp`, each
  running `dist/main-mcp.js` under bun from its own copy and spawning a lexicon daemon from its
  own lexicon install. A hand-launched `claude`, a hand-launched `copilot` and a gateway-started
  Copilot Agent each resolved two refs and were refused at the byte plane (tokenless callers,
  Painpoints). The live reply came from a host-daemon-managed Claude Code session woken on the
  8.4.0 plugin in the switchboard checkout: `notify_human` with `resolveRefs` and `renderRefusal`
  returned `Notice delivered.` and nothing else, which is the exact path (a refusal is an error
  and a degraded ref adds a `refs:` notice). No bound Copilot session can be started from this
  session, so the Copilot half of the live reply is the resolution without the upload.

## Phase 3 - The workspace root from the host

Asked for by the owner after the 8.4.0 report, from the Copilot finding under Painpoints: Copilot
starts a plugin's MCP server in the plugin's directory, so the cwd rule made every bare ref path
resolve against the plugin's checkout. Lexicon never cared where the server ran; the resolver did.

- `refWorkspace.ts` stays the one owner. The directory the root is judged from is, in order:
  `REFERENCE_ROOT` as written (an explicit override, no git walk); the host's first `file:` root
  from the MCP `roots/list` answer; the server's cwd. The host root and the cwd are each taken to
  their git toplevel, as the cwd was before, so a host that opened a package inside a repository
  still resolves against the repository. Non-`file:` URIs and unparseable entries are ignored; a
  host that declares the `roots` capability and answers an empty list is the cwd case.
- The cwd case has one correction, found by reading the Copilot server's environment: Copilot
  1.0.81 starts a plugin's server with cwd inside the plugin's own directory and `PWD` still the
  shell the user launched it from. A cwd inside `pluginRoot()` is therefore not a project, and
  `startDirectory(cwd, PWD, plugin)` answers `PWD` when it names a directory. A cwd that no longer
  exists (a server left in a directory a plugin update replaced, where `process.cwd()` throws)
  reads the same way, with home as the last resort, which the daemon refuses and the reply says
  so. Whether Copilot declares the `roots` capability could not be read from its logs; with this
  rule the root is the project either way.
- The host is asked once the session is up (`oninitialized`), and again on
  `notifications/roots/list_changed`. `expectHostRoots()` runs before `connect`, so a reply that
  arrives before the answer waits on `hostRootsSettled()` in `appendRefArtifacts` instead of
  reading cwd; a host without the capability settles at once, and one that does not answer within
  `HOST_ROOTS_TIMEOUT_MS` (5 s) settles to cwd with a line on stderr. A changed root reopens the
  lexicon session on the next ref, since the daemon is keyed by root.
- Tests: the host's root over the cwd up to its git toplevel; a non-git host root kept as is with a
  percent-encoded space decoded; non-`file:` roots ignored; `REFERENCE_ROOT` winning; a pending
  answer holding `hostRootsSettled()` and a reset releasing it; `appendRefArtifacts` holding a
  reply until `setHostRoots`.
- Verification: a patch release, then each host started in tmux on the switchboard checkout with
  no lexicon daemon alive for it, a ref sent, and the root read off the daemon each host spawns.

## Painpoints

Collected after Phase 0. Not fixed here; candidates for a later phase or a plan of their own.

- **`bun test` fails a test on a throw inside an in-process server callback while the test awaits
  `expect(promise).rejects`.** `core/src/__tests__/daemon.test.ts` ("reports a handler's failure")
  hit it: the handler's own `Error` was attributed to the running test and the sockets were torn
  down before the reply frame landed, so the client saw "the daemon connection closed". The same
  scenario passes as a script and as a test that catches by hand, which is the form the test now
  takes. Every future test that runs a daemon in-process and asserts a rejection meets this; the
  honest fix is a daemon-in-subprocess harness for those tests, not another hand-caught promise.
- **Memory limits have no provenance in the value.** `core/src/diagnostics.ts` keys the high-water
  mark on the host's `memTotal` from procfs because the runtime states no heap limit
  (`v8.getHeapStatistics().heap_size_limit` on bun is a figure the heap grows straight past). A
  cgroup limit below the host's is invisible, and the collection cannot say which limit the mark
  was judged against. The shape wanted: `memoryLimit: { kind: "host" | "cgroup" | "none"; bytes }`
  read by one owner (`client/src/procfs.ts` beside `hostMemory`), stored in `HostSchema`, consumed
  by `watchHighWater` and rendered by `project_diagnostics`.
- **The clock seam covers seven core modules and no transport.** `core/src/__tests__/clock-residue.test.ts`
  routes `service.ts` and six others through `core/src/clock.ts`; `client/src/transport.ts`,
  `core/src/socketTransport.ts`, `core/src/supervisor.ts` and `core/src/daemonCli.ts` still hold
  raw timers and wall-clock reads, so a deterministic test of a connect deadline, a heartbeat miss,
  a respawn backoff or the linger can only be written with a real sleep. One clock boundary shared
  by client and core, and one residue over every production module that keeps time, is the shape.
- **Executable selection is written three times until Phase 1's owner lands**:
  `client/src/discover.ts` (`daemonCommand`), `core/src/providers.ts` (`specFor`) and
  `scripts/build.ts` (the smoke) each say `process.execPath`, and the tests say it a dozen more
  times. Landed in Phase 1: `client/src/runtime.ts` owns it and the exec-path residue holds it;
  kept so the next reader knows the repetition was never a pattern.
- **Older plans under `plans/` still describe the node era** (`plans/refactor-production.md`,
  `plans/client-package.md`, `plans/diagnostics.md`: `node dist/...`, node floors, vitest). They are
  history, not instructions, and nothing says so at the top of the directory; a reader following
  one will run a command that refuses by name. Either a one-line README in `plans/` or a status
  line at the top of each retired plan.

Collected after Phase 1.

- **A behavior test that never failed pins whatever the code does.** Twice this phase an agent's
  new test encoded the defect it was written for: `client/src/__tests__/channel.test.ts` titled a
  case "lost before a request is written" over a fake that could not make that happen, and
  `providers/cpp/src/__tests__/identity.test.ts` asserted two `f` references where the second
  was the definition's own name leaking as a call. Residue tests already have the rule (plant the
  violation, watch it fail); behavior tests do not. The rule belongs in `CLAUDE.md` beside the
  residue one: a test added with a fix is run against the code before the fix, or against a
  deliberately broken build, once.
- **Codex sandboxes cannot bind `127.0.0.1`.** Every Luna run this phase reported the socket
  suites and both conformance CLIs as failed or `STALL`ed, and each spent a paragraph deciding
  whether that was a defect. It never was. A prompt that says so up front, and a conformance CLI
  that names the bind failure instead of a stall, would end it; the CLI change is the honest one.
- **The C++ parser is one 2200-line file with two clocks.** Identity is decided at parse time
  (`parseFunction`'s merge lookup, `findQualifiedParent`) and again at settle time
  (`settleQualifiers`, `assignDisambiguators`), and a rule that must hold across both, such as the
  merge of a definition with a prototype declared later, cannot be written in either. The draft
  index the architecture pass proposed (one identity index keyed by the settled descriptor path,
  consulted by merge, parent lookup and numbering) is the shape; deferred because it changes no
  output for valid source today.
- **`tsc --build` once served a stale declaration.** After adding `ReadMethod` to
  `protocol/src/index.ts`, the LSP project compiled against a `protocol/.tsbuild/index.d.ts` that
  predated the edit and reported the export missing; a second `tsc --build` regenerated it and
  passed. Not understood, recorded: a red gate right after an export was added is worth one
  re-run before it is believed.
- **An injected test double can replace exactly the seam that fails.** Every retirement test in
  `client/src/__tests__/ensure.test.ts` injects `ask`, so none of them could see that the real
  ask refuses an older daemon at its welcome; the suite was green through a handover that failed
  on every workspace with a 2.x daemon alive. The smoke found it in one prompt. When a seam is
  injected for speed, one test per suite must still cross it for real (the fake daemon exists for
  this), and the smoke stays in the ladder for what no fake can model.
- **A whole-workspace refusal on a per-file defect is a brick, and the ladder never saw it.**
  The outage rule (a warmup with any `fault` ends `failed`) was reasoned about, audited and
  green, and it made one deterministic provider defect in one fixture file take the daemon down
  on every restart. `grade.js` passed because it asks questions the fixture does not touch, and
  the suite's fake provider never mints an inadmissible answer. Only a real workspace with a real
  provider showed it. Anything that turns one file's failure into a refusal of everything needs a
  reason a restart would change; and the ladder needs one step that indexes a real, mixed
  workspace and asserts the pass ended covered.
- **`IndexOutcome.action` is chosen at the site, not derived from the mutation.** The cause-keyed
  constructor in `core/src/indexer.ts` needed a `forgot` flag because `unclaimed` is `forgotten`
  when rows were removed and `skipped` when there were none; an outcome whose action came from
  the store call that removed the rows could not disagree with it. The shape wanted: the store's
  `forgetFile` answering whether it removed anything, and the outcome built from that answer.

Collected after Phase 2.

- **Four teaching texts by hand.** `CLAUDE.md`, `skills/crosstalk/SKILL.md`,
  `src/mcp/capabilities.ts` and the console manifest's `agent_instructions` must say one thing,
  and two audits in one lap found them saying it differently (the "absence" wording, then an
  incomplete cause list). `ref-teaching.test.ts` pulls the examples back out of the prose with a
  regex that once stopped at `]`. The shape wanted: one source (the rule and the example list as
  data) rendered into the four places, with the test reading the data, not the prose.
- **A token count as a bundling proof.** The post-build zod gate counted a marker string to
  count copies of zod and refused a correct bundle, because one copy carries the marker twice. A
  proxy chosen from one observation is the same mistake as a residue that matches a spelling; the
  honest proof of "one copy" is the bundler's own module list (a metafile), not a grep over its
  output.
- **The reply budget is a constant the server cannot learn.** `REPLY_PATIENCE_MS` is 45 s because
  the MCP SDK's default request timeout is 60 s and the server is never told what the caller
  applied; a caller with a shorter timeout gets a cancelled call and a reply that still posts.
  Nothing lexicon or switchboard owns can fix it; recorded so the number is not mistaken for a
  measurement.
- **Three module-level setters as test seams.** `attachRefs.ts` exposes `setReferencesEnabled`,
  `setLexiconRoot` and `setSessionFactory`, and every test's `beforeEach`/`afterEach` resets all
  three plus `resetWorkspaceRoot`. The state has one owner in spirit and four in code. An owning
  value (`ReferenceRuntime`: enabled, workspace, lexicon root, session cache, deadline) built once
  at startup and once per test would replace the setters and the resets; deferred because it is a
  test-shape change under a release, not a defect.
- **Codex sandboxes, again.** No loopback bind and no bun on PATH, so every Luna run reported the
  daemon-backed suites as failed, and the client's `noBunRuntime` outcome surfaced as
  `DaemonError: missing`, one word, which two agents read as a defect. Prompts now say up front
  which failures are environmental. The one-word message is lexicon's (`ensure.ts` passes the
  runtime verdict's detail straight through) and is worth a patch that says "bun is not on PATH".
- **A whole-file ref counts the trailing newline.** `lineCount` is `split("\n").length`, so a
  file ending in a newline reports one line more than an editor shows, and the e2e assertion for
  the whole-file case had to learn that. Consistent with the snapshot the console renders (the
  content is the same string), so it stays; recorded because it will surprise the next reader.
- **A hand-launched session cannot attach a snapshot, and the refusal does not say why.** Found by
  the 8.4.0 smoke: a `claude` or `copilot` started by hand in tmux, and a Copilot Agent started
  through the gateway, all register without a session token, and while any bound session exists
  the gateway's byte plane refuses tokenless callers (`sessionAuthority.mayUseLocalPlane`). The
  refs resolved and the snapshots were built; the upload was refused; the agent read `blob
  transfer is not open to this caller`, one line from the gateway with no mention of tokens or of
  the notice-free path that would have worked. Older than this plan and by design, but a reply
  with refs is now the common case, so either the MCP refuses before resolving with a sentence
  that names the cause, or a registered-unbound session is admitted to the local byte plane.
- **Copilot runs a plugin's MCP server in the plugin's own directory.** The Copilot host's
  switchboard server spawned its lexicon daemon on
  `~/.copilot/installed-plugins/atelier-nyaarium/switchboard`, the plugin checkout, because that
  was the server's cwd, so `workspaceRoot()` (git toplevel of cwd) is the plugin and every ref
  from a Copilot session resolves against the plugin's copy of switchboard rather than the
  user's project. Claude Code starts the server in the project. The cwd rule predates this plan;
  the host-independent root is the MCP client's `roots/list`, which both hosts answer.
