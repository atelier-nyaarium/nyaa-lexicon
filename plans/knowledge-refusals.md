# Questionaire

## Question 0 - What class of defect is this? (settled in chat)

Q: Five patches landed overnight against the knowledge layer. What did they have in common?
A: Every one repaired a refusal that described the STATE instead of the MISTAKE. "Not in the
index" is a state. "You passed a fact id where the symbol id goes" is the mistake. Same shape,
same wire, same field; the difference is whether the author can act in one turn.

> "would you go back and improve them? and which ones would you improve consistently?"

The same class showed up twice earlier the same day: the byte plane's "blob transfer is not open
to this caller", and a residue sweep reporting a vanished file as an index-writer violation.

## Question 1 - What does `RecordOutcome.reason` do for us? (settled in chat)

Q: Why is a refusal a free string, and is that enough?
A: The knowledge layer never calls a model and never verifies prose. It checks citations against
the index and either stores or refuses. A refused write cannot be fixed by the store, only by the
author, and `reason` is the entire channel through which they learn how. Twelve places produce
one. Exactly one place reads it, `renderRecordOutcome`, straight to the agent. The LSP never
surfaces it and nothing branches on it. A string is enough while a reader is the only consumer.

> "what's the reason record outcome do for us"

## Question 2 - Which improvements go ahead?

Q: Three remained after the review. Which of them?
A: All three, as one plan, with the two open design questions beside them.

> "ok I like it. include everything into a plan file."

## Question 3 - Closed refusal value beside the string? [Deferred]

Q: Should refusals become a closed value the LSP could branch on, the way Switchboard's `Refusal`
union renders through one owner?
A: Not yet. `RecordOutcome` is a wire shape, and replacing `reason: string` is not additive. Add a
value BESIDE the string the day a consumer branches on it, such as an editor quick fix. Until then
the string is the product and its quality is what this plan raises.

## Question 4 - Does knowledge follow a symbol that moves? (settled in chat)

Q: `currentHost` moved from `core` to `client`. Its answer is stranded at the dead id, permanently
STALE, citing facts that can never resolve. Its prose is better than what a fresh reader wrote for
the live symbol, and `recall_answer` on the live symbol never shows it. Demand rows strand the same
way and lead the gap list, which both agents read as the queue being exhausted. And the rows are a
slow leak: no link to the declaration, no cleanup on replace or forget. What should happen?
A: The store cleans up inside the scan, never an agent. Orphans are detected and dated, a file that
exists but fails to parse is never dated, a date clears when the symbol returns, a unique
same-shaped declaration elsewhere triggers migration instead of a date, and anything dated for
thirty days is deleted. Auto-migration ships despite the author's and both reviewers' preference
for a proposal-only form; the owner heard that and decided.

> "we need to do more than just make them visible. don't make the AI clean it up either. that
> would just be stupid."

> "Being able to detect all orphans in the database. Periodic checks to date them. But if the file
> exists and is just failing to parse, don't strand date that file. It could literally be in the
> middle of a long refactor. Stranded entries that get unstranded remove date next scan."

> "Auto migration as you suggested." ... "Orphans deleted after 30 days."

## Question 5 - Should fan-in seeding rank within a language? [Open, owner's call]

Q: References do not bind across Kotlin and TypeScript, so the console's fan-in counts only its
own callers and ranks permanently below the server, even where its doctrine is as deep. The agent
confirmed the Kotlin comments carry the same weight. Should seeding rank per language?
A: Undecided. Phase 5 is priced and decision-complete, and it waits.

# Plan

The rule this plan installs, stated once: **a refusal names what the author did and what to do
instead, or it is not finished.** Every phase below is that rule applied to one message, plus the
two design questions the overnight run surfaced.

Phases read as a specification. What each phase looked like before an audit corrected it, and why,
lives under Painpoints, so an implementer meets only the current design here.

**Order and dependencies.** The catalog phase lands first, because the gate in Verification fails
the build on any refusal composed outside it, so every later phase's wording is a constructor.
Phase 1 defines the one matcher and the stranded wording that Phase 0 and Phase 4 both use, so it
lands next. Phase 0 and Phase 3 are independent of each other. Phase 4 depends on Phase 1's matcher
and stranded state. Phase 2 depends on the catalog only. Phase 5 waits on the owner.

## The catalog phase - Every refusal is a named constructor in one module

**What:** the knowledge layer composes fifteen refusal strings inline today, eleven in the ledger
and four in the citation checker, plus the four diagnoses `subjectRefused` composes. They move
into `core/src/refusals.ts`, one exported constructor per refusal, each returning the finished
sentence; `subjectRefused` moves there with them, since it is the constructor that reads the
store. The ledger and the checker keep their three return shapes, `recorded: false`, `refused:`
and `ok: false`, and put a constructor's result in the reason slot. The refactor planner and the
service reach `subjectRefused` from the same module when Phase 0 routes them.

**The constructors, by the branch each replaces:** `needsProse`, `proseTooLong`, `noDoubtStands`,
`wrongDoubtId`, `replacesSoundAnswer`, `doubtNeedsReason`, `nothingToDoubt`,
`noAnswerToReaffirm`, `citationsNoLongerResolve`, `nothingToReaffirm`, `clearingRequiresCiting`,
`citesNothing`, `malformedCitations`, `unresolvedCitations`, `citesOnlyNeighbours`, and the four
diagnoses `factIdAsSubject`, `unmintedId`, `strandedId`, `unknownId`. A constructor takes the
values its sentence names and nothing else.

**The four rewordings the doctrine marks as failing land here, with their text pinned:**

- `needsProse`: "an answer needs prose. Send the sentence or two the cited facts establish in
  `prose`".
- `nothingToReaffirm`: "this answer is already sound: every citation resolves and no doubt
  stands. Re-affirming changes nothing. To replace its prose call `record_answer`; to doubt it
  call `invalidate_answer`".
- `nothingToDoubt`: "nothing is recorded about X, so there is no answer to doubt. Doubting an
  unwritten answer asks for one, and `record_answer` writes it".
- `noDoubtStands`: "no doubt stands on the Q answer about X, so omit `resolvesDoubt`. To raise
  one, call `invalidate_answer`".

**Tests:** each constructor is named by a test that asserts the returned reason AND the action
the caller took, so a test that merely names a reason does not pass for a branch that never ran.
The residue in Verification is planted at one inline literal per shape and watched failing.

**Release:** internal. No wire shape changes; the same reasons reach the same slots. Ships in the
minor with Phases 1, 0, 2 and 3.

## Phase 1 - One matcher, and a stranded row says it is stranded

**The one matcher.** The id grammar gains two named predicates over parsed descriptors, in
`symbolId.ts`, so nothing outside the grammar decides what "the same declaration" means:

- `sameDeclaration(a, b)`: same language, same kind, same full descriptor path including
  disambiguators and occurrences, different module. This is what authorizes a migration.
- `sameNameAndKind(a, b)`: same language, same kind, same last descriptor name, and for a member,
  the same name on the container descriptor too. Different module. This is what lists candidates
  for a person.

Both return false for a local id, whose parse carries an ordinal and no descriptors, matching
`rebaseSymbolId`'s refusal to trace one. A stranded local is therefore dated and never migrated,
and its refusal lists no candidates and says a local has none.

The store's `declarationsNamed(name)`, already indexed by name, returns the shortlist unchanged,
and one helper in the knowledge layer, `matchingDeclarations(symbolId, predicate)`, applies the
predicate from the grammar to it. Phase 4's migration authorization and the candidate list below
are that one call with the strict or the loose predicate. The two are stated here once, and the
plan refers to them by name from here on.

**Stranded state, readable by every refusal.** The store exposes `strandedState(symbolId)`:
`{ answers: number, gaps: number, strandedAt: number | null, exempt: boolean, reason: string | null }`,
where `exempt` is true when the subject's module is in `parse_failures` and `reason` is that
failure's recorded reason, so the lookup has one owner. Exemption is a property of rows: with no
answer and no gap recorded, `exempt` is reported but nothing is waiting, and the id falls through
to the unminted shortlist below. `subjectRefused` reads the state before composing, so the wording
agrees with whatever the sweep last left the row in:

- No declaration, answers or gaps recorded, not exempt: **stranded**. The refusal says the
  knowledge recorded under this id is stranded because the symbol is gone, names `strandedAt` if
  the sweep has dated it and that deletion follows thirty days after, and lists the
  `sameNameAndKind` candidates so the prose can be recorded again where a reader will find it.
- No declaration, rows recorded, exempt: **waiting on a parse failure**. The refusal says the
  module is present and not parsing, that nothing will be dated or deleted while that holds, and
  names the parse failure's reason.
- No declaration, only demand rows and no answer: the same two sentences with "the demand recorded
  against it" in place of "the answers", so a dead id that was only ever asked about is told the
  truth too.

**Recall carries it on the wire.** `RecalledAnswerSchema` gains an optional
`stranded: { since: number | null, exempt: boolean, candidates: string[] }`. `recallAnswer` fills
it from `strandedState` when the subject has no declaration. `renderKnowledge` renders the status
line from it and replaces the reaffirm instruction, which a stranded subject cannot follow, with
the re-record path and the candidates. An optional field is a minor.

**Recall stops charging for it.** Today `recallAnswer` records demand on a miss only when the
subject has an indexed declaration, and on every unhealthy recall (stale, doubted, or inheriting
either) regardless of the subject. The miss path is already right. The unhealthy path is the one
that charges for a stranded answer, since a stranded answer exists and is permanently stale, so
the stranded check goes before `recordGap` there. A stranded or dated subject is also excluded
from the stale count in `knowledgeGaps`, or a dated row would re-enter the queue this plan says
it leaves.

**A stranded answer stays doubtable.** `invalidateAnswer` refuses only an id with no answers, by
design: a doubt is prose about the answer, the migration carries it, and a reader who found the
stranded prose wrong is right to say so. What it must not do is mint demand: today the doubt path
records a gap unconditionally after `setDoubt`, where the unwritten-answer path already guards on
the subject being indexed. The doubt path takes the same guard, and the comment above it carries
this rule in place of the one it states now.

**Tests:** plant a symbol, record an answer, replace the file without the symbol. `recordAnswer`,
`reaffirmAnswer` and `recallAnswer` on the dead id each say stranded and name the candidates;
`recallAnswer` carries the field and records no gap on the unhealthy path, which is the branch
the fix touches. `invalidateAnswer` on the dead id records the doubt and no gap. Plant only a gap row at a dead id: the demand wording. Put the
module into `parse_failures` with the file present: the waiting wording with the failure's reason,
nothing dated. Plant two same-named declarations in other modules: both listed as candidates by
`sameNameAndKind`, neither authorized by `sameDeclaration`. Strand a local id: no candidates, and
the refusal says why. Watch the old wording fail first.

## Phase 0 - One diagnosis for a bad subject id, reached from every tool

**What:** the subject diagnosis in `subjectRefused` becomes the one owner every tool reaches when
a symbol id names nothing. Four outcomes, closed: a fact id supplied as the subject, an unminted id
with the module's shortlist, a stranded id with its candidates and state from Phase 1, or a
genuinely unknown id whose module is not indexed either.

**The daemon method.** `diagnoseSubject`, request `{ symbolId: string }`, response
`{ kind: "factIdAsSubject" | "unminted" | "stranded" | "unknown", reason: string, candidates:
string[] }`, where `reason` is the sentence `record_answer` already composes and `candidates` is
the shortlist. Registered in the method table, dispatched in `dispatch.ts` through the same
`.parse(params` path as every other method, exposed on the client session. A new method is a
minor.

**The chokepoint.** `resolveOne` in the MCP adapter is where a supplied `symbolId` is currently
returned unvalidated to eleven handlers. It calls `diagnoseSubject` when the id names no
declaration and returns the reason as the problem, so every handler that funnels through it gets
the diagnosis without knowing it. The one path that takes a symbol id without `resolveOne`,
`symbol_source`, calls the same helper on its `symbolId` argument; its `factId` argument is a
separate parameter, so a fact id in the `symbolId` slot is the fact-id-as-subject case and nothing
has to guess. The knowledge writers already diagnose in core and are unchanged. The two sites
that answer `No symbol with ID ... is indexed` after a `null` from core, in `describe_symbol` and
`symbol_facts`, remain as guards against a file replaced between resolution and the read, and
answer through the helper too.

**Per tool, stated so nothing is implicit:**

- Through `resolveOne`, therefore diagnosed on absence: `describe_symbol`, `find_references`,
  `type_of`, `refactor_move`, `refactor_rename`, `refactor_preview`, `recall_answer`,
  `reaffirm_answer`, `invalidate_answer`, `symbol_facts`, and `knowledge_gaps` when a root is
  supplied; a rootless `knowledge_gaps` never resolves and is not diagnosed. `type_of` keeps its
  own three-valued Unknown for the reasons that remain after the id is known to exist.
- Direct, calling the helper itself: `symbol_source`.
- Diagnosing in core already: `record_answer`.
- Routed in core by this phase: `refactor_insert` through its `after` anchor, which the planner
  refuses today with the token itself. The planner holds the store, so it calls `subjectRefused`
  from the catalog for the anchor, and for the container branch names the container id as the bad
  subject, which is what it names today.
- Taking a module or a name, never a symbol id, so out of scope: `symbol_history`,
  `co_changed_with`, `outline_module`, `file_history`, `search_*`, `find_*` by text.

**The residue.** Two tokens, `is not in the index` and `No symbol with ID`, forbidden in
production source under `core/` and `adapters/` except `subjectRefused`; `__tests__` is excluded
because a test asserts the owner's output and a mock imitates it. The six existing instances of
the first outside the owner, in `service` (the `type_of` NotIndexed detail), `sourceWorkspace`,
and four sites in `refactorPlanner`, all take a symbol id that names nothing, which is this
concept, so each routes through the diagnosis; the two instances of the second are the adapter
guards named above. The residue is run against all eight before it is trusted. "No symbol named
X is indexed" is a name-lookup miss, a different concept, and is not touched.

**Tests:** each of the four outcomes handed to `describe_symbol`, `symbol_facts`, `symbol_source`
and `find_references` produces the sentence `record_answer` produces for it, and `type_of` and one
refactor tool produce it too, which proves the chokepoint rather than the two named tools. The
residue is planted at a seventh site and watched failing. A built-server test drives
`diagnoseSubject` through the real daemon.

## Phase 2 - The shortlist matches names the grammar recognises

**What:** the shortlist promotes declarations whose name appears in the bad id by substring, so a
name like `at` or `to` is promoted by any id containing those letters. The grammar owns the
spelling, so the ranking borrows the grammar's own parse.

**The partial parse.** `parseDescriptors` keeps its results in a local and every failure path
discards them, so a malformed id yields nothing today. The grammar gains `parseSymbolIdPrefix`,
returning `{ descriptors, failure }`, the descriptors parsed before the failure and the failure
itself, since the existing result type's failure arm carries no payload; it is exported from the
protocol barrel like its neighbours, or core cannot reach it, and `parseSymbolIdResult` is
unchanged. The ranking matches declaration names against those descriptor names. Only when zero
descriptors parse does it fall back to matching `quoteName(name)` as a whole token in the tail,
bounded by structural characters. Two span kinds are skipped as units there: a `(...)`
disambiguator, and a backtick-quoted name, which `quoteName` produces for any name carrying a
structural character and whose interior can hold a bare declaration name such as `to`.

**Tests:** plant `at` and `Total`; a bad id naming `Total` lists `Total` first and does not promote
`at`, and one naming `at` still finds it. Plant `to` and a bad id whose disambiguator is `to`: not
promoted. Plant a name that quotes, such as one carrying a dot: found. A bad id missing only its
terminator: the descriptors before the terminator are parsed and the right declaration leads. An
id that fails at its first descriptor: the fallback runs and still refuses `(to)`.

## Phase 3 - The gap header is told whether it filtered

**What:** `renderKnowledgeGaps` decides whether to name the asked question by inferring which core
branch produced the rows, which mirrors the core's structure into the renderer. The core says so
instead. `KnowledgeGapsSchema` gains an optional `filtered: boolean`. Every return sets it
explicitly: `true` from the seeded fallback, the module scope and the subtree walk, whose rows all
honour the asked question; `false` from the workspace demand sweep, which deliberately carries
every question with rechecks first. The renderer names the question only on `true`, in the
zero-row branch as well as the listed one, since today the zero-row branch names it
unconditionally. An omitted field is a legacy or synthetic result and reads as unfiltered, which
is the safe direction: a legacy module-scoped result loses its question label rather than a
legacy workspace sweep gaining a false one.

**Wire:** an optional field on a result shape is additive, and a minor.

**Tests, at the core layer, each named by the request that reaches its branch:** `{}` reaches the
workspace sweep, `filtered: false`; `{ module }` reaches the module scope, `true`; `{ root }`
reaches the subtree walk, `true`; `{}` with no outstanding gap or recheck rows reaches the seeded
fallback, `true`, and that trigger is reached by a workspace whose every gap has been answered,
not only by one never asked, since `saveAnswer` clears the gap it answers. At the adapter,
`resolveOne` turns `name` or `symbolId` into `root`, one test. Renderer: `true` names the
question, `false` does not, omitted does not, in both branches, with the lying case planted, a
page of matching rows on a mixed total.

## Phase 4 - Orphaned knowledge: dated, migrated, or deleted by the store

Decided by the owner; see Question 4. No agent is ever asked to clean up, and nothing here is a
chore a person performs.

**Orphan:** a row in `answers` or `gaps` whose subject id resolves to no declaration.

**Who does what.** Two owners, because the repository puts source-dependent decisions in the
indexer and facts in the store, and presence is a source-dependent decision.

- The **indexer** orchestrates, on two triggers. After a completed scan, at the point both the
  full scan and the watcher batch already converge on prune, it runs the sweep inline; it is
  synchronous like prune and it is bounded, so it costs the scan a bounded amount, and the plan
  does not claim it costs nothing. And periodically, because the owner asked for periodic checks
  and an idle workspace has no scans: `startLiveIndex`, which already takes the daemon's
  exclusive gate and runs every watcher batch as `gate.exclusive(() => service.applyBatch(events))`,
  gains a clock timer at `KNOWLEDGE_SWEEP_EVERY_MS`, one hour, that runs
  `gate.exclusive(() => service.sweepKnowledge())` the same way, so it never overlaps a batch, and
  it stops when the live index stops. Its clock is a change, not a given: `startLiveIndex` accepts
  a `clock` today and forwards it only to the watcher's debounce, and the daemon passes none,
  while it builds the service on the default `systemClock`. The daemon holds one `Clock` and
  hands the same instance to both, so the service, the indexer it builds, the watcher debounce
  and the sweep timer read one time source, and a test that supplies a fake through those two
  options controls all four; `clock` stops being optional on `startLiveIndex`. The indexer keeps
  the reachable set it last pruned against for the timer's presence answer; a file that changed
  since is a watcher event, and that event's batch runs its own sweep. Both triggers share one
  cap and one cursor, so a capped sweep resumes within the hour.
- The **store** exposes `sweepOrphans(batch, presence, now)`: one bounded batch, one transaction.
  `presence` is a function the indexer supplies, answering for a module with one closed value,
  `presentParsing`, `presentFailing` or `absent`, defined below. The store never touches the
  filesystem and never sees a hash.

**Transactions.** `inTransaction` is a raw `BEGIN`/`COMMIT` and not re-entrant, and the public
`migrateKnowledge` opens its own. The migration body is factored into a non-transactional
primitive used by both: the public method wraps it in a transaction as today, and the sweep calls
the primitive inside its own batch transaction. Each batch is one transaction; the sweep as a
whole is many, which is what lets it stop and resume.

**Presence, decided by the indexer from the scan it just finished.** The sweep runs after prune,
and prune has just computed the reachable set and forgotten every module outside it, including
that module's `parse_failures` row. So a module is `absent` when it is outside the reachable set,
`presentFailing` when it is inside it and `parseFailureOf` holds a row, and `presentParsing`
otherwise. No source is read and no hash is compared: a parse failure never writes
`files.contentHash`, so a hash comparison would call every file edited into a failure changed and
date it, which is the mid-refactor case the owner exempted. A file deleted and recreated under the
same path is `presentParsing` if it parses, and its missing symbol is a real strand, or
`presentFailing` if it does not, and is exempt like any other failing file.

**Two passes, so the loop can reach what it must.** An orphan-only loop can never un-strand,
because a row whose subject resolves again is not an orphan.

Pass A, over dated rows, read by the `strandedAt` index on each table:

1. **Un-strand** a dated row whose subject resolves again: the date is cleared.
2. **Delete** a row whose date is thirty or more days behind the clock, answers and demand rows
   alike. A date ahead of the clock is treated as now, so a clock that went backwards cannot
   delete early.

Pass B, over undated orphans, read as one `UNION ALL` over `answers` and `gaps` carrying a row
kind, keyed `(kind, symbolId, question)` and left-joined to `symbols` on the subject id. The two
tables share no row, so a cursor over one key cannot say which table it left, and the triple is
what the cursor persists. The orphan's module comes from `moduleOf` in the grammar, since the
join yields none for an orphan by definition; a malformed id has no module, can never be exempt,
and is dated on first sight.

3. **Exempt** when `presence` answers `presentFailing`. A present, failing file may be
   mid-refactor, and nothing is written for it.
4. **Migrate** when exactly one declaration in the index satisfies `sameDeclaration` from Phase 1,
   which a local or malformed id never does. The primitive carries answers and demand the way a
   rename through the refactor tools does. No date is set on a move. **Collision:** the migration
   moves only the questions the destination
   lacks and deletes every remaining source row, so a stranded answer whose question the
   destination already holds is deleted and the destination's prose wins, even where the stranded
   prose was better. That is the current behaviour, kept as written, and it is the one place this
   phase asks the owner to look again.
5. **Date** otherwise: `strandedAt` is set on first sight and left alone after.

**Budget and continuation.** The unit is rows examined per sweep across both passes, capped by
`ORPHAN_SWEEP_CAP`, owned by the indexer beside the sweep call and passed into `sweepOrphans`;
`STALE_SCAN_CAP` is a file-local constant of the knowledge layer, which neither the indexer nor
the store imports, and stays where it is. Each pass reads in one explicit order and resumes by a
tuple predicate over it: pass A by `(strandedAt, kind, symbolId, question)`, pass B by
`(kind, symbolId, question)`. A sweep that reaches the cap stops and persists a cursor naming
the pass and the last tuple examined, in store meta beside the scan summary; the next sweep
resumes from it, and a sweep that finishes clears it. A row written behind the cursor between
sweeps is examined by the next full sweep, which is the one after the current one finishes; a
row deleted behind it costs nothing. What a sweep did is reported as an optional `knowledgeSweep`
field on `ScanCountsSchema`, which `writeScanSummary` persists and `readScanSummary` restores and
`overview` already carries as `scan`: examined, un-stranded, migrated, dated, deleted, and
whether it stopped early. Both the scan and the watcher batch fold the result into the summary
they already write. Optional fields are a minor.

**The clock.** `clock.ts` owns time for the routed modules and its `Clock` is injectable into the
service, but the service builds `WorkspaceIndexer` without one. The indexer gains a `Clock`
parameter, the service passes its own, and the clock residue's routed list grows by `indexer.ts`,
so a `Date.now` in the sweep fails the build. The sweep passes `now` into `sweepOrphans` as a
value, so the store's four existing `Date.now` reads, all write timestamps, stay unrouted and the
aging test sets the clock rather than faking a date in the row.

**What a dated row stops costing, and where it is still seen.** It leaves the stale sweep and the
`STALE_SCAN_CAP` count at once, it never leads the demand queue, and `recallAnswer` records no
demand for it (Phase 1). The workspace demand sweep reads `gaps` and `allAnswers` today, neither
of which carries a date, so the store gains two reads for the window: `strandedRows(limit)`, dated
rows of both tables oldest first, and `strandedCount()`. The sweep excludes dated rows from its
recheck and missing groups, appends `strandedRows` after them inside the page, each carrying
`stranded: true` and `strandedAt`, and reports `strandedCount` as an optional `stranded` number
on the result; `total` keeps counting actionable rows only. A page full of actionable rows shows
no stranded row and still shows the count. The renderer groups the rows under a stranded heading
with their dates. A module scope or subtree walk never holds one, since a stranded row has no
declaration under any scope. That is a window, not a task.

**Storage.** One nullable `strandedAt` column on `answers` and on `gaps`, added in place with
`ALTER TABLE` like every other added column, one atomic statement, an old row reads as not yet
recorded. An index on `strandedAt` for each table, since pass A reads by it. Both columns added to
the fixed insert lists in `restoreKnowledge`, or a rebuild would silently clear every date and
restart every thirty-day count. No compatibility bump, no rebuild, no major.

**Wire.** The gap row gains an optional `strandedAt` and an optional `stranded` flag, never a
fourth `why` value, because clients ride forward and an older client would fail to parse the newer
row. `why` keeps its ordinary value on a stranded row, `stale` for an answer whose citations can
never resolve again and `missing` for demand, so an older client reads it as it always did, and
the renderer checks `stranded` before `why` when choosing the heading and the state word. With
the result's `stranded` count, the `knowledgeSweep` report and Phase 1's recall field, this phase
is a minor.

**Tests:** plant, record, answer, replace the file without the symbol: dated on the next sweep,
absent from the stale count, not at the head of the queue, no demand recorded on recall. Replace
it with a parse failure while the file is present: not dated. Delete the file and recreate it
parsing without the symbol: dated. Put the symbol back: pass A clears the date. Move it to another
module as the only `sameDeclaration` match: migrated, undated, recalled at the new id. Add a
second match: dated, not migrated. Record a different answer at the destination first, then move:
the destination's prose survives and the source row is gone, which pins the collision rule.
Advance the injected clock thirty days with no scan and no event: the timer's sweep deletes it,
so an idle workspace ages. Set the clock behind a date: not deleted. Force a rebuild: the date
survives. Plant more orphans than the cap across both tables: the sweep stops
inside one, reports it, and the next scan finishes from the persisted triple without re-examining
the other. Plant a malformed subject id and a stranded local id: both dated, neither migrated,
neither exempt. An older client parses a row carrying the new fields. Each case watches the old
behaviour fail first.

## Phase 5 - Fan-in seeding per language [deferred, decision-complete]

**The defect:** the cold-start fallback ranks the whole workspace by fan-in. Cross-language calls
do not bind, so any language that is called through a wire rather than an import is under-counted
and ranks last. Kotlin here; a Python extractor beside a TypeScript core elsewhere. The reviewer
who worked the two-language repository confirmed that a raw interleave would put `Protocol.kt`'s
generated containers in front of the console's real doctrine, because they have the highest Kotlin
fan-in and say nothing.

**Recommended design, priced against what the store holds.**

- **Eligible:** not `exported: false`, not generated, and carrying at least one comment anchored
  to the declaration or at least one reference or literal beyond the declaration itself. The three
  counts are answered from indexes that exist: `comments_anchor`, `refs_target`,
  `literals_container`. `exported` is optional on the declaration and stored as null when a
  language cannot answer, so requiring `true` would exclude such a language whole; an unknown is
  eligible and counted in the same report as unknown generated status.
- **Generated, as a three-valued fact, with a path to the row.** The scan learns it from
  `git check-attr` and today `generatedFiles` returns one set of paths, collapsing "not generated"
  and "could not tell", which its one caller uses only to compute reachability and drops. It
  becomes a per-module verdict map, `yes`, `no`, or `unknown` with a reason from a closed enum,
  `noGit` or `gitFailed`, threaded from the scan through `indexFile` into a new `replaceFile`
  parameter and persisted on `files` in two columns added in place, carried by `restoreKnowledge`
  like every other survivor of a rebuild. A watcher batch recomputes its roots through the same
  admission that runs the git call, so it persists a verdict exactly as a full scan does and no
  third reason is needed. Unknown files are eligible, and the seeded result reports how many
  candidates were unknown through an optional `seededUnknown: { generated, exported }` on
  `KnowledgeGapsSchema`, filled by the fallback and rendered as one line under the header, so the
  bias is visible rather than silent.
- **Order within a language:** language-local fan-in, ties by symbol id.
- **Language order:** the store persists no language and every symbol id carries one, so the order
  is derived, not stored: languages sorted by their declaration count descending, ties by name.
  It is stable under rescans and drifts only when the workspace's proportions do.
- **Reserved hubs:** the top five eligible hubs by global fan-in stay at the head, ties by symbol
  id, then the interleave takes one candidate per language in turn. Five is written down so it can
  be argued with. `mostReferenced` gains the eligibility predicate and a tie-break, since today it
  has neither.

**The cheaper form, with its loss stated:** interleave only among comment-bearing declarations,
skip generated status and the reference and literal counts. It costs no column and drops every
eligible declaration that carries substantive facts but no comment, which is a documented loss to
be accepted or not, not an accident.

**Tests, so the phase is done when decided:** a two-language store where one language's top
symbol is a generated container: the container is not seeded, the language's best comment-bearing
declaration is. A `noGit` workspace: candidates seed as unknown and the report says so. A language
that reports no `exported`: its declarations are eligible and counted as unknown. Seeding on a
workspace whose every gap has been answered, not only on one never asked. Equal fan-in ties: the
same order on two runs. The cheaper form: the comment-less substantive declaration is absent and
the test names it.

**Release:** a minor if it persists the generated fact, a patch under the cheaper form. Not in
any release line until the owner decides.

## Doctrine

Add to the rules that already cost something: **a refusal names what the author did and what to
do instead.** "Not in the index" was correct and cost a night: two agents concluded a queue was
exhausted, one re-derived ids by hand for a batch, and one mistake minted demand rows nobody could
answer. The test for a refusal is whether the author can act on it in one turn.

For a bad symbol id specifically, the rule has a shape: the refusal distinguishes an unknown
symbol id, a fact id supplied as the subject, a member id missing its terminator, and a stranded
id whose symbol moved. A reviewer who hit the undistinguished version could not tell which he had
done, and that is the whole cost.

**Every refusal the knowledge layer produces, audited against the rule.** A rule with one named
exclusion and an unlisted remainder is a rule nobody can check. The disposition of each, across
all three shapes a refusal is returned in, `recorded: false`, `refused:` and the citation
checker's `ok: false`:

- Cites nothing: names the fix (cite the facts drawn from). Kept.
- A citation is not a fact id: names the fix (the whole line, never the digest). Kept; it is the
  shape the rest are raised to.
- A citation does not resolve: names both causes and the fix (re-fetch or refuse). Kept.
- Nothing cited about the subject: names the mistake (neighbours describe themselves). Kept.
- Fact id as subject, unminted id, unknown module, stranded id: Phase 0 and Phase 1.
- Prose too long: names the limit and the length. Kept.
- Replacing an answer whose citations still hold: names the fix (`omitting`). Kept.
- The wrong doubt id: names the fix (recall and cite it). Kept.
- **"no doubt stands on the Q answer about X": fails the rule.** It states a condition and no
  action. The catalog phase rewords it to say the answer carries no doubt, so `resolvesDoubt` is
  omitted, and that `invalidate_answer` is how a doubt is raised if one was intended.
- A doubt with no reason: names what the reason is for (the next writer reads it). Kept.
- No answer recorded to re-affirm: names the fix (`record_answer` writes one). Kept.
- Citations no longer resolve on re-affirm: names the count and the fix (check the prose against
  `symbol_facts`, re-affirm with the replacements). Kept.
- Clearing a doubt without citing it: names the fix (recall, read the reason, pass its id). Kept.
- **"an answer needs prose": fails the rule.** It states a condition and no action. The catalog
  phase rewords it to say what to send.
- **"nothing to re-affirm: every citation resolves and no doubt stands": fails the rule.** It
  states a condition and no action, and an author who reached it wanted something. The catalog
  phase rewords it to say the answer is already sound and what to call instead.
- **"nothing is recorded about X to doubt": fails the rule.** It states a condition and no action.
  The catalog phase rewords it to say that doubting an unwritten answer is a request for one, and
  that `record_answer` is how it gets written.

## Verification

Ordered by how much it proves, as the repository already orders it.

- Unit: every phase plants the mistake and watches the old message fail before the new one is
  trusted. The render-shape gate already covers every renderer's output.
- A gate that can fail. Every refusal is composed through one owner, the catalog phase's
  `refusals.ts`, and the refusals reach their three shapes, a `recorded: false`, a `refused:`, or
  the citation checker's `ok: false`, only through it; the fifteen inline literals that exist
  today are the catalog's migration and the gate's first catch. The residue is scoped, not
  workspace-wide: `refused:` has two dozen unrelated instances
  across core and `ok: false` three dozen, in dispatch, the refactor planner, transactions and
  argument parsing, none of them refusals of this layer, so a token sweep over those spellings
  would fail everywhere or be narrowed until it checked nothing. The sweep reads `knowledge.ts` and
  `answers.ts` only, and forbids a string literal composed directly after `reason:` or `refused:`
  anywhere in them, which is the narrowest token a refusal composed inline carries and a
  constructor call does not. The catalog module is exempt because it is the owner, and the citation
  checker's `ok: false` is a catalog member, not a violation. The sweep asserts it found the two
  files and found constructor calls, so a run matching nothing fails. Each constructor is named by
  a test that asserts the returned reason AND the action taken, since a test that merely names a
  reason does not prove the branch ran. The density bar in the repository's rules stays. The gate
  is proven by planting one inline literal per shape in the scoped files and watching each fail.
- Drive the built server: hand each refusal the exact bad input from the overnight logs, a fact
  id as subject, a member id without its terminator, a stranded id, and read what comes back, and
  drive `diagnoseSubject` and one `sweepOrphans` batch through the real daemon.
- Release: **minor** after the catalog phase and Phases 1, 0, 2 and 3 together. Phase 0 adds a
  daemon method, Phase 1 and Phase 3 add optional fields, and the protocol doc prices each as a
  minor; the catalog is internal. Phase 4 is a minor for its optional fields. Phase 5 is priced
  in its own section and is in no release line until decided. Nothing here needs a major: no
  extraction changes and no method is removed or renamed.

## Painpoints

Collected during the overnight knowledge run, the review of its patches, and the refinement laps.

- Two agents read "16 why gaps" as a filter and stopped while why gaps waited under the rechecks.
- Demand rows at dead ids led the queue with the highest ask counts in the store and could not be
  answered. Both agents concluded the queue was empty.
- A fact id in the subject slot got "not in the index" and sent an agent to re-bind the project.
- A member id missing its terminator got the same message, and the agent re-derived ids by hand.
- `invalidate_answer` with a question against an unminted id recorded demand for it, minting the
  ghost rows above from a typo, against a rule the code already stated three functions away.
- The unparsed branch of the subject refusal compared an encoded module field against decoded
  ones, so any module the grammar escapes would have missed its own shortlist.
- The shortlist showed the first eight declarations in store order, which for a 619-symbol module
  was never the one meant.
- The gap header's first fix inferred "mixed" from the visible page, which can lie when the page
  matches and the total underneath does not.
- Comment citations from a module scan were refused because they belonged to a neighbour. That
  refusal is correct and its message already names the fix; it belongs here only because both
  agents hit it three times before reading the message.
- Editing a source file while an agent held its fact ids invalidated 29 citations mid-batch. Also
  correct. The lesson is for the operator: stay out of files an agent is reading from.
- The read tools' "No symbol with ID `...` is indexed. Copy IDs verbatim from a result row." could
  not tell an agent whether the id was stale, malformed, or in the wrong field. Found by review,
  not by the author; it is Phase 0.
- The malformed-citation refusal, "not a fact id at all. Cite the id exactly as symbol_facts
  prints it, the whole space-separated line ending in the digest, never the trailing digest
  alone", was hit and is NOT in this plan on purpose: it already names the mistake and the fix.
  It is the shape every other refusal here is being brought up to.
- Stranded rows are a slow leak, found when the owner asked whether they were. Knowledge rows
  have no link to the declaration and no cleanup on file replace or forget; the only deletes are
  answering a gap and the rename migration. They cost queue position and per-call scan work, and
  they count toward the cap that turns staleness detection off. Phase 4 carries the reclamation
  rule.
- Lap 1 of plan refinement: eight auditors, sixteen findings, sixteen held against the code, none
  dismissed. The plan had been confident about its own cost in three places it had not read: a
  compatibility bump that was a release major and rebuilt rather than refused, a "no wire change"
  that was a minor, and a migration that deletes colliding prose. The storage fix is the pattern
  the store already uses for added columns, `ALTER TABLE` in place, nullable.
- Lap 2 of plan refinement: nine auditors, twenty-five findings, twenty-five held. Two lap 1 fixes
  had not landed: Phase 0 had named the problem of "every tool" and "the token" without naming a
  tool table or a token, and Phase 2 had planned a partial parse the grammar cannot do, since the
  descriptor parser discards everything before a failure. Phase 4 had claimed one transaction with
  a non-re-entrant transaction helper, "never blocks" for an inline synchronous call, a presence
  read in a store that reads only the database, and an un-strand step inside a loop that by
  definition never reaches it. The doctrine's "every refusal" list had missed three and the gate
  swept one of three refusal shapes. Phase 5's nullable generated column had collapsed "not
  generated" and "could not tell" into one absence. The lesson is the plan's own rule turned on
  the plan: a sentence that names a mechanism the code does not have is a refusal that names no
  fix.
- Lap 3 of plan refinement: ten auditors, eighteen findings, eighteen held, one of them only in
  part. Twenty-four of the twenty-five lap 2 fixes had landed. The two blockers were new surface
  from lap 2's own fixes: the presence rule compared a content hash a parse failure never writes,
  so it would have dated the exact file the owner exempted, and the three-shape refusal gate was
  written as a workspace token sweep over spellings with sixty unrelated instances. Both fixes
  were the same move, narrowing to what the code already knows: prune has just computed presence,
  so the sweep reads it instead of the disk, and the gate reads two files instead of the tree.
  The rest were the lap 2 rewrite's own arithmetic: eleven `resolveOne` callers rather than twelve
  with two tools named that never take an id, a cursor over one key for two tables, matchers
  undefined for local ids, a cap placed in a file the sweep cannot import, a clock the indexer was
  never handed, and a "stranded section" beside a flat-row wire. The zero-row gap header was
  found structurally lying while no live path reaches it, since the workspace sweep falls through
  to seeding, and was fixed anyway because the renderer is not supposed to know that.
- Lap 4 of plan refinement: ten auditors, fourteen findings, fourteen held. All eighteen lap 3
  fixes had landed, three of them in part. The blocker was the plan's own enforcement: the
  refusal gate was specified in detail and the catalog it fails the build for was named in no
  phase, so the first phase to land would have failed the gate protecting it, and the four
  doctrine rewordings had waited on the same missing phase in the past tense. The rest were the
  seams the lap 3 fixes created: a cursor shaped for one pass, stranded rows sent to a list whose
  reads cannot see a date, no periodic trigger while Question 4 asks for one, a doubt on a
  stranded answer minting the demand row the plan exists to stop, `refactor_insert` labelled as
  diagnosing when it emits the forbidden token, an `unscanned` reason for a path that does scan,
  and a fallback that skipped parenthesised spans but not the backtick-quoted ones the grammar
  produces. The synthesis judged a fifth broad lap not worth running and a narrow one over the
  catalog seam and Phase 4's store surface worth it.
- Lap 5 of plan refinement, narrow: five auditors, two findings, both held, three angles clean,
  all fourteen lap 4 fixes landed. The periodic trigger had claimed the live index "already takes
  the injected clock", which is true of its option and false of its wiring, since the daemon
  passes none; and the matcher paragraph had left unsaid who applies the predicate to the
  name-indexed rows. The author's own re-read added two kept refusals the doctrine list had
  omitted. Folded without a verifying lap, on the judgement that three clean angles and one
  wiring sentence do not earn a sixth.
