# Daemon protocol

One daemon per workspace holds the index, and everything that asks it a question is a thin client
speaking this wire: the MCP adapter, the editor adapter, and any project that depends on
`@nyaa-lexicon/client`, which speaks it on their behalf (`docs/client.md`). This document is the
wire itself: how a daemon is found, what crosses the socket, and what a client may assume about a
daemon it did not start. The other wire, between
the daemon and its language providers, is `docs/provider-protocol.md`.

## The lock file

A workspace's daemon publishes itself in one file, `daemon.json`, in the workspace's state
directory. `stateRoot` is `$XDG_STATE_HOME/nyaa-lexicon`, falling back to
`~/.local/state/nyaa-lexicon`, and `%LOCALAPPDATA%\nyaa-lexicon` on Windows. `workspaceKey` names
the directory under it as the root's basename plus sixteen hex digits of a SHA-256 over the
canonical root path, so two checkouts sharing a name cannot collide and the directory is still
recognizable by eye. `canonicalRoot` follows symlinks first, so a workspace reached through a link
is the same workspace. `storePaths` derives every sibling from the same key, `index.sqlite`,
`daemon.log`, `diagnostics.json` and `reports/`, and nothing else builds a state path.

The lock is `DaemonLockSchema`:

```
port             localhost port, chosen by the OS at bind
token            48 hex characters, presented on every connection
pid, pidStart    the holder, and its birth ticks where the platform offers them
protocolVersion  what the daemon speaks
buildVersion     which release it runs, which decides its method table
bundleStamp      a digest of every bundle's bytes under dist/, so a rebuild inside one version is noticed and two copies of one release agree
workspaceRoot    the canonical root it serves
startedAt        epoch milliseconds
```

`pidStart` is what stops a reused pid from reading as a live daemon: `lockHolderAlive` requires
the process to answer AND to still be the process that wrote the file.

The claim is a race the daemons run, not the clients. A starting daemon binds port zero on
`127.0.0.1` first, because the lock carries the port, writes the lock to a staging file beside it,
and hard-links the staging file into place. A link lands whole or fails with `EEXIST`, so no reader
ever meets half a JSON. On `EEXIST` it reads the holder: alive means this daemon lost, and it closes
its socket and exits before ever opening the store; dead means the stale file is renamed away and
the link retried, four rounds at most. The claim happens BEFORE the store opens, which is what holds
the single-writer rule while two daemons exist. On stop, the daemon removes the lock only if it
still carries its own token, and removes it before closing the socket, so a client cannot read a
lock naming a dead port.

## The socket

One JSON object per line, UTF-8, newline-terminated, both directions, over that localhost port.
Framing is the only thing the transport does: `JSON.parse` does the parsing, and every frame is
checked against `ClientFrameSchema` or `ServerFrameSchema` on arrival. A line that is not JSON, or
not a frame, destroys the socket; there is no id to answer, and a peer sending one is broken either
way. A line past the cap, 8 MiB read by the daemon and 512 MiB read by a client since responses
carry real result sets, ends the connection the same way.

**Hello and welcome:** the client's first frame is `{ kind: "hello", token }`, within ten seconds
of connecting or the daemon closes the socket. A wrong token is answered
`{ kind: "reject", reason: "bad token" }` and then closed, so a bad token is distinguishable from a
crash, and nothing else is said to an unauthenticated peer. The right token is answered
`{ kind: "welcome", protocolVersion }`, after which requests may flow. `connectFrames` resolves on
welcome and gives up after five seconds without one.

**Request and response:** `{ kind: "request", id, method, params }`, with `id` a client-chosen
non-negative integer echoed on the answer, so a slow query never blocks the one behind it. The
daemon answers frames concurrently and the id is the only correlation. `params` may be absent,
which the daemon reads as `{}`. The answer is `{ kind: "response", id, ok: true, result }` or
`{ kind: "response", id, ok: false, error }`, where `error` is the message of whatever the handler
threw. An error frame may also carry `starting`, `retryInMs` and `waitingFor`, covered below.

**Ping and pong:** every thirty seconds the daemon sends `{ kind: "ping", n }` and the client
answers `{ kind: "pong", n }`. Any frame from the client resets its silence counter, and a client
silent through two ticks is destroyed. That is the case TCP cannot see: a peer alive but hung.

Presence is the connection itself. An open, authenticated socket is a present client, and the count
of them is what the daemon's lifetime runs on: a thirty-minute countdown armed when the last one
disconnects, disarmed by any connect, and held while a request is in flight or a refactor
transaction is open. A session that asks many questions holds one connection, `daemonChannel`; a
caller that asks once and exits uses `requestOnce`.

## Starting

A daemon publishes its lock before it can answer, on purpose. Publishing after the first scan meant
no client could find the daemon for the length of a scan, so every session paid that scan in its
own process. Until the handler is installed (`waitingFor` is `opening the index`, then
`the language providers to start`), and again while the warmup pass has files it has not attempted
(`the warmup pass`), a request is answered with an error frame carrying `starting: true`,
`retryInMs` and `waitingFor`. The countdown is the DAEMON's own budget, published rather than
mirrored on the client, since two independently chosen numbers cannot stay in agreement.

`connectFrames` handles this inside `request`: while `starting` is set and `retryInMs` is positive
it re-sends every 250 ms, under a five-minute ceiling that exists only as a backstop against a
countdown that never reaches zero. When the daemon's countdown runs out, the caller sees
`<message> (gave up waiting on <waitingFor>; ask again later)`. A warmup that failed is not a hold:
it answers a plain error, `warmup failed: <reason>; restart the daemon`, to everything but
`refactorStatus` and `shutdown`, so a daemon in that state can still be retired. A provider
outage during the pass fails it, since a restart heals an outage; a fault on one file is recorded
against that file and the pass serves.

A daemon that finds its lock gone, or rewritten by another pid, refuses the request that noticed
with `...; this daemon is stopping`, closes its server, and every client lands on its reconnect
path. `daemonChannel` reconnects once on a lost connection, through `ensureDaemon` again, and gives
up if the connection is lost twice. Only a read is asked again after its request was sent; a
method the table marks `mutates` may already have landed, so its loss is reported as
`connectionLost` with the outcome unknown rather than repeated.

## The method table

`DAEMON_METHODS`, in the protocol package, is the one owner of what the daemon answers:
fifty entries, each a method name with a `request` schema and a `response` schema, in
dispatch order, with a doc line on every entry. The twelve whose repetition is not harmless, the
knowledge writes and the refactor steps, carry `mutates: true`, read through `methodMutates`;
`indexFile` writes the store too, but asked twice it answers `current` the second time, so it is
not marked. Nothing else in the table is optional. `hubs` is its own entry aliasing `mostReferenced`,
so the accepted method set is exactly what older clients ask by. Four types derive from it, and
nothing else is hand-written:

```ts
type DaemonMethod = keyof typeof DAEMON_METHODS;
type RequestOf<M extends DaemonMethod> = z.infer<(typeof DAEMON_METHODS)[M]["request"]>;
type ResponseOf<M extends DaemonMethod> = z.infer<(typeof DAEMON_METHODS)[M]["response"]>;
type ReadMethod = every DaemonMethod whose entry is not marked mutates
```

`ReadMethod` is how a read-only face is held to its word: the editor adapter asks through a
function typed by it, so a write asked from there fails to compile.

`DaemonChannel.ask<M>(method: M, params: RequestOf<M>): Promise<ResponseOf<M>>` is typed by them,
and a facade built by one loop over the table's keys is what a client library looks like. The doc
line survives the homomorphic mapped type, so it is what an editor shows on hover. A method costs
one schema entry: core's handler map `satisfies` the mapped type over `DaemonMethod`, so an entry
without a handler, or a handler without an entry, fails to compile.

The shapes the schemas name, `StoredDeclaration`, `SymbolSummary`, `Answer`, `RenamePlan`,
`TransactionStatus` and every `...Result`, live in `daemonShapes` beside the table, and core's
modules take their types from there, so a store row that crosses the wire cannot drift from what
the wire says it is. `ImportResolution` and `TypeInfo` are the provider protocol's types and are
reused as they are.

Every object in the shapes is a plain `z.object`, which strips unknown keys. On the daemon that IS the contract:
nothing leaves that the table does not name. On a client it means an older build drops the fields
a newer daemon added, which it could not have typed anyway. No `strict`, no `passthrough`, one rule.

One method is not in the table. `shutdown` is answered by the daemon process itself, before
dispatch, with `{ stopping: true }` sent before it stops so the caller reads success rather than a
dropped connection.

### One read binds an answer to its bytes

`moduleDeclarations` answers one module's status (`exists`, `claimed`, `indexed`, `depth`, the
recorded `failure`), what one read of the file found (`read.kind`: `text`, `missing`, `binary` or
`tooLarge`, with `detail` for the last two), `contentHash` (the hash the index holds, null with no
row), `diskHash` (the hash of the bytes that same read loaded, null unless text) and the
declaration rows, from ONE synchronous snapshot: `core/src/moduleDeclarations.ts` runs to
completion, a residue forbids `await` and `async` in it, so no field describes a different
version of the file than another. `moduleStatus` and `declarationsIn` keep their shapes as older
views of the same store, each answered on its own; a consumer that wants "cannot disagree" asks
the one method. `fileNotes` is a different question, the diagnostics the snapshot does not carry.

The hash is `hashContent` in the protocol package, the one implementation the daemon files under
and a consumer compares against: the first 32 hex characters of the sha256 of the file's UTF-8
DECODED text. A BOM and CRLF are part of the text; the result equals a hash of the raw bytes
exactly when they were valid UTF-8. A residue forbids a second `createHash(` over text in core and
the client.

`indexFile` answers a closed `cause` beside its prose whenever it did not index, absent when it
did: `missing`, `binary`, `tooLarge`, `unclaimed`, `parseFailed`, `current` (the index already
holds this version), `providerDown` or `fault` (the indexer failed while handling the file).
A provider's parse failure is an answer, not an error frame, so a caller reindexing a restored
file is not failed by it; only a provider outage is the daemon's own trouble.

## Validation, both directions

`createDispatch` is the one place a request meets the table, and it does three things in order. A
method not in the table is refused with `unknown method: <name> (this daemon runs <build>)`, naming
the build because that is what decides the table. The params are parsed through the entry's
`request` schema, so a bad request is refused before any handler runs. The handler's answer is
parsed through the entry's `response` schema before it reaches the frame writer, and a failure
there throws like any other error, which the transport turns into an error frame. Both parses are
always on.

Every path-valued request field (`module`, `toModule`, `fromModule`) is the `ModulePath` schema:
a transform through the id grammar's `normalizeModulePath`, so `./src/a.ts`, a backslash path and
an NFD filename are served under the one key the index files them by, and an absolute path, a path
escaping the workspace or one carrying a control character is refused in the grammar's own words
before any handler reads or writes. That is workspace containment: nothing the wire names can
reach a file outside the root, `refactorTrack` included. Filters (`within`, substring and regex
matches) are not paths and are left alone. No case folding and no realpath at query time: two
names are two modules, and a file the grammar cannot spell is out of scope rather than indexed
under a key nobody can ask by. Two names that normalize to ONE key (a composed and a decomposed
spelling of the same filename, both on a case-sensitive disk) are one module; the composed file
is the one read and indexed, and the other is unreachable by name. A write lands under the real
root: a directory link inside the workspace pointing outside it is refused for writing, while
reads follow the name as given.

To the caller, either failure is the same thing: the promise from `request` or `ask` rejects with a
`DaemonError` whose message is the daemon's `error` string. For a request that did not fit its
schema that string is `<method> refused: <field>: <what was wrong>`, lexicon's own words, never a
zod issue list; a module path that leaves the workspace is the same sentence with cause
`refusedModule`. An agent driving the MCP adapter sees it as the tool's error text. A malformed
answer therefore reaches nobody: the daemon reports it against the method that produced it, and a
client that cannot read an answer names the field it stopped at, instead of shipping an object that
the client's types say cannot exist.

## Compatibility

A client reads the lock and asks `decideFromLock` what to do. The answer is one of three values, so
there is no fourth outcome to invent: `connect`, `spawn` with a reason, or `replace` with the lock,
a reason and a cause. The rules, in the order they are applied:

- No lock, unreadable JSON, or a file that does not match `DaemonLockSchema`: spawn.
- The holder is dead: spawn. A dead pid is never a replace, since there is nothing to stop, and a
  crashed daemon would otherwise look alive for as long as its file survived.
- The lock names another workspace: replace, cause `otherWorkspace`. This one is reported and never
  acted on, because that daemon is answering correctly for somebody else.
- A different protocol major: connect if the daemon's is newer, otherwise replace, cause `protocol`.
- A different build: connect if the daemon's is newer, otherwise replace, cause `build`. Ordered
  rather than exact, because method tables only grow within a protocol major, so a newer daemon
  serves this client's whole table, and two builds retiring each other would rebuild the index on
  every flip.
- The same build but a different bundle stamp, when this side has a bundle to compare: replace,
  cause `build`. A rebuild inside one version leaves a daemon serving older code.
- Otherwise connect.

**Clients ride forward and retire backward.** Riding forward is why removing or renaming a method
costs a protocol major: a client connects to a newer daemon on the premise that everything in its
table is still answered, and the day that premise fails it fails as `unknown method` from a daemon
the client chose to keep. A new method or a new optional field is a minor. `PROTOCOL_VERSION` is
the one number both rules read, and the welcome frame carries it so a client that reached the
socket some other way still learns what it is talking to.

`ensureDaemon` carries the decision out. A replace first asks the outgoing daemon `refactorStatus`
and retires it only on a clear `open: false`, since an open transaction holds the only copy of the
images its undo would restore, and anything unclear leaves it running. It re-checks that the pid is
still the holder at the last moment, sends `SIGTERM`, and waits up to ten seconds for the lock to
vanish, refusing to spawn over one that has not, because the newcomer would lose a claim it must
lose and report the confusion as its own. A spawn runs `bun dist/daemon.js <root>` detached, with
its stdio in `daemon.log`, and waits up to ten seconds for a lock to appear, reporting the child's
exit code if it dies first.

The daemon keeps itself current from the other side. Between answered requests it notices a newer
bundle in the checkout it was started from, and with nothing in flight and no transaction open it
releases its lock and socket and spawns its successor with `--warm`, so nobody notices the swap.
