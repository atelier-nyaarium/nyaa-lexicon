# Client

`@nyaa-lexicon/client` is the client half of the daemon socket and the one spawner: it finds the
lexicon install, judges it, gets the workspace's daemon running, and hands back a session typed by
the daemon's method table. It depends on `@nyaa-lexicon/protocol` and node built-ins only, never
opens the store, so any node project can bundle it. Lexicon's own daemon and adapters reach the
socket through it too, so two consumers on one workspace share one daemon. The wire itself is
`docs/daemon-protocol.md`.

## Connecting

`connect(options)` resolves to a `Session`. `ConnectOptions`:

```
workspaceRoot  the workspace whose daemon to reach; symlinks are followed, so a root reached
               through a link is the same workspace
stateDir       a store directory of the caller's choosing; the default is derived from the
               workspace under the state root
lexiconRoot    the install to spawn from, instead of the one last recorded
patience       how long a request waits on a starting daemon, in milliseconds; zero asks once
onWaiting      called once per waiting state with `waitingFor`, `retryInMs` and `elapsedMs`
```

Four things are read, in this order, and each can refuse before the next is touched:

1. **The record.** An explicit `lexiconRoot` wins; otherwise the root the install record points
   at. Neither: `NotInstalled`, `no lexicon is installed here`.
2. **The version file.** The root must hold both `dist/daemon.js` and `dist/version.json`.
   Otherwise `NotInstalled` naming the root: `not where lexicon was last seen: <root>` when the
   record pointed there, `no lexicon install under <root>` when the caller did.
3. **The refusal.** A client whose protocol major is ahead of the install's cannot be served by
   any daemon that install starts, so it fails as `Incompatible` naming both:
   `this client speaks protocol <ours>, the install at <root> speaks <theirs>`. An install ahead
   of the client is ridden. No lock has been read yet.
4. **The lock.** `ensureDaemon` reads the workspace's lock and applies `decideFromLock` (the rules
   are under Compatibility in `docs/daemon-protocol.md`) with "ours" being the INSTALL's build
   version and the stamp over every bundle under the install's `dist/`, never the consumer's own
   package. A
   spawn runs `bun dist/daemon.js <workspaceRoot>`, with `--state-dir <dir>` when one was given,
   detached, and waits up to ten seconds for a lock. Whatever leaves this step without a daemon
   is a `DaemonError` carrying the reason: the child's exit code and where its log is, an
   outgoing daemon that would not release its lock, a daemon serving another workspace.

The socket opens on the first question, not inside `connect`. Its welcome frame is judged again
there: a daemon behind the client's protocol major is refused as `Incompatible`, so a direct
connection cannot bypass the lock's rule. The one conversation that accepts an older daemon is
its retirement: `ensureDaemon` asks it `refactorStatus` and `shutdown`, which every major
answers, before spawning the install's own, since a daemon that cannot be asked to stop would
hold its workspace until it lingered out.

## Three versions

Three versions stay apart, and each pair has one rule. The client's own `PROTOCOL_VERSION` comes
from the protocol package it bundles; the install's from `dist/version.json`; the running daemon's
from its lock. Client against install is the refusal above. Install against daemon is
`decideFromLock`: ride a newer daemon within the major, retire an older one and spawn the
install's. Client against daemon is the welcome check.

## The install record and the version file

The record is `<stateRoot>/install.json`, `InstallRecordSchema`: `{ root, when }`, the checkout's
canonical path and epoch milliseconds of the write. `writeInstallRecord` stages it beside itself
and renames it into place, so a half-written record reads as no install at all. Two processes
write it: the MCP server at process start, before any registration and never fatally, and the
daemon at start, since a daemon runs without an MCP. `stateRoot` is per environment, so each
environment remembers its own install. The record only points: its root is trusted no further
than `dist/version.json`, `InstallVersionSchema`: `{ buildVersion, protocolVersion }`, whole
semver only, which the release build writes beside the bundles. A checkout that was never built
has none, which is what turns a moved checkout into `NotInstalled` rather than a spawn that dies.

## The session

Every entry in `DAEMON_METHODS` is a call on the session: `session.searchSymbols({ text })`,
`session.describe({ symbolId })`, one per table entry, built by one loop over the table's keys and
cast once to `Facade`, the mapped type `{ [M in DaemonMethod]: (params: RequestOf<M>) =>
Promise<ResponseOf<M>> }`. A wrong field or a method the table does not name fails to compile,
and the entry's doc line survives the mapped type, so hover shows it. Nothing on the facade is
hand-written, and the next daemon method costs one schema entry.

```
ask(method, params)  the method by name, for a caller holding the name rather than the call
close()              drops this session's connection; the daemon stays up for whoever else
                     holds one, since presence is the connection itself
stopDaemon()         closes the connection, asks the daemon to stop, and returns once its lock
                     no longer names it; a lock outliving ten seconds is a DaemonError
lock()               the lock of the daemon this session reaches, re-read on every call, since a
                     handover replaces the daemon under a session that keeps working
```

A session holds one lazy socket. A connection that drops is reopened once, through `ensureDaemon`
again, including a loss during the handshake, and a read is asked again over it. A write whose
request was already sent is not repeated, since the daemon may have applied it: it is a
`DaemonError` with cause `connectionLost` and an unknown outcome. The table's `mutates` flag is what
tells the two apart. A connection lost twice is a `DaemonError`.

## Errors

Every failure a session raises is one of three classes, so a consumer matches a class and never a
message.

- `NotInstalled`, with `root` when a root was found and refused: no record, or a root that no
  longer holds an install.
- `Incompatible`, with `client` and `installed`: the two protocol majors cannot meet, the
  install's before any lock, the daemon's at welcome.
- `DaemonError`, with a closed `cause` of `unknownMethod`, `refusedModule`, `spawnFailed`,
  `connectionLost` or `daemon`, plus `waitingFor` when a wait ran out.

An unbuilt install or missing Bun runtime has cause `spawnFailed`. An unsuitable workspace or a
startup timeout has cause `daemon`.

The first two are the client's own verdicts, reached before any daemon is asked. Anything else
the wire throws is wrapped as a `DaemonError`, so there is no fourth class to catch.

```ts
try { await session.describe({ symbolId }); }
catch (error) { if (error instanceof DaemonError && error.waitingFor) retry(); else throw error; }
```

## The warming wait

A daemon publishes its lock before it can answer. Until its index is open and its providers are
up, and again while the warmup pass has files it has not attempted, a request is answered
`starting` with the daemon's own countdown and what it is waiting for. The client re-sends every
250 ms until the earlier of that countdown and `patience`, five minutes by default, then fails as
`DaemonError`, `<the daemon's error> (gave up waiting on <waitingFor>; ask again later)`, with
`waitingFor` set. The countdown is the daemon's budget, published rather than mirrored, so the
normal bound is the daemon's and `patience` is the caller's backstop. `patience: 0` asks once: a
starting daemon is a `DaemonError` at once, for a caller with something better to do than wait.

## A store directory

A store directory holds everything one daemon owns: the lock `daemon.json`, `index.sqlite`,
`daemon.log`, `diagnostics.json` and `reports/`, all derived from the directory by `storePaths`.
The directory IS the store's identity: a different directory is a different lock, so a different
daemon, and one directory holds exactly one store. Two workspaces cannot share a directory: the
first daemon's lock names its workspace, and a second workspace finding it is refused rather than
served. A workspace can therefore hold a default store and any number of custom ones, each with
its own daemon. The daemon receives the directory as `--state-dir`, and a handover passes it on,
or the successor would claim a different store.

A directory that does not exist is created `0700`; one that does must already be the caller's
alone. `admitStateDir` refuses a path that is not absolute, a symbolic link (the store would live
where the link says, and the link can be repointed later), anything that is not a directory, a
directory owned by another uid, and one writable by its group or by everyone, with
`make it 0700 to use it`; permissions are never widened and never narrowed. On Windows neither
mode nor owner is judged. A daemon refusing its directory exits at once with the reason on its
stderr, which is the daemon log, and `connect` reports the exit as a `DaemonError`.

Lexicon's own MCP reaches such a store. `register_project` takes `stateDir` and records it in the
project's registry entry, unique by workspace and directory, and the default directory spelled out
is still the default store; `list_projects` shows a Store column once any project chose one and
names the store `<workspace>:<directory basename>`, which is what `bind_project` takes. The
management tools see it by directory: `list_project_stores` lists it as a custom directory, and
`project_diagnostics`, `stop_project_daemon` and `delete_project_store` take `store`, a key for a
default store or an absolute directory for any store, matched against that listing and never
joined from input. Deleting a custom directory removes lexicon's files and then the directory only
if nothing else is left in it.

## The helpers

Two hand-written members sit beside the facade, each a composition a consumer would otherwise
copy. `resolveChain(module, segments)` asks `moduleDeclarations` once (one snapshot: the read,
both hashes and the rows) and walks a name chain inside the module. Every answer carries
`contentHash`, the hash the index holds, and `diskHash`, the hash of the file as that read found
it, so a consumer knows whether the ranges it was handed describe the file on disk. The answer is
`exact` with the one candidate, `ambiguous` with every candidate in document order, or `none`
with a closed `reason` in this precedence: `missing` (not on disk), `binary` or `tooLarge` (with
`detail`), `unclaimed` (no provider owns it, or the scope denies it, `detail` saying which),
`parseFailed` (a recorded failure and no rows; a file whose outline pass succeeded and whose full
upgrade failed still resolves at outline depth), `unread` (owned, not indexed yet) or `noMatch`. A
`none` also says where the walk stopped: `matched` is `{ containerPaths, consumed, count }`, the
paths the walk stood on, how many segments it consumed and how many matches the failing segment's
base name had; `available` is every declaration name beneath that frontier (every name in the
module when nothing matched), deduped in document order and capped, with `availableTotal` beside
it.

The first segment matches any declaration in the module and each later one any declaration
beneath the previous candidates, however many unnamed layers sit between, or a descriptor prefix
their ids pass through: an out-of-line C++ definition `Physics::World::step` names its scope in
its id without declaring it, so `Physics`, `World`, `step` walks it split, `Physics::World::step`
joined, and `Physics`, `step` across the layer. A segment is a name; a dotted or `::` run such as
`Acme.Services`, matching a declaration named so in either spelling or a run of nested names;
`name[n]`, the n-th match in document order counted from 1; `arguments`, the previous candidate's
parameter list as one span from its first parameter to its last, carrying the owner's id and no
selection range; or, after `arguments`, one parameter's name. A run of segments also matches a
declaration named by the run joined (`Acme`, `Services` reaches `Acme.Services`), never a proper
prefix of one (`Node` does not reach a heading `Node.js setup`): the plain fold is tried first,
then the joined readings, and a tie across readings is `ambiguous`. A candidate carries
`symbolId`, `kind`, `name`, `range`, `selectionRange` where the name is in the source,
`containerPath`, outermost first, and `segments`, a chain that resolves to exactly this candidate
(the container names as written, the last with `[n]` where the path alone is ambiguous), so a
consumer can offer a paste-ready ref for each candidate of an ambiguous answer. Ranges are the
protocol's, 0-based, unconverted. Ambiguity is a list, never an error.

Two ordinal readings sit side by side and count differently. The id grammar's `name[n]` numbers
same-named siblings of one container from 2, an identity minted by the provider; the chain's
`[n]` numbers the matches of a segment across depths from 1, in document order, an address a
reader types. `segments` uses the chain's.

`awaitIndexed(module)` indexes one module now, under the daemon's write gate, and answers
`{ indexed: true }`, also for a file already indexed at this depth, or `{ indexed: false }` with a
`reason` sharing `resolveChain`'s: `missing`, `binary`, `tooLarge`, `unclaimed` or `parseFailed`,
with `detail` carrying the provider's or the reader's words. A content refusal is an answer;
only a provider outage, an indexer `fault`, or an outcome without a cause, is a `DaemonError`.

## The runtime

The package runs under node or bun; the daemon and providers it spawns run under bun 1.4.0 or newer
only. `bunExecutable(host, probe)` selects the running bun, PATH bun, or `BUN_INSTALL/bin`, probes
`--version` once per process, and returns a closed missing, malformed or below-floor result.
The owner of that floor is exported for a consumer that wants the same judgement: `BUN_FLOOR`,
`runtimeVerdict(versions?)` answering `bun`, `belowFloor` with the floor, or `notBun` naming what
it is, and `refuseRuntime(what)`, the sentence lexicon's own entry points print before exiting,
or null when the runtime is accepted. `bundleStamp(root)` and `bundleFiles(root)` are the bundle
identity the lock carries, described under Compatibility in `docs/daemon-protocol.md`.

`classifyWorkspaceRoot(path)` answers before spawning whether the path is the filesystem root or
the caller's home directory. The install source is a thunk re-derived for each ensure, channel,
lock and stop invocation, so rebuilds and removed installs are observed immediately. A stale
install looks like a `DaemonError` or `Incompatible` before a request reaches the daemon.

## Depending on it from a git submodule

The client and the protocol package are imported as source through the consumer's own bun
workspace, with this repository checked out as a submodule. The consumer's root `workspaces` lists
`<submodule>/protocol` and `<submodule>/client` and nothing else from the submodule, so
`@nyaa-lexicon/client` resolves by name and its `workspace:*` dependency on protocol resolves too;
its tsconfig references the two projects and its linter ignores the submodule. The client has no
`bun:` import, so bundling it is safe. The daemon still comes from the installed lexicon through
the record, never from the submodule, and the refusal in step 3 covers a submodule newer than it.

## A complete consumer

```ts
import { connect } from "@nyaa-lexicon/client";

const session = await connect({ workspaceRoot: "/home/me/project" });
const found = await session.searchSymbols({ text: "Router" });
const hit = await session.resolveChain("src/router.ts", ["Router", "handle", "arguments", "req"]);
session.close();
```
