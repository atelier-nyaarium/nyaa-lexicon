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
- **Starting** is a race the daemons run, not the clients. Any client holding an install that
  finds no live daemon spawns one, detached, through the client package's `ensureDaemon`, the one
  spawner every consumer shares; one holding none rides a daemon that serves it and starts nothing. The daemon claims the lock with a hard link from a fully-written staging
  file, so the lock appears complete rather than half-written, and it claims BEFORE opening the
  store. A loser exits without ever touching SQLite, which is what holds the single-writer rule
  during the window where two of them exist. A foreign consumer's client changes none of this.
- **Warmup** is two passes. The first stores declarations and imports for every discovered root;
  the second fills full facts in the background, and a symbol query parses its own tree ahead of
  that queue. Requests are held, as retryable, until every root has been attempted at least once:
  a store whose last outline pass completed answers while discovery runs, a partial one waits for
  the roots it lacks. Imported modules outside the roots do not extend the wait. A pass that fails
  answers a plain error naming the reason. The LSP's local fallback indexes fully before serving.
- **Routing** gives a filename claim, or a shebang claim on an extensionless file, precedence,
  then a shared-extension claim whose evidence holds, then a plain extension claim, and last a
  fallback claim; equal claims contest.
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
settled before the daemon hands over to a rebuild under it. Which release beside another is the
newest has one owner, `newestInstallBeside` in `client/src/install.ts`: the daemon's drift asks it
for a sibling to hand over to, and `connect` asks it where the install record's release now is.

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

**What the index admitted is published, after it is written.** Once the core has asked for a parse,
any failure but a provider outage refuses it: a thrown request, an `error` diagnostic, `admitFacts`
reading an id the store cannot spell, or a store fault under the commit. Each leaves the file's
previous facts standing, so a provider filling its cross-file state from its own answer holds facts
the store does not, and binds names to symbols the store has never had. `core/src/indexer.ts` is the one publisher, through
`ProviderPort.admission`, and it publishes after `store.replaceFile` returns on the commit road and
after the failure is recorded on each refusal road, so a provider is never told a decision the index
has not taken. `admission-publish-residue.test.ts` holds the single owner and every ordering.

The verdict is whole-file because admission is: `admitFacts` throws on the first id it cannot read
and the store writes nothing, so there is no surviving subset to name. It names the provider that
ANSWERED the parse rather than whoever owns the module when it is published, unlike a forget, which
every provider hears: ownership can move between the two, and a newcomer has nothing staged to
settle. A provider outage publishes nothing, since the index keeps what it had and there is nobody
to tell. A parse the core never asked for publishes nothing either, which is why a file made
readable again with no watcher event stays out until something parses it.
`protocol/src/moduleStore.ts` owns provider state. See `docs/provider-protocol.md` for its
contract.

A `files` row also carries git's word on whether the file is generated, three-valued: `yes`, `no`,
or `unknown` with the reason git could not say. The indexer asks git once per admission for every
candidate and once per import-closure round for what it reached past admission, writes the verdict
with the file's facts, and refreshes every stored row from the map before it prunes, so a file a
pass left unread carries the attributes as they stand. Reachability reads only a clean `yes`; the
knowledge layer's seeded fallback reads the rest (`docs/knowledge-layer.md`).

## Reads

**A read derives its topology once.** `core/src/readContext.ts` builds a `ReadContext` from the
store at the top of a query and hands it down. It owns which declarations a module holds, how they
nest, which of them are local, which grouping stands above one, and the summary a declaration
answers as. Deriving one of those a second way is how two readers come to disagree about the same
file, so there is one derivation and every reader asks it.

**The context is a per-read memo, not a store snapshot.** It reads the store once per module and
once per id, and its first answer for each stands for the rest of that read. What keeps a read on
one generation of the index is the daemon's gate: `core/src/dispatch.ts` runs a query's answer
under the shared gate, alongside other readers and never inside a write, whether the handler is
tagged `read` or reaches the answer through `treeFirst` or `upgradedRead`.

**A replace or insert plan's context is read outside the gate, so it stamps what it read.** At the
first touch of a module, by id or by its rows, the context records the store's `stampOf` for it:
the depth the rows hold and the `indexedAt` their commit took. The stamp and the rows are read in
one synchronous span, and a commit is synchronous, so the stamp describes those rows. The plan
carries `context.seen()`, and the step's stale check inside the gate asks `factsMovedSince` beside
the hash check: a pump upgrade from outline to full facts, or a batch re-parsing unchanged bytes,
replaces every row of a module while its hash stays equal, and the hash check alone let a plan land
over a sibling set, a collision or an impact it never saw. Every commit's stamp is distinct:
`replaceFile` stamps the later of the clock and one past the newest stamp the store has written,
seeded at open from the rows it holds, so two commits of one module inside one millisecond still
read as two. A stamp a few milliseconds ahead of the clock reads as a later time to last-seen, the
prune and the ages.

**A reader that derives topology takes a context; one that does not reads the store.** `describe`,
`usesFrom`, `findReferences`, the two hierarchies, `mostReferenced`, `headingPath`, the scoped
searches, `factsFor` and `knowledgeScope` all ask about nesting, locality, containment or a
summary, so each mints one context and hands it down. `findByName`, `outline`, `declarationsIn`,
`fileNotes`, `commentsFor` and `docsFor` ask nothing about nesting: they answer rows the store
already orders, each summarized at most once, so a context would add an unused memo.

`core/src/locals.ts` holds the per-module `Containment` and `ancestryOf`, the one container walk
that a module's own rows and a store-resolved chain both take. `read-context-residue.test.ts` fails
the build where another module names a containment, calls that walk, declares a second summary,
reads `containerId` to answer a nesting question by hand, or reads `declarationsIn` outside the
readers it names as asking nothing about nesting, or compares a module's stamp by hand. The
refactor planner is not one of those: replace, insert, rename and move all ask their sibling,
collision, occurrence and dependency questions of a context, either minted per plan or, for rename
and move, minted once by the step in `dispatch.ts` and threaded through every planning read so one
context stamps the whole plan phase. `symbolIdsIn` is the one exception the context still answers:
a rename's id map and a move's closure walk the ID GRAMMAR (`isWithin`, `rebaseSymbolId`), never the
container walk, so the context stamps the module asked and hands the ids back unprocessed;
`read-context-residue.test.ts` names every reader of that token, and refuses one straight off the
store inside the planner.

The import rows a rename's edits or a move's dependency walk depend on are `ImportResolver`'s, not
the planner's own: `core/src/imports.ts` reads `importsNamed` and `importsIn` behind
`importSitesFor`, `importSitesForMove` and `importOriginFor`, each taking a `reads: ImportReads`
parameter that defaults to the raw store for a read-only caller (`knowledge.ts`'s own
`importSitesFor` call, unstamped, since it answers a fact set rather than a plan) and takes the
step's context for a rename or a move. `read-context-residue.test.ts` names every direct reader of
those two store methods, refuses either read straight off the store inside `imports.ts`, and pins
that every planning call in `refactorPlanner.ts` hands the resolver the context. A move's importer
is usually stamped twice over: once through `referencesTo` for the bound edge that put it in
`plan.referencing`, and again through `importsIn` for its import row, so the route exists to close
the class rather than an observed gap.

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
caller through the provider's request queue instead, which fails the request in flight and every
one waiting with the same typed error. Nothing per provider is raced against a request: a race
against a promise that lives as long as the provider keeps one reaction per request until the
provider dies, and `core/src/deadline.ts` is the one module that races at all, minting its own
second arm so nothing raced outlives the call.

A git call, the python provider's own helper and the runtime version probe all run through
`protocol/src/boundedChild.ts`'s `runBounded`, the one owner of a bounded, reaped child process:
spawned `detached`, bounded by a timeout that kills the whole process group and reaps it, since a
shell script's own forked helper can inherit the child's stdout pipe and outlive a plain
`child.kill`. The owner tracks every process group its own process spawned and kills what remains
on `process.on("exit", ...)`, registered once in the module, plus the daemon's own explicit
shutdown step for ordered cleanup; a SIGKILL of the owning process itself cannot be covered. The
provider supervisor (`core/src/supervisor.ts`) spawns long-lived providers instead of a single
bounded run, and is the one exception left outside the owner.

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
while nothing else goes red. A range may begin at the declaration's attached attributes, decorators
or annotations, with a doc comment ahead of them still covered; they stay outside the signature and
the selection range.

A code symbol's documentation is DERIVED from its leading-attached comment rather than stored beside
the declaration. Two copies of one sentence can disagree with the file, and this one is the file.

A HEADING documents itself differently, and the split is the point. Its prose is not a comment and
attaches by position with nothing to resolve, so it lives in the `docs` table anchored to the
heading above it. Both are prose about a symbol, both are citable, and neither is a second copy of
the file.

## Invalidation

A file event is decided against the stored content hash, so a save that changed nothing re-indexes
nothing, and a checkout restoring an old file is a hit rather than a miss.

The watcher asks before it reads. A path the scope admits as it stands, or the index holds, is
read once at the end of the burst; the rest are put to `git check-ignore` together, once per burst,
and what git ignores is never read. A service flushing its state into an ignored directory every
few seconds therefore costs one git call per burst and no batch. A batch whose every file hashes to
what the index holds returns before admission: no git, no provider, no sweep. A burst that never
settles is delivered at a ceiling rather than held until it does. A failed git call leaves the
previous verdicts standing: what the scope already admits stays admitted, and a path git could not
say anything new about is dropped from the batch rather than granted admission by the failure.

`check-ignore` and `check-attr` refuse a pathspec reaching into a submodule, and refuse the WHOLE
batch for it, so `core/src/fileScope.ts`'s `gitIgnored` and `generatedVerdicts` ask git about a
submodule's own root (found from its gitlink stage entry, mode `160000`) rather than a path
beneath it, fanning the root's verdict back out to every path the batch asked about under it.

A file whose last read failed is not retried by a batch that does not name it. The failure is about
that file's own bytes, so only its own event can mean they moved, and retrying it every batch reads
and refuses it again while nothing anywhere changed. It stays named in `overview` and in the failure
count, because it is still failing; what stops is the repetition.

Extraction depends on the file AND on the code that read it, so the indexer is hashed too. Without
that, a provider that changes how it classifies leaves every stored fact stale while no file has
moved, and nothing anywhere would say so.

Query results sit behind a cache keyed on a generation the index bumps on any change. Whole-index
rather than per-file on purpose: a reverse lookup consults every file, so the precise version is
harder to get right and barely narrower, and getting it wrong means serving a confidently stale
answer.

Two questions live behind two caches, because they turn over at different rates. `IndexCaches` in
`core/src/indexer.ts` names them. A stored ANSWER is drawn from facts and dies the moment any fact
moves. Where a SPECIFIER LANDS is not drawn from facts at all: a provider resolves it against the
files on disk and its own project model, so it survives every edit to a file's body. Its generation
turns over on three things and nothing else: a file leaving, a file arriving as a root the scope
admits, and an edit to a config file the provider named in `configFiles`. Held in one cache the
second question cost what the first does, which was a workspace of provider round trips on every
batch; with the split, an ordinary edit asks none.

Reachability walks a frontier: each round reads the imports of what the last round indexed, never
of everything seen so far. A module's imports do not change while the walk runs, so re-reading them
per round asked the same question once per round.

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

What core asks of that set is `ProviderPort`, declared where its callers live rather than by the
supervisor: the indexer, the service and the planner's probe take the port, and only the composition
root builds the class. A member core starts calling that the port does not carry fails the type
check at the caller, and adding one fails every test double until it answers, rather than surfacing
as a runtime break. The doubles are one shared
`fakeSupervisor`, which settles what the supervisor settles at the wire: an unowned or contested
module is refused, a provider that is not running is refused, a parse answer keeps its comments
only where the declared tiers say so, and every answer is parsed by its own schema.

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

Every indexing road takes it, one of two ways. A caller-held road, `indexFile` and `applyBatch`,
runs inside a hold its caller took around a unit larger than one file: a watcher batch, a refactor
step's reindex, a restore. A self-driven road, the warm scan, the full scan and the upgrade walk,
takes the gate itself, once per file, around the read, the parse and the commit together. Around
the read as well as the commit, because a parse of bytes read before another road committed newer
ones puts the file back when it lands, and nothing stored can order two parses after the fact: a
content hash is unordered and `indexedAt` stamps the commit rather than the read. Once per file
rather than once per road, because a scan re-reads a populated store while requests are served, and
one hold for a walk would starve every reader for its length. The gate is not re-entrant, so a
self-driven road reached from inside a hold deadlocks on its first file, which is why a symbol
answer upgrades its tree before taking the gate rather than inside it.

`LexiconService` builds the gate and exposes it. The dispatcher and the live index read
`service.gate` rather than being handed one, and neither takes an option for it, so a second gate is
unspellable: two of them order nothing against each other, and the one that ordered nothing was the
one a caller supplied while the service kept its own. `index-gate-residue.test.ts` holds all of it:
a self-gating road called from inside a hold, a parse in the indexer that belongs to neither class,
a caller-held road called with no hold around it, and a `WorkspaceGate` built anywhere in core but
the service.

The live index watches before the warm scan reads. `startLiveIndex` registers the watcher, then
starts the scan it is handed, so an edit under the scan is a batch rather than a fact nothing reads
again: the outline pass skips a full module whose hash is current, and the upgrade walk re-reads
only outline modules, so a full module edited between the pass's read and a later watcher start
stayed stale until its next edit. `applyBatch` refuses a batch under the outline pass, since one
would race the pass's loop over the same roots, so the live index holds what arrives until the scan
settles and releases it as one batch, coalesced to the last event per module in first-appearance
order, which bounds what a scan of any length leaves waiting. The hold is taken outside the gate,
or it would deadlock the scan's per-file holds. A scan that fails releases nothing and stops the
watcher: a batch would prune against roots a failed discovery never filled, and that index waits for
a restart.

Batches are applied one at a time on one promise tail, and the hourly knowledge sweep is queued on
the same tail under the same gate, so a sweep never runs beside a batch mid-parse and a sweep
queued when the live index stops never starts. The daemon holds one `Clock` and hands
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

A transaction records its origin. `refactor_start` opens an `explicit` one, which recovery leaves open
because a session may still be holding it. A standalone step opens an `own` one inside the gate when
none is open and commits it before answering, so nobody holds it after a crash: recovery closes it,
committed when its step finalized and reverted otherwise. A standalone step that finds one open joins
it and closes nothing, and its answer says which it did.

### What a writer reads

A writer splices decoded text and writes it back as UTF-8, so it reads through `writableSource` in
`core/src/sourceRead.ts`. That answers the text only when the decode was lossless: the text
re-encoded as UTF-8 equals the bytes read. A BOM decodes to U+FEFF and round-trips, so it is kept.
A module that is not valid UTF-8 is refused by name, since its U+FFFD would replace bytes nobody
edited. A binary or oversized module is refused too, rather than overwritten as though absent.
Text bound for a module passes `writableText` beside it: a lone surrogate encodes as U+FFFD, so
new text holding one is refused before a replace or an insert plans, and again at the write.

The planner reads this way for replace, the span replace, insert, move and rename edits. `writeAll`
reads every file this way before writing any, so one lossy file refuses a whole rename, and
`SourceWorkspace.writeModule` reads again at the write. A residue pins `writeSourceFile` to those two
and the journal's byte restore. Reads stay lenient: indexing, outlines and `symbolSource` answer the
decoded text.

### Replacing a symbol

`LexiconService.planReplacement` does everything expensive and touches nothing: it splices the new
text into the file it read, asks the owning provider to parse the result, and compares that against
the index. The write happens separately, under the gate, and rechecks that the file still hashes to
what the splice was cut from and that the rows the plan read still carry the stamp they were read
at. Planning outside the gate keeps a parse off the critical section; rechecking inside it is what
stops a plan being applied to a file that moved underneath it, or over facts the index committed
again while it planned. Insert rechecks the same two things.

The splice uses the one read its span was sliced from (`SourceWorkspace.symbolSourceRead`), never a
second one, so the range and the text it describes cannot come from two versions of the file.

`refactorReplaceSpan` adds the caller's expectation. `symbolSource` answers `spanHash`, the hash of
the text it returns, and the span replace refuses with `stale` when the span no longer hashes to it.
The plan checks the span on one exact read and the gate re-verifies that read, so an unchanged file
proves an unchanged span without re-resolving inside the gate. An edit elsewhere in the file before
the call does not refuse. It is a method rather than a field on `refactorReplace` because a daemon
strips unknown fields, and an older one would write unchecked.

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
leaving an empty file behind. `moveEdits` records the hash of every module it read, null for an
absent target, and the gate refuses when any no longer matches, so a target that changed or appeared
after planning is never overwritten. Reindexing puts the target first, so everything else rebinds against
a declaration that already exists in its new home. Recorded knowledge follows the same way a
rename's does: the address map is journaled with the step and applied once the files are written.

Whether the repair actually landed is asked of the reindexed facts rather than of the edits: a
specifier can be well formed and point nowhere, and that shows up as an importer whose reference no
longer binds. Which modules to ask is itself a claim: importers are found from stored references
and import sites, each written by the provider owning the file they are in, so a module whose
provider reports neither rides an `ImportersUnchecked` issue on the move rather than passing for a
file with nothing to repair.

TypeScript, Python and GDScript implement `moveEdits`. The other twelve providers refuse
`NotImplemented`, so a move in those languages is declined rather than half-done.

`refactorMove` in `dispatch.ts` mints one `ReadContext` and hands it into `planMove` and
`moveEdits`, so the declaration, the closure, the dependency walk and the referencing modules all
stamp through the same context, and the step's stale check inside the gate asks the context's
`seen()` beside the hash checks.

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

`refactorRename` in `dispatch.ts` mints one `ReadContext` before `prepareRename` and threads it
through `renameIdMap` and `modulesBoundTo` too, so the occurrence sites, the id map and the
stale-binding modules all stamp through the same context. The step's stale check asks the context's
`seen()` beside the hash check, refusing when the index committed the rows again under an unchanged
hash: a rewrite chosen from sites a re-parse has since moved would otherwise hit some occurrences
and miss others.
