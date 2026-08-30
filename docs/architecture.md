# Architecture

Seven packages. `protocol/` owns the wire types and the two id grammars, `client/` is the client
half of the daemon socket and the one spawner, `core/` owns the daemon, the store and every query,
`adapters/mcp` and `adapters/lsp` are two faces on the same service CLASS,
`providers/<language>/` are separate processes that only ever emit facts, and `formats/` holds one
reading of a data format for the providers that meet the same one.

The two faces are not the same INSTANCE. The MCP adapter answers from the daemon; the LSP adapter
still builds its own index in its own process. That is why it cannot write: a rename from there
would be invisible to the daemon's workspace gate and to any open refactor transaction, so it
refuses rather than writing behind their backs.

## The daemon

An MCP client starts and stops its server per session, and several sessions run at once, so the
index cannot live in the stdio process. That process is a thin client to a daemon that outlives it.

- **Discovery** is a lock file in the per-user state directory, keyed on a hash of the workspace
  path, or in a directory the caller names with `--state-dir`, which makes a store's directory its
  identity. It carries the port, a token, the pid, and the protocol version.
- **Starting** is a race the daemons run, not the clients. Any client that finds no live daemon
  spawns one, detached, through the client package's `ensureDaemon`, the one spawner every
  consumer shares. The daemon claims the lock with a hard link from a fully-written staging
  file, so the lock appears complete rather than half-written, and it claims BEFORE opening the
  store. A loser exits without ever touching SQLite, which is what holds the single-writer rule
  during the window where two of them exist. A foreign consumer's client changes none of this.
- **Warmup** is two passes. The first stores declarations and imports for every discovered root;
  the second fills full facts in the background, and a symbol query parses its own tree ahead of
  that queue. Requests are held, as retryable, until every root has been attempted at least once:
  a store whose last outline pass completed answers while discovery runs, a partial one waits for
  the roots it lacks. Imported modules outside the roots do not extend the wait. A pass that fails
  answers a plain error naming the reason. The LSP's local fallback indexes fully before serving.
- **Routing** gives a filename claim precedence, then a shared-extension claim whose evidence
  holds, then a plain extension claim, and last a fallback claim; equal claims contest.
- **Presence** is the connection itself. An open authenticated socket is a client; its close is
  that client leaving. A heartbeat covers the case TCP cannot see, where a peer is alive but hung.
- **Lifetime** is a countdown armed when the last client disconnects and disarmed by any connect.
  Nothing else stops it on its own.
- **Transport** is one JSON object per line over a local socket, with a request id so a slow query
  does not block the connection behind it. `core/src/socketTransport.ts` is the daemon half and
  the client package's `transport.ts` the client half, the only two modules that touch a socket,
  which is what makes a different runtime a rewrite of one file per side. The protocol package
  owns the daemon methods' shapes; core is the daemon half and the sole writer and validates both
  sides; the client package is the client half, for lexicon's own adapters and for any other node
  project. `docs/daemon-protocol.md` is the wire as a client sees it, `docs/client.md` the package
  a consumer holds.

## The runtime

Bun, and only bun, 1.4.0 or newer; node is not a runtime lexicon runs on. `client/src/runtime.ts`
is the one owner of that fact: `BUN_FLOOR`, measured against the whole gate and the build smoke
on the floor and on the newest bun (the CI matrix pins both), `runtimeVerdict` judging the
process from `process.versions` (a prerelease of the floor is below it; a version that does not
parse is not bun's), and `refuseRuntime`, the sentence an entry point prints before exiting.
`adapters/mcp/src/main.ts` and `adapters/lsp/src/main.ts` are bootstraps: judge, then import
`serve.ts`; the daemon, indexer and grader CLIs judge at the top of `main`. The build refuses to
bundle an entry point whose source lacks the call (`checkEntryGuards` in `scripts/build.ts`), the
conformance CLI excepted since a provider team runs it on their own toolchain.

A bundle's identity is its bytes. `bundleFiles` in the client is the one inventory of a root's
bundles (every regular `.js` under `dist/`); `bundleStamp` digests their contents into the
daemon's lock, so two copies of one release agree whatever their mtimes (two plugin hosts install
the same release side by side) and any rebuild, a provider's alone included, retires the daemon
serving the old copy. `core/src/drift.ts` asks the same inventory whether the newest bundle has
settled before the daemon hands over to a rebuild under it.

## Storage

SQLite in WAL mode: many readers, the daemon as sole writer. Reverse lookup is the reason. Nothing
at a definition records who uses it, so "who calls this" is a search in any design that does not
keep a dual inverted index, and an indexed read in one that does.

Two rules hold the design together:

- **The database is a fact store, never the algorithm.** SQL fetches candidate rows by index.
  Traversal, cycle finding and ranking are application code. No recursive CTEs.
- **The index is always derivable.** A schema mismatch or an unreadable file is a rebuild, never
  data loss, so no migration path has to be carried forever. The one exception is the knowledge
  layer: recorded answers cannot be regenerated from source, so they are salvaged across a rebuild
  with their subjects, and their citations heal on their own, because unchanged code mints
  identical fact ids. Every salvaged row is normalized to a closed value and placed through the
  identity owner's one placement method; a row it cannot read or place is a count in the daemon
  log, never a merge. A store written before subjects is re-keyed in place on first open.

A `files` row also carries git's word on whether the file is generated, three-valued: `yes`, `no`,
or `unknown` with the reason git could not say. The indexer asks git once per admission for every
candidate and once per import-closure round for what it reached past admission, writes the verdict
with the file's facts, and refreshes every stored row from the map before it prunes, so a file a
pass left unread carries the attributes as they stand. Reachability reads only a clean `yes`; the
knowledge layer's seeded fallback reads the rest (`docs/knowledge-layer.md`).

## Diagnostics

A daemon that dies of its heap leaves nothing to read on its own. Two owners change that.

- **`procfs.ts`**, in `client/` since a client judges a lock holder's liveness by the same read, is
  the only reader of `/proc`: a process's identity, its resident size and high-water mark, the
  host's memory. Null where there is no procfs, never a guess, and a residue test keeps the mount
  out of every other module in the client, core and the adapters.
- **`diagnostics.ts`** owns the collection in `diagnostics.json` beside the index: a ring of
  samples (the daemon's heap, every provider's RSS and high-water, what the daemon was doing), a
  ring of incidents (a provider death with its signal and last size), and a peak per process. It
  is rewritten whole, temp file then rename, on a rate limit and immediately on an incident or at
  shutdown, so it never grows with uptime and a reader never meets half a file.

The daemon watches its own resident size against the host's memory as procfs states it: the
runtime states no heap limit, and the OS kills at exhaustion. Crossing the high-water mark writes
one compact JSON to `reports/`, the sample with the resident size and the host's total, latched
until it falls back below the low-water mark; a limit set below the host's, a cgroup's, is not
seen. A heap snapshot beside it is opt-in,
`LEXICON_HEAP_SNAPSHOT=1`, at gigabytes each. A provider's death leaves an incident in the
collection with its signal and last size; nothing is asked of a provider while it lives. `reports/`
is created owner-only and pruned to the newest eight reports and two heap snapshots. The MCP tool
`project_diagnostics` reads the collection and the reports from disk by store key, no daemon needed.

The supervisor absorbs writes to a dead child. `vscode-jsonrpc` rethrows a failed pipe write into
a promise nobody holds, an unhandled rejection the daemon would die of. The death reaches the
caller through the typed `closed` rejection instead.

## Where a comment gets its meaning

Providers report comments as raw spans and say nothing about ownership. Deciding which symbol a
comment documents is position math over ranges this side already stores, so every provider doing it
would be another chance to disagree about one rule. `commentAttach` is that one place, and
`proseText` is the one place prose is normalized for search, for a document's regions as much as
for a comment.

It runs in the INDEXER rather than in the store, and that is the load-bearing choice. "Is there a
blank line between these two" is answerable only from the source text, and the indexer is the last
layer holding it. Inferring adjacency from stored endpoints instead is how a blank line becomes
invisible.

## Where a document's prose gets its meaning

The opposite arrangement, for the opposite reason. A comment's owner is a judgement call, so core
makes it. A document region's owner is the heading above it, which is not a judgement at all, so the
PROVIDER states it and `commentAttach` has no counterpart here.

That trade moves the risk rather than removing it. An anchor arrives as a string core did not
compute, so `replaceFile` refuses one that is not a heading declared in the same file before it
writes anything. Refusal rather than repair: a null anchor already means the region sits under no
heading, and reusing it for an anchor that failed to verify would hide a provider's contract
violation behind a legitimate answer.

The answer shape is why this is a table of its own rather than a column on comments. A comment
result names the symbol it documents; a document result names the heading PATH it was found under,
walked once in `headingPath` so no renderer rebuilds it.

Two provider conventions are supported rather than corrected: a declaration's range either already
covers its doc comment or begins on the line after it. A shared conformance case pins that there is
no third answer, because a range starting anywhere else loses every doc comment in that language
while nothing else goes red.

A code symbol's documentation is DERIVED from its leading-attached comment rather than stored beside
the declaration. Two copies of one sentence can disagree with the file, and this one is the file.

A HEADING documents itself differently, and the split is the point. Its prose is not a comment and
attaches by position with nothing to resolve, so it lives in the `docs` table anchored to the
heading above it. Both are prose about a symbol, both are citable, and neither is a second copy of
the file.

## Invalidation

A file event is decided against the stored content hash, so a save that changed nothing re-indexes
nothing, and a checkout restoring an old file is a hit rather than a miss.

Extraction depends on the file AND on the code that read it, so the indexer is hashed too. Without
that, a provider that changes how it classifies leaves every stored fact stale while no file has
moved, and nothing anywhere would say so.

Query results sit behind a cache keyed on a generation the index bumps on any change. Whole-index
rather than per-file on purpose: a reverse lookup consults every file, so the precise version is
harder to get right and barely narrower, and getting it wrong means serving a confidently stale
answer.

## Identity

Three id grammars, each with exactly one owner.

**Symbol ids** are SCIP-shaped: scheme, module, descriptors. Workspace-relative modules rather than
package-and-version, because a monorepo has no useful package identity. One module composes,
parses and inspects them, so no caller ever splits an id by hand.

**Fact ids** name a single row: a declaration, a reference, an import, a literal, a comment, a
document region, or an answer.
Identity IS content, so the digest covers every field including position. That makes resolving an
id and asking whether it changed the same operation, and it makes a citation that stops resolving
exactly a fact that moved. The cost is stated rather than hidden: a fact that merely moved gets a
new id.

**Subject ids** name what knowledge is about: an opaque identity minted once from a declaration's
first address and the clock, whose current address is a symbol id. Answers and gaps key by it, so
a move or a rename rebinds the address and no row changes key. `core/src/subjects.ts` owns the
table and every transition; `docs/knowledge-layer.md` has the rules.

## Cycles

Two problems that look alike and share no code. Import cycles are a graph problem, solved by
iterative Tarjan and reported as a finding, since a caller wants to know. Inference cycles inside a
provider are a fixpoint problem, solved by a recursion guard that returns Unknown and iterates; a
visited set alone returns an arbitrary answer rather than a correct one.

## Concurrency

A provider is a single request-response process, so the supervisor owns one queue per provider.
Serializing there means no call site has to know, and a slow request delays only its own language.
A provider that dies rejects its waiters at once rather than leaving each to time out in turn.

That queue orders one provider's calls, not the workspace. The daemon answers frames concurrently
and the watcher reindexes on its own schedule, so `WorkspaceGate` orders everything that writes:
refactor steps, undo and revert, rename, indexing, and watcher batches. Writers run alone; readers
that touch the filesystem run together but never during a write, so nothing observes the middle of
a multi-file change.

Acquiring the gate is the linearization point. A step takes its number, rechecks its hashes and
writes inside one hold, so two callers racing on the same file cannot both conclude their
preconditions still hold. Every daemon handler declares its effect, `read`, `write` or `staged`,
and only those three constructors mint a handler, so the dispatcher takes the gate by tag and a
bare function cannot sit in the table; a residue pins by name the few methods that take the gate
in parts, since a handler handed the gate may ignore it. A recall is a read, and the demand it
found is counted afterwards as the daemon's own write.

Nothing acquires the gate twice. Whatever a held operation calls runs already held, which is why
the service methods do not take it defensively.

The live index applies watcher batches one at a time on one promise tail, and the hourly knowledge
sweep is queued on the same tail under the same gate, so a sweep never runs beside a batch mid-parse
and a sweep queued when the live index stops never starts. The daemon holds one `Clock` and hands
the same instance to the store at open, the service and the live index, so every stamp, the
watcher debounce and the sweep timer read one time source, along with the ledger's stamps, the
transaction manager, the provider supervisor's timeouts and the transport's heartbeat; a residue
forbids a raw time read or host timer in every core module but `clock.ts`, so one fake clock
drives a whole daemon in a test.

## Refactor transactions

A transaction is a stack of steps over one workspace, at most one open at a time. Writes go to
disk as they happen, and `TransactionManager` journals what each file looked like first, so undo
and revert are restores rather than replays. `docs/provider-protocol.md` covers the provider half.

Snapshots are raw bytes in a content-addressed table, so a file that is not valid UTF-8 comes back
byte-identical and re-snapshotting an unchanged file costs a lookup. Two scopes are kept apart: the
baseline is what the transaction first saw and is what revert restores, while each step's images
are what undo restores. Collapsing them would make one of the two wrong.

Undo refuses when a file no longer holds what its step wrote. That check is what stops it eating a
manual edit made afterwards, and it is why every layer snapshots what it actually read rather than
the baseline.

The journal survives an index rebuild, because facts are derivable from source and an undo record
is not. A journal table that cannot be read fails the open rather than being treated as absent:
opening as though the transaction never existed would strand files already written to disk.

Recovery runs at startup before the daemon answers anything, and judges each file by what it holds
rather than by the phase alone. A file matching neither its before nor its after image belongs to
someone else and is reported as a conflict, never overwritten.

### Replacing a symbol

`LexiconService.planReplacement` does everything expensive and touches nothing: it splices the new
text into the file it read, asks the owning provider to parse the result, and compares that against
the index. The write happens separately, under the gate, and rechecks that the file still hashes to
what the splice was cut from. Planning outside the gate keeps a parse off the critical section;
rechecking inside it is what stops a plan being applied to a file that moved underneath it.

Two answers are refused rather than reported. Text that does not parse never reaches disk. A
replacement that renames its own declaration is sent to rename instead, since only rename rewrites
the callers and carries the recorded knowledge across. Deleting is allowed, because that is a real
refactor, and what still points at the deleted symbol comes back as an issue.

Issues are what the change broke, minus what was already broken. A name that fails to bind is only
reported when the reason says the index should have known it: a standard library call answers
ExternalDependency and a local answers NotIndexed, and reporting those made every ordinary edit look
like breakage. Subtraction is by name and role rather than by fact id, because a fact id contains
its range and any edit above an untouched problem would otherwise make it look new.

A provider that never declared `syntaxDiagnostics` yields a `SyntaxUnchecked` issue. Its silence is
not approval, and saying so is the difference between an unchecked replacement and a checked one.

### Moving

`LexiconService.planMove` works out the closure (the declaration plus everything declared inside
it), walks every reference in that range to build the dependency inventory, and lists the modules
whose imports name the moved symbol. Each involved module then gets one `moveEdits` request
describing only its own part: the source removes, the target inserts and imports what the body
needs, and each importer re-points its specifier. A blocked site anywhere fails the whole move,
because a relocated declaration whose importers still point at the old module does not build.

The target is created when absent, journaled as having not existed, so undo deletes it rather than
leaving an empty file behind. Reindexing puts the target first, so everything else rebinds against
a declaration that already exists in its new home. Recorded knowledge follows the same way a
rename's does: the address map is journaled with the step and applied once the files are written.

Whether the repair actually landed is asked of the reindexed facts rather than of the edits: a
specifier can be well formed and point nowhere, and that shows up as an importer whose reference no
longer binds.

Only the TypeScript provider implements `moveEdits` today. The others refuse `NotImplemented`, so
a move in those languages is declined rather than half-done.

### Renaming

A rename is one step of a transaction, journaled like any other, and it carries two things a plain
text rewrite would drop.

The first is recorded knowledge. A symbol id embeds its name, and a member's id embeds its
container's, so renaming a class re-mints its methods and their parameters too. `renameIdMap` builds
the whole old-to-new mapping from the id grammar before anything is written, since afterwards the
old ids resolve to nothing. The map is journaled with the step; once the files are written, the
transaction manager rebinds each subject to its new address and records what moved as rows the
journal's schema vouches for, so undo and recovery put it back, and name any move they could not.
A subject already at a destination stays, because it describes the code as it stands and
replacing it would be a silent downgrade.

The second is files that never change. A module calling a renamed class's METHOD contains no
occurrence of the class name, so it gets no edit, yet its stored references point at ids that are
about to stop existing. `modulesBoundTo` finds them and they are reindexed alongside the edited
ones, declaring module first so dependents rebind against declarations that already carry the new
ids.
