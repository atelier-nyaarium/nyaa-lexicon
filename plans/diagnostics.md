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

## Phase 1 - The collector

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
- `reports/` is pruned after every write: the newest 8 node reports, and the newest 2 heap snapshots
  when the opt-in is on, so the directory is bounded either way.
- `nodeReportSetup(reportsDir)` answers the argv that turns on `--report-on-fatalerror`,
  `--report-on-signal`, `--report-signal=SIGUSR2`, `--report-compact` and the directory, plus the
  heap snapshot flags when `LEXICON_HEAP_SNAPSHOT` is set, and the signals that argv makes the
  child survive.
- A node report carries EVERY environment variable, an agent's API keys included. Where node can
  leave them out (`--report-exclude-env`, node 22.13 and newer; the floor is 22.5) it is told to,
  along with the network interfaces, and the collection records `host.reportsExcludeEnv` so a
  reader on an older node knows the reports beside it carry the environment. `reports/` is
  created owner-only, 0700, either way. Asked of the daemon's own node, which is the children's.
- Nothing in the report path is fatal to the daemon: a reports directory that cannot be made costs
  the reports, logged, and the providers start without the flags. A signal the supervisor would not
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

## Phase 2 - The surface and the record

**`project_diagnostics`** MCP tool in `manage.ts`, beside the other machine-wide tools: takes a
store key from `list_project_stores`, reads the collection from disk without a daemon, because the
daemon is the thing that died. Renders peaks per process against the heap limit, the incidents
newest first with what the daemon was doing, the recent trend, the crash reports present with their
trigger and heap numbers, and the path of the raw file. A store with no collection yet says so
rather than rendering empty tables. `LIST_STORES_DESCRIPTION` points at it.

Docs: `docs/architecture.md` gains a Diagnostics section stating the two owners and the bounds.
`CHANGELOG.md` 2.0.0 says where to look after a crash and what the opt-in snapshot costs.
`README.md` How it runs names the file. `CLAUDE.md` Development gets the two lines an agent needs:
where the collection is, and the env var.

Tests: rendering with incidents, without, and with no file; the report listing; the description
length cap.
