# Architecture

Five packages. `protocol/` owns the wire types and the two id grammars, `core/` owns the daemon,
the store and every query, `adapters/mcp` and `adapters/lsp` are two faces on the same service, and
`providers/<language>/` are separate processes that only ever emit facts.

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
