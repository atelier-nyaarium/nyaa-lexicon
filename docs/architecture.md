# Architecture

Five packages. `protocol/` owns the wire types and the two id grammars, `core/` owns the daemon,
the store and every query, `adapters/mcp` and `adapters/lsp` are two faces on the same service
CLASS, and `providers/<language>/` are separate processes that only ever emit facts.

The two faces are not the same INSTANCE. The MCP adapter answers from the daemon; the LSP adapter
still builds its own index in its own process. That is why it cannot write: a rename from there
would be invisible to the daemon's workspace gate and to any open refactor transaction, so it
refuses rather than writing behind their backs.

## The daemon

An MCP client starts and stops its server per session, and several sessions run at once, so the
index cannot live in the stdio process. That process is a thin client to a daemon that outlives it.

- **Discovery** is a lock file in the per-user state directory, keyed on a hash of the workspace
  path. It carries the port, a token, the pid, and the protocol version.
- **Starting** is a race the daemons run, not the clients. Any client that finds no live daemon
  spawns one, detached. The daemon claims the lock with a hard link from a fully-written staging
  file, so the lock appears complete rather than half-written, and it claims BEFORE opening the
  store. A loser exits without ever touching SQLite, which is what holds the single-writer rule
  during the window where two of them exist.
- **Presence** is the connection itself. An open authenticated socket is a client; its close is
  that client leaving. A heartbeat covers the case TCP cannot see, where a peer is alive but hung.
- **Lifetime** is a countdown armed when the last client disconnects and disarmed by any connect.
  Nothing else stops it on its own.
- **Transport** is one JSON object per line over a local socket, with a request id so a slow query
  does not block the connection behind it. `core/src/socketTransport.ts` is the only module that
  touches a socket, which is what makes a different runtime a rewrite of one file.

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
  and their citations heal on their own, because unchanged code mints identical fact ids.

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

Two id grammars, each with exactly one owner.

**Symbol ids** are SCIP-shaped: scheme, module, descriptors. Workspace-relative modules rather than
package-and-version, because a monorepo has no useful package identity. One module composes,
parses and inspects them, so no caller ever splits an id by hand.

**Fact ids** name a single row: a declaration, a reference, an import, a literal, or an answer.
Identity IS content, so the digest covers every field including position. That makes resolving an
id and asking whether it changed the same operation, and it makes a citation that stops resolving
exactly a fact that moved. The cost is stated rather than hidden: a fact that merely moved gets a
new id.

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
preconditions still hold. Taking it is opt-in per call site, which was forgotten twice, so a
residue test now fails the build when a writing dispatch case sits outside it.

Nothing acquires the gate twice. Whatever a held operation calls runs already held, which is why
the service methods do not take it defensively.

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
a declaration that already exists in its new home.

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
old ids resolve to nothing. Answers and gaps move across it. An answer already written about the
destination is kept, because it describes the code as it stands and replacing it would be a silent
downgrade.

The second is files that never change. A module calling a renamed class's METHOD contains no
occurrence of the class name, so it gets no edit, yet its stored references point at ids that are
about to stop existing. `modulesBoundTo` finds them and they are reindexed alongside the edited
ones, declaring module first so dependents rebind against declarations that already carry the new
ids.
