# Questionaire

## Question 1 - What is the instrument for?

Q: Lexicon exceeded 4 GB and crashed in real 2.x usage. What must the instrument answer?
A: Which process held the memory, what it was doing when it died, and what was retained.

> now in real 2.x usages, I have had Lexicon exceed the 4gb and crash.

4 GB is V8's default old-space ceiling, so the crash is one node process reaching its heap limit.
Every process here runs on node in the shipping artifact: the daemon, and every provider, which
`discoverProviders` launches as `[process.execPath, bundle]`. The first question is WHICH, and
nothing today records it: the daemon log carries the provider's stderr, unstructured, and nothing
else.

## Question 2 - Where does the data go?

Q: A log stream, or a bounded collection?
A: A bounded JSON collection, rewritten in place. Never appended.

> have it write json somewhere as a collection, not an infinite stream.

One file per workspace in the state directory, `diagnostics.json`, holding a ring of samples, a
ring of incidents, and per-process peaks. Written atomically (temp file, rename) at a bounded rate.
Node's own crash reports land beside it in `reports/`, pruned to the newest few, so that directory
is bounded too.

## Question 3 - Does this need a protocol change?

Q: Ask each provider for its memory over the wire, or observe it from outside?
A: Observe from outside. No protocol change, no provider edit.

The supervisor spawns every provider and knows its pid, so `/proc/<pid>/status` answers RSS and
high-water for any runtime at all. Node's report flags go on the command line the supervisor
already builds, so a provider learns nothing and changes nothing. Eleven providers stay untouched.

## Question 4 - What finds the retainer?

Q: Samples say which process and when. What says what was held?
A: Node's diagnostic report, always on, and a heap snapshot, opt in.

`--report-on-fatalerror` writes a compact JSON report at the moment of the OOM: the JS stack, heap
space sizes, the limit. Probed on this node: `trigger: "OOMError"`, exit 134, 18 KB. That is cheap
and bounded, so it is always on. `--report-on-signal` with `SIGUSR2` lets the daemon ask a child
approaching the limit for the same report while it is still alive.

A full heap snapshot names the retaining path but costs gigabytes of disk and minutes to write, and
can itself tip the process over. That is opt in, `LEXICON_HEAP_SNAPSHOT=1`, for a targeted
reproduction once the samples have named the process.

# Plan

## Phase 1 - The collector ✅

Shipped across `f426776`, `36c388f`, `acec0be`, `012194c` and `9576f2d`, each audited and pushed
green. The docs Phase 2 had claimed (architecture section, changelog, README, CLAUDE.md) landed
here too, so Phase 2 is the tool alone.

One owner for procfs, one owner for the diagnostics file, and the daemon wired to both.

**`core/src/procfs.ts`, the sole reader of `/proc`.** `parseProcStat` and `processIdentity` move
here from `client.ts`; `client.ts` and `daemon.ts` import `processIdentity` back. New: `processMemory(pid)` reading `VmRSS` and
`VmHWM` from `/proc/<pid>/status`, and `hostMemory()` reading `MemTotal` and `MemAvailable` from
`/proc/meminfo`. Each answers `null` where there is no procfs, never a guess. A residue test forbids
the token `/proc/` anywhere else under `core/src`. Plant the violation first.

**`core/src/paths.ts`** gains `diagnosticsFile` and `reportsDir` under the workspace directory. No
call site builds either path.

**`core/src/supervisor.ts`** reports a death with its signal as well as its code, and exposes
`observeExits(listener)` so a subscriber learns `{ providerId, pid, code, signal }` without the
supervisor knowing what diagnostics are. A death is a SERVING provider's: one that dies before its
first handshake completes is a start failure, which `startProviders` reports and the daemon logs,
since there is no provider id to name yet. A respawn that dies in its handshake is announced.

The supervisor also ABSORBS writes to a dead child. `vscode-jsonrpc` rethrows a failed pipe write
into a promise nobody holds, an unhandled rejection the daemon's handler shuts it down for, and on
a slow machine a request lands in the dead pipe between the kill and its exit event (the hosted CI
runner hit it on the first push). The child's stdin is wrapped so writes succeed silently and a
pipe error marks the provider unavailable, so an in-flight request rejects typed through `closed`.

**`protocol/src/residue.ts`** owns the source sweep every residue test used to carry a private copy
of, eight copies with one already drifted. A test keeps its roots, skips, owners and the rule; the
sweep and the comment stripping are shared. Test tooling, exported beside the conformance suite.

**`core/src/diagnostics.ts`, the sole owner of the collection.** Zod schema for the file, so the
reader and the writer cannot drift. A `DiagnosticsCollector` taking injected clock, timers, process
reader, signaller and file root, in the shape of `lifetime.ts`, so every test decides rather than
waits.

- A sample every 10 s: the daemon's own `process.memoryUsage()` (rss, heap used and total, external,
  array buffers) and its heap limit from `v8.getHeapStatistics()`, every running provider's RSS and
  high-water from procfs, and a context the daemon supplies: index state and progress, requests in
  flight, connections.
- Ring of 360 samples. Ring of 20 incidents. Peaks per role, never rung.
- An incident on every provider exit the supervisor reports: when, which, code, signal, the last
  sample's context and the provider's RSS in it.
- The file is rewritten at most every 30 s, and immediately on an incident and at shutdown.
  Temp file then rename, so a reader never sees a partial write.
- `host.nodeHeapLimit` is the daemon's own `heap_size_limit`. Every provider starts from the same
  executable with no heap flag, so it is the limit they all share, and the file says so.
- High water: a provider whose RSS crosses 85% of that limit is sent `SIGUSR2` once, re-armed when
  it drops below 60%, so its report lands while it is still alive. POSIX only; elsewhere the file
  records that the signal is unavailable. The daemon writes its own report through
  `process.report.writeReport` at the same crossing.
- The signal goes THROUGH THE SUPERVISOR, never a bare `process.kill`: the child handle cannot
  reach a reused pid, and a process that never installed the handler would die of the signal, so
  the supervisor refuses any signal a spec did not declare in `handles`. The bun dev path declares
  none and is never signalled.
- `reports/` is pruned after every write and again at setup: the newest 8 node reports, and the
  newest 2 heap snapshots when the opt-in is on, so the directory is bounded either way, including
  for a daemon that dies before its collector's first write. Setup also tightens an existing
  directory to 0700.
- `nodeReportSetup(reportsDir)` answers the argv that turns on `--report-on-fatalerror`,
  `--report-on-signal`, `--report-signal=SIGUSR2`, `--report-compact` and the directory, plus the
  heap snapshot flags when `LEXICON_HEAP_SNAPSHOT` is set, and the signals that argv makes the
  child survive.
- A node report carries EVERY environment variable, an agent's API keys included. Where node can
  leave them out (`--report-exclude-env`, node 22.13 and newer; the floor is 22.5) it is told to,
  along with the network interfaces, and the collection records `host.reportsExcludeEnv` so a
  reader on an older node knows the reports beside it carry the environment. `reports/` is
  created owner-only, 0700, either way. Asked of the daemon's own node, which is the children's.
- Nothing in the report path is fatal to any caller: `nodeReportSetup` and `enableSelfReports`
  never throw. A reports directory that cannot be made answers empty argv and a stated `failure`,
  which the daemon and the LSP log, and the providers start without the flags. A signal the supervisor would not
  deliver is logged once per crossing and stays latched, so it is not retried every sample.
- A clock stepped backwards counts as a write being due, or writes would stall until it caught up.
- `readDiagnostics(key, host)` reads the file back through the schema, for the surface in Phase 2.

**`core/src/providers.ts`**: `ProviderCommand` carries `runtime: "node" | "bun"`, and
`startProviders` takes `options.node`, whose argv is inserted after the executable for node
commands only and whose `handles` become the spec's.

**`core/src/daemonCli.ts`**: sets `process.report` on itself before anything allocates (on by
default; a failure to set it up is logged, never fatal, since diagnostics must not take the daemon
down), starts the collector after the providers, feeds it the context, writes on shutdown. Exits announced before the collector exists
are held and replayed into it, so a death during startup is still an incident. The LSP adapter passes the report flags too,
since it runs providers in its own process; it runs no sampler, because two writers of one file is
the thing the single owner forbids.

Tests: ring bounds, peak tracking, incident capture from a REAL supervisor exit through
`observeExits`, write rate limit and immediacy on incident, a failed write leaving the previous
file intact, a failing sample source contained, high-water latch, prune on every write, procfs
parsers from literal text, schema round trip, the signal refused for an undeclared handler, node
argv on node commands only, the exact file names.

## Phase 2 - The surface and the record ✅

Shipped across `359bbf9`, `6a8d455` and `fb9b01e`, each audited and pushed green.

**`project_diagnostics`** MCP tool in `manage.ts`, beside the other machine-wide tools: takes a
store key from `list_project_stores`, reads the collection from disk without a daemon, because the
daemon is the thing that died. Renders peaks per process against the heap limit, the incidents
newest first with what the daemon was doing, each role's smallest and largest resident size over
the sampled span (a respawn shares its predecessor's role), the reports present with their trigger
and heap numbers (and snapshots by size), and the path of the raw file. Where no snapshot is
present it says that what a process RETAINED needs the opt-in snapshot, so "no reports" is never
read as "nothing to learn". A store with no collection yet says so without erroring; an unreadable
one errors with the reason; an unknown key errors like its siblings. `LIST_STORES_DESCRIPTION`
points at it. `listReports` lives in `diagnostics.ts`, the owner of the reports directory's shape,
and parses each report for its header and heap numbers only.

Read rules, from the red team: every file read must be a REGULAR file, so a link or a directory
wearing a report's name, a snapshot's, or the collection's is reported unreadable rather than
followed, and `reports/` itself must be a real directory, not a link to one. A key outside the alphabet `workspaceKey` mints is refused before any lookup, since it
is interpolated into Markdown. Rendering never rounds a lie: zero is `0B`, an impossible size is
`?`, a zero limit is `unknown` with no percentage beside it, a negative span is `in the future`.
Reports list the newest twenty and count the rest.

Docs: the file-level docs landed in Phase 1 (`docs/architecture.md` Diagnostics section,
`CHANGELOG.md` under the release heading (`2.0.1`, the owner's call; stores are preserved either
way), `README.md`
How it runs, `CLAUDE.md` Development). This phase names the tool in each: the README housekeeping
line, the changelog, the architecture section, and `CLAUDE.md`, which now tells an agent to call
`project_diagnostics` rather than read the files by hand.

Tests: rendering with incidents, without, with no file, and with every field the schema allows to
be null or zero; the report listing across a valid report, the daemon's own, junk, a `null`
document, a directory wearing a report's name, a directory wearing a snapshot's name, and an
unreadable directory; the description cap, for every tool the server lists.

## Painpoints

- **`vscode-jsonrpc` rethrows a failed write into a promise nobody holds.** Its `sendRequest`
  uses `new Promise(async (resolve, reject) => { ... throw error })`, so every failed pipe write
  is one typed rejection for the caller and one unhandled rejection for the process. It took a
  CI runner slow enough to widen the kill-to-exit window to surface it, and the daemon had been
  one such race away from shutting itself down since the supervisor was written. Absorbed now in
  `core/src/supervisor.ts:absorbingWrites`; the library is still the library.
- **A fixed timeout meeting a slow machine read as a defect, again.** Three release pushes failed
  CI on two checker-backed tests at vitest's 5 s default, and two Luna audit agents reported the
  new integration test as failing because six of them were running bun at once. The board entry
  "Conformance reports a loaded machine as a provider defect" is the same class; the vitest half
  is now 30 s, the conformance half is still open.
- **Audit agents misreport the async boundary.** Two separate agents claimed a signal could land
  between `claimLock` and the `daemon` assignment in `core/src/daemonCli.ts`; there is no await
  there, so it cannot. Another claimed `process.report.writeReport("daemon-high.json")` ignores
  `process.report.directory`; it does not. A confident stack trace is not evidence, and both cost
  a verification each.
- **Every build dirties all seventeen bundles.** `dist/providers/*/main.js` show as changed after
  a rebuild that touched nothing they contain, byte-identical in size, and git calls them binary
  because the bundled dependencies carry characters the source rules forbid. Every commit drags
  them along and the diff says nothing about what moved.
- **The supervisor's handshake fixture depends on where vitest runs.** The "unusable shape" test
  writes a script into `tmpdir()` that imports `vscode-jsonrpc/node`; it resolves from the repo's
  cwd and not from elsewhere, which is how an audit agent got a spurious module-not-found.
- **`exactOptionalPropertyTypes` and test overrides.** A `Partial<Options>` spread cannot
  un-override a field with `undefined`, so the env-exclusion test had to assert propagation of
  `false` rather than the real default. Small, but it shaped a test.
- **`lint:fix` reflows what was just written, and the next edit misses.** Twice an `Edit` anchored
  on text the formatter had since re-wrapped, and the failure surfaced only as a later test still
  asserting the old behaviour. Anchoring on a line the formatter leaves alone is the workaround;
  running the formatter BEFORE composing the next edit is the habit.
- **Audits contradict each other on test strictness.** One Luna pass flagged a rendering test for
  asserting exact prose; the next flagged the loosened version for being able to pass with wrong
  bounds. Both were right about something: the FACT (90%, newest first, a bound's value) is the
  contract, the formatting around it is not. Worth writing down once rather than relearning per
  audit.
- **`describeSize` floored everything under a kilobyte to `1KB`** and nobody noticed for as long as
  it only described index files. The first time it described memory it was a lie. A formatter
  shared between "how big is this file" and "how much did this process hold" needs the zero and
  the impossible value spelled out, not rounded.
