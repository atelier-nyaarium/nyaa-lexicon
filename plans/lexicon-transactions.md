# Questionaire

Feature: transactional refactor system for the lexicon MCP server. Owner's brief (task board
"Lexicon Transactions"): a symbol-source reader, staged multi-file refactors with syntax
pre-validation and graph impact reporting, an undo stack, commit/revert, manual-edit tracking, and
the existing rename cannibalized into it.

Scouting established (two Codex audits + direct reading, 2026-08-13):

- `parseFile` accepts candidate `text`, so dry-run syntax validation without disk writes exists.
  TS and Python return severity-error diagnostics; GDScript returns none (needs a tier flag).
- Store keeps full ranges for declarations and literals; no snapshots of source or facts anywhere.
- Binding is provider-computed at parse time into `refs.targetId`; deleting a symbol does not
  cascade incoming refs, so orphan detection is one indexed read.
- No daemon-wide write mutex; watcher and mutations interleave; daemon dispatch is session-blind.
- `applyEdits.ts` `writeAll` is temp-file+rename per file, not cross-file atomic; its own comment
  asks for a journal.
- Candidate parsing contaminates provider memory (TS overlay, Python cache, GDScript binding
  index).
- LSP adapter already opens `IndexStore.open(":memory:")`, precedent for a second in-memory store.

Naming settled in feasibility report (accepted so far without objection): `symbol_source`,
`refactor_start`, `refactor_replace`, `refactor_move`, `refactor_rename`, `refactor_track`,
`refactor_status`, `refactor_undo`, `refactor_commit`, `refactor_revert`. A transaction holds a
stack of steps; each step snapshots before-images.

## Question 1 - Overlay or write-through?

Q: Does an open transaction hold edits in an in-memory overlay reflecting the would-be state
(disk untouched until commit), or write through to disk immediately with journaled before-images?

A: B. Write-through + journal. Candidate text is validated in memory per step (the overlay
exists only there); accepted steps write to disk immediately and journal before-images in SQLite;
undo verifies hashes before restoring; revert restores transaction-start baselines; commit drops
the journal. Both choice evaluators, including the overlay's assigned advocate, converged here.

> "B"

Research (two Codex evaluators, one per choice, both landed on write-through):

- Full overlay has four blockers in this codebase: (1) later steps' graph queries need a complete
  would-be index, not a text map; service holds one IndexStore + one disk readFile
  (service.ts:391), queries span the whole refs table, and there is no overlay-aware query path;
  (2) provider contamination management: one long-lived provider per language (supervisor.ts:59),
  so overlay parses make bind/typeOf/resolveImport answer overlay while SQLite answers disk for
  every other client; (3) manual edits land on disk, composing them with an overlay is semantic
  rebase, not concatenation; (4) builds/tests cannot see the would-be state, killing the
  iterate-verify-commit flow.
- Write-through matches the disk-authoritative architecture and the existing renameSymbol
  precedent (writes then reindexes immediately, service.ts:2004-2015). Its costs are all closeable:
  workspace mutation gate (validate outside, gate, recheck hashes, journal, write, reindex,
  complete, release); hash checks on every undo/stack pop; journal must join answers/gaps in the
  schema-rebuild salvage path (store.ts:388-450); plain rename_symbol refuses while a transaction
  is open; provider state restored by re-parsing disk text after a REJECTED candidate; journal
  recovery on daemon start before the handler is published (daemonCli.ts ordering already has the
  slot).
- Undo interleaving with manual edits composes iff each step journals the text it actually read
  (not the transaction baseline), the transaction baseline is never overwritten by refactor_track,
  and every pop verifies current hash == step's after-hash, refusing on mismatch.

Owner's model, stated before the question: manual edits are honor-system ("honorably notifying to
track a file"), refactor_start's instructions carry the warning, tracked files get a snapshot
every layer.

## Question 2 - Fate of the standalone rename tools?

Q: When rename folds into transactions, what happens to `prepare_rename` / `rename_symbol`?

A: A. Clean break. Both MCP tools disappear; `refactor_rename` exists only inside a transaction;
the LSP editor rename wraps a one-step transaction internally (open, rename, commit) and gains
journal protection. Quick renames cost three calls (start, rename, commit), accepted.

> "A"

## Question 3 - Who owns an open transaction?

Q: One open transaction per workspace; who may operate it, given the daemon serves multiple
session-blind clients?

A: A. Cooperative. Any client can add steps, undo, commit, revert. A second `refactor_start`
refuses with a status pointer to the open transaction. No owner token; hash guards, not identity,
protect against interleaving damage.

> "A"

## Question 4 - How smart is refactor_move in v1?

Q: Mechanical move with honest fallout reporting, or provider-assisted import repair?

A: B. Full provider-assisted import repair: a new protocol method (shaped like `renameEdits`),
each provider rewrites imports in referencing modules when a symbol moves. Implementation
strategy: one agent per language works its own `providers/<language>/` subtree in parallel against
the unified contract, while the plan drives the core.

> "You can send separate Terra agent per languages to work on their own codebase with the unified
> contract you provide. All the while, you fire through the plan."

# Plan

Decisions in force: write-through + journal (Q1); clean break on rename (Q2); cooperative
single-transaction-per-workspace (Q3); provider-assisted import repair for move, providers built
by parallel per-language agents against a frozen contract (Q4). Naming delegated: `symbol_source`
read tool; `refactor_start/track/status/replace/rename/move/undo/commit/revert`. A transaction
holds a stack of steps; each step journals before-images; tracked files snapshot every layer.

Refinement lap 1 (2026-08-13): six Codex auditors (journal/recovery, mutation gate, move
contract, replace addressing, rename cannibalization, tool surface) audited this plan against the
code. All accepted amendments are folded into the rulings and phases below. Two corrections to
earlier claims: `find_literals` does NOT currently print fact ids (must be added), and the LSP
adapter runs a private in-memory service in a separate process, so "LSP wraps a transaction" is
incoherent until the LSP routes through the daemon; that unification is now a Phase 4
prerequisite.

Engineering rulings (delegated; amended by lap 1):

- Addressing: writes take `symbolId` for declarations and `factId` for literals, nothing else.
  `symbol_source` (read-only) also accepts name+module, answering candidates on ambiguity like
  describe. `find_literals` output grows factId + exact range. A literal address must match
  exactly one row or the tool refuses (literal fact ids include the range, so ordinary duplicates
  are distinct; refuted lap-1 suspicion). `symbol_source` returns the exact disk slice of the
  stored range, quotes included for literals, PLUS the concrete `replaceRange` used; the same
  address given to `refactor_replace` replaces that slice. Round-trip by construction.
- SymbolId collisions exist today: Python and GDScript mint undisambiguated descriptor paths, and
  `replaceFile`'s INSERT OR REPLACE silently discards the earlier twin. Fix in layers: store
  detects the collision at replaceFile and records it; refactor writes refuse a collided id as
  unaddressable; providers grow deterministic disambiguators as Phase 5 provider work.
- Overlap guard: replacing a declaration whose range overlaps a SIBLING declaration (one
  statement declaring several names) is refused; ancestor/descendant overlap is the normal case
  and fine.
- Rename-bypass guard: if the candidate parse shows the addressed declaration's own name or id
  changed, replace refuses with "use refactor_rename".
- Reads: read the file once, hash that exact text, compare to `files.contentHash`, slice the same
  text. Stale index -> the repair (reindex) enters the write side of the gate, then the read
  restarts. Unowned-and-stale -> "stale and unrefreshable"; deleted -> "module deleted", never the
  old range. Mutations hold the gate exclusively; `symbol_source` takes it shared so it never
  observes the middle of a multi-file step.
- SymbolIds embed name and module, so rename and move re-mint ids, and descriptors chain through
  containers, so a renamed or moved CONTAINER re-mints its whole descendant subtree (methods,
  parameters, nested types). A descriptor-prefix rewrite helper in `protocol/src/symbolId.ts`
  produces the deterministic oldId->newId map for the subtree; `answers`/`gaps` migrate over that
  map; citations go stale naturally, which is correct: prose survives with the stale marker.
- Affected-module rule: modules whose refs carry a targetId or fromId in the oldId->newId map are
  reindexed even when their text did not change (a module calling a renamed class's METHOD gets no
  text edit but holds stale bound ids). Declaring module reindexes FIRST, as an explicit
  scheduler invariant, so providers expose new declarations before dependents re-bind.
- Issue baseline: captured per module at first touch. Matching is by (module, name, role, reason)
  tuples with counts, never by fact id, because fact ids embed ranges and any edit above an
  untouched old issue would make it look new. Store-wide orphans are new by definition when the
  target existed at baseline. Issues persist as durable RefactorIssue records keyed to the step
  that introduced them; one shared renderIssues in render.ts serves replace/move/rename output,
  refactor_status, and commit refusal.
- Rejected candidates restore provider memory by re-parsing the disk text (failure path only).
- GDScript's empty diagnostics: new provider tier flag `syntaxDiagnostics`; the syntax gate
  reports "not checkable for this language" instead of a false pass.
- Undo is LIFO with hash verification: every pop requires current file hash == that step's
  after-hash, refusing with the conflicting file named; a step journals the text it actually READ
  (so manual edits between layers are captured by the next layer and restored by its undo), and
  `refactor_track` never overwrites the transaction-start baseline. Revert restores baselines of
  all tracked files, discarding mid-transaction manual edits by definition, and deletes files the
  transaction created.
- Step boundary and failure: validation (candidate parse, impact diff) runs OUTSIDE the gate;
  then the gate is acquired, disk hashes rechecked (changed -> refuse, agent re-plans), step
  number allocated, journal phase committed, files written, modules reindexed, completion phase
  committed, gate released. ANY failure after journaling restores the step's images under the
  gate and returns a rendered failure; a rollback failure leaves the journal in an explicit
  recovery-required state. Refactor tools never throw; every backend failure renders as a
  ToolResult with isError.
- Journal durability: images are content-addressed BLOBs keyed by raw-byte hash (byte-faithful
  for non-UTF-8; refactor steps refuse non-UTF-8 targets since providers parse text, but track
  and revert stay byte-faithful); per-layer manifests reference blobs, preserving
  snapshot-every-layer semantics without copying unchanged files; per-transaction byte cap with
  refusal. SQLite transactions stay short and never span a filesystem write or provider await.
  fsync-before-rename is a stated non-goal for v1, matching the existing writeAll behavior; the
  journal makes post-crash recovery possible either way.
- A step's plan is snapshotted into the step record, never recomputed at apply time (fixes the
  audit-found prepare/apply drift in the current rename).

## Phase 1 - Protocol contract (freeze first, providers depend on it) ✅

The parallel provider agents build against this and nothing else, so it freezes as exact zod
schemas plus conformance cases, not prose.

- `moveEdits` provider method. The lap-1 audit killed the naive "fromId = moved symbol" rule (a
  moved class's body references are owned by its METHODS, and top-level initializers may carry no
  fromId at all), so the contract is:
  - The moved CLOSURE is the declaration range plus every descendant declaration id. Core hands
    the provider a dependency inventory covering every reference inside that closure; every entry
    is classified or the move blocks. Omission never means "no import needed".
  - `MoveDependency` record: source import range, specifier, source name, local name, import
    kind (named/default/namespace/side-effect/type-only), lexical scope, and resolved target
    module/symbol or explicit unresolved status. A `reference.name -> imports.name` join is
    stated to be insufficient.
  - Frozen dependency taxonomy: exported sibling -> import from old module; private sibling ->
    block (`PrivateSibling`/`NoExportPath`); builtin -> no import; external package -> preserve
    its import; dynamic/reflection -> block (`DynamicDependency`); relative import inside the
    moved body -> resolve old target, re-render from new location.
  - Specifier RENDERING lives inside moveEdits: the provider receives importing module, old
    module, new module, and site, and returns the complete edit or `NoImportPath` /
    `AmbiguousImportPath` (tsconfig paths, package export maps, aliases are provider knowledge).
  - Target state is explicit: targetModule, targetExisted, prior text/hash when present,
    insertion position, collision policy. Providers must virtual-admit a not-yet-existing target
    (parse supplied text before the file exists on disk).
  - Move-specific closed enums, separate from rename's: at minimum `PrivateSibling`,
    `NoExportPath`, `NoImportPath`, `AmbiguousImportPath`, `DynamicDependency`, target
    route/collision failures.
  - The lap-1 case table (aliased/namespace/type-only imports, star and conditional imports,
    barrel and re-export consumers, tsconfig aliases, new-file targets, collision targets,
    descendant references, builtins, externals, relative imports) becomes conformance cases.
- `syntaxDiagnostics` tier flag in InitializeResponse.
- Descriptor-prefix rewrite helper in `protocol/src/symbolId.ts` (subtree oldId->newId mapping
  for rename and move; single owner of the grammar does the rewriting).

Three bullets above resolved differently from their first wording, deliberately:

- LEXICAL SCOPE is not a field on `MoveDependency`. It was wanted so a provider could tell two
  same-named imports apart, but that was the join the design abandoned: the core resolves the
  origin to a symbol id before the provider sees it, so nothing is left to disambiguate. An import
  written into the target sits at the target's top level regardless of the scope the original was
  written in.
- TARGET HASH is not on the request. Conflict detection is the journal's job in Phase 2, and a
  provider rendering edits against text it was handed has nothing to check a hash against.
- COLLISION POLICY is the `TargetCollision` refusal rather than a request field. One policy,
  stated in the enum, beats a knob every provider would implement differently.
- BUILTINS have no `DependencyOrigin` member. Whether a name needs an import is language
  knowledge, and a core that classified builtins would be branching on language. The origin union
  carries only what the index proves; the provider decides what to write.
- Conformance suite: tier flag honesty, and a suite-level check that every provider ANSWERS
  moveEdits rather than returning ready with nothing to do.
  - The 16-row move case table moves to Phase 5, beside the implementations. No provider
    implements move until then, so every such case would skip today, and a test that cannot fail
    is not a test. The contract they test is still frozen here, which is what the provider agents
    build against.

## Phase 2 - Journal and transaction core

- Store: SCHEMA_VERSION bump. Tables: `refactor_transactions` (id, state, startedAt),
  `refactor_steps` (txn, stepNo, kind, PHASE: journaled -> written -> reindexed -> finalized,
  snapshotted plan JSON, createdAt), `refactor_blobs` (content-addressed by raw-byte hash),
  `refactor_images` (txn, scope: baseline|step, stepNo, module, existedBefore, existsAfter,
  beforeHash, afterHash, blob ref). Explicit before/after existence; BLOBs, not text.
- Salvage: journal tables survive BOTH schema-version and provider-fingerprint rebuilds, like
  answers/gaps; an unreadable journal fails closed (refuses to open as if absent) instead of
  silently vanishing; the drop/restore sequence runs inside one SQLite transaction.
- Recovery on daemon start, after lock+store+providers, before the handler publishes. Per-image
  hash classification: journaled-not-written -> abort the step; partially written -> files
  matching after-state restore to before-state, files matching neither are conflicts and are
  never overwritten; written-not-reindexed -> reindex and finalize idempotently. Stray
  `.lexicon-tmp` files are swept.
- Workspace mutation gate, defined as covering: refactor steps, undo/revert restores,
  `replaceFile`/`forgetFile`, warm/full indexing, and watcher batches. Exclusive for mutations,
  shared for `symbol_source`. The watcher queues module PATHS, not event-time hashes; a batch
  acquiring the gate re-reads and re-hashes (this retires the stale event-hash pairing defect).
  `indexFile` leaves the external dispatch surface or becomes gate-wrapped maintenance; stored
  hashes are always derived from the exact text handed to the provider. Reentrancy rules:
  public boundaries acquire once, nested reindex uses underGate helpers, never await watcher
  settlement while holding the gate. Step numbers allocate inside the gate; gate acquisition is
  the linearization point.
- TransactionManager: new core module, sole owner of the transaction concept (residue test:
  nothing else touches journal tables; planted violation first, per house rule). Lifecycle
  start/track/status/undo/commit/revert; commit refuses on unresolved new issues unless force;
  second start refuses with a status pointer.
- Durable `RefactorIssue` records keyed to introducing step; single shared renderIssues.
- `symbol_source` service method + MCP tool (read-only; shared gate; read-once-hash-slice).
- MCP tools, all ten as PROJECT_TOOL_DEFINITIONS entries: `symbol_source` batchable query;
  `refactor_status` non-batch query (overview precedent) whose no-transaction answer is a
  successful "none open; call refactor_start"; the other eight are mutations with the scalar
  project selector. refactor_start's instruction body states: track before every manual edit;
  snapshot every layer; baseline never overwritten by track; undo is LIFO and refuses on hash
  mismatch; revert discards manual edits; commit force semantics; one transaction per workspace,
  cooperative, no token; re-fetch addresses after every step, never reuse cached ranges.
- Dispatch + daemonWire methods + ToolBackend/daemonBackend plumbing. Every refactor tool
  catches and renders; nothing escapes as a transport error.

## Phase 3 - refactor_replace

- Address by symbolId/factId only; refuse collided (unaddressable) symbol ids; refuse
  sibling-overlapping ranges; refuse when the candidate parse renames the addressed declaration
  (redirect to refactor_rename).
- Splice candidate text; dry-run parseFile outside the gate; severity-error diagnostics reject
  the step before disk (tier-honest for GDScript); graph diff: symbols disappeared while
  referenced elsewhere (store-wide via refs_target), references that stopped binding, references
  that bind nowhere in either version, reported with binding reason and detail; baseline
  subtraction by (module, name, role, reason) tuples; then the gated write path from Phase 2.
- Problematic steps allowed and reported; issues persist with the step.

## Phase 4 - refactor_rename

- PREREQUISITE, promoted from the backlog by two lap-1 auditors independently: the LSP adapter
  stops building a private in-memory service and routes through the daemon (ensureDaemon + one
  connectFrames connection + reconnect, the shape daemonBackend already has). Until that lands,
  LSP rename is explicitly disabled rather than wrapping a private pseudo-transaction.
- Cannibalize prepareRename/renameSymbol into a transaction step; remove both MCP tools; LSP
  rename becomes a daemon one-step transaction (prepareRename stays as its read-only preview).
- Subtree migration via the Phase 1 descriptor-prefix helper: oldId->newId map for the full
  descendant tree; answers/gaps migrate over it with collision handling; map validated against
  the ids the reindex actually produced.
- Affected-module reindex: text-edited modules PLUS modules holding refs with targetId or fromId
  in the map; declaring module first as an asserted invariant.
- Blast radius checklist from lap 1: projectTools definitions, tools.ts schemas/handlers,
  daemon/local backends, dispatch cases, core service exports, render paths, MCP + core + e2e
  tests, README tool list, docs/architecture.md "same service" claim, plugin description wording.
  `protocol/src/rename.ts` and provider renameEdits implementations STAY (provider contract, not
  the removed tools).

## Phase 5 - refactor_move

- Core orchestration: closure computation (declaration + descendants), dependency inventory
  construction, cut + insert (create target if absent: virtual admission, directory creation,
  journaled existedBefore=false so undo deletes), fan `moveEdits` per affected module,
  target-file import additions, subtree id migration, affected-module reindex, graph diff and
  issue gate as replace.
- Parallel per-language provider agents (TS, Python, GDScript), each confined to its own
  `providers/<language>/` subtree, built against the frozen Phase 1 contract and conformance
  suite. Python/GDScript deterministic symbol-id disambiguators ride along here (retiring the
  collision-refusal fallback from Phase 3 where they land).

## Phase 6 - Docs, dogfood, release

- docs/architecture.md section (+ knowledge-layer note on answer migration; correct the LSP
  "same service" claim once unification lands); tool descriptions to the "earns a call" bar
  (lap-1 drafts exist in the audit record); grade.js against switchboard; drive the built server
  on a real workspace through a real multi-step transaction: replace + manual tracked edit +
  rename + undo with a provoked hash conflict + forced-issue commit + fresh transaction +
  revert; kill the daemon mid-step and watch recovery; rebuild + reload plugin; release build.

Test density bar (0.4 test-lines per source-line) applies per phase; a phase without its tests is
not done.

## Painpoints

Recorded, not fixed.

- `ProviderTiers` was widened to a `Record<..., boolean>` in two places, `core/src/supervisor.ts`
  (`RunningProvider.tiers`) and `protocol/src/conformance/types.ts` (`SuiteReport.tiers`). Adding
  one OPTIONAL tier field broke both with an error about `undefined` not being assignable, far
  from the change that caused it. The widening bought nothing: both call sites index with a known
  key. Anything adding an optional field to a schema that some consumer has flattened into a
  Record will hit this again, and the next such field is likely, since honest capability flags
  want to be optional so absent stays different from false.
- Nothing else in Phase 1 was worse than ordinary. The id-grammar residue test caught a
  hand-written symbol id in the conformance probe on the first run, which is the mechanism
  working rather than crust.
