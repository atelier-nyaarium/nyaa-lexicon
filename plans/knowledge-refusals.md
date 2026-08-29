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

**Order and dependencies.** Phase 1 defines the one matcher and the stranded wording that Phase 0
and Phase 4 both use, so it lands first. Phase 0 and Phase 3 are independent of each other. Phase 4
depends on Phase 1's matcher and stranded state. Phase 2 depends on nothing and can land any time.
Phase 5 waits on the owner.

## Phase 1 - One matcher, and a stranded row says it is stranded

**The one matcher.** The id grammar gains two named predicates over parsed descriptors, in
`symbolId.ts`, so nothing outside the grammar decides what "the same declaration" means:

- `sameDeclaration(a, b)`: same language, same kind, same full descriptor path including
  disambiguators and occurrences, different module. This is what authorizes a migration.
- `sameNameAndKind(a, b)`: same language, same kind, same last descriptor name, and for a member,
  the same name on the container descriptor too. Different module. This is what lists candidates
  for a person.

The store answers both through `declarationsNamed`, which is already indexed by name, filtered by
the predicate. Phase 4 uses the strict one; the refusals below use the loose one. The two are
stated here once, and the plan refers to them by name from here on.

**Stranded state, readable by every refusal.** The store exposes `strandedState(symbolId)`:
`{ answers: number, gaps: number, strandedAt: number | null, exempt: boolean }`, where `exempt` is
true when the subject's module is in `parse_failures`. `subjectRefused` reads it before composing,
so the wording agrees with whatever the sweep last left the row in:

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

**Recall stops charging for it.** `recallAnswer` records demand on a miss and on a stale recall
today. A stranded or dated subject records no demand and is excluded from the stale count in
`knowledgeGaps`, or a dated row would re-enter the queue this plan says it leaves.

**Tests:** plant a symbol, record an answer, replace the file without the symbol. `recordAnswer`,
`reaffirmAnswer`, `invalidateAnswer` and `recallAnswer` on the dead id each say stranded and name
the candidates; `recallAnswer` carries the field and records no gap. Plant only a gap row at a
dead id: the demand wording. Put the module into `parse_failures` with the file present: the
waiting wording, nothing dated. Plant two same-named declarations in other modules: both listed as
candidates by `sameNameAndKind`, neither authorized by `sameDeclaration`. Watch the old wording
fail first.

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
returned unvalidated to twelve handlers. It calls `diagnoseSubject` when the id names no
declaration and returns the reason as the problem, so every handler that funnels through it gets
the diagnosis without knowing it. The two paths that take a symbol id without `resolveOne`,
`symbol_source` and `symbol_facts`, call the same helper. The knowledge writers already diagnose in
core and are unchanged.

**Per tool, stated so nothing is implicit:**

- Through `resolveOne`, therefore diagnosed on absence: `describe_symbol`, `find_references`,
  `type_of`, `refactor_move`, `refactor_rename`, `refactor_preview`, `symbol_history`,
  `recall_answer`, `reaffirm_answer`, `invalidate_answer`, `knowledge_gaps` by root, and
  `co_changed_with` by symbol. `type_of` keeps its own three-valued Unknown for the reasons that
  remain after the id is known to exist.
- Direct, calling the helper themselves: `symbol_source`, `symbol_facts`.
- Diagnosing in core already: `record_answer`.
- Taking a module, not a symbol, so out of scope: `outline_module`, `file_history`, `search_*`,
  `find_*` by text.

**The residue.** The token is `is not in the index`, forbidden anywhere under `core/` and
`adapters/` except `subjectRefused`. The six existing instances outside the owner, in `service`
(the `type_of` NotIndexed detail), `sourceWorkspace`, and four sites in `refactorPlanner`, all
take a symbol id that names nothing, which is this concept, so each routes through the diagnosis
and the residue is run against all six before it is trusted. "No symbol named X is indexed" is a
name-lookup miss, a different concept, and is not touched.

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
which returns the descriptors parsed before the failure together with the failure, and the
existing parser is unchanged. The ranking matches declaration names against those descriptor
names. Only when zero descriptors parse does it fall back to matching `quoteName(name)` as a whole
token in the tail, bounded by structural characters, and never inside a `(...)` disambiguator
span, which is skipped as a unit.

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
every question with rechecks first. The renderer names the question only on `true`, and treats an
omitted field as an older peer, which is the only thing omission means once every branch sets it.

**Wire:** an optional field on a result shape is additive, and a minor.

**Tests, each named by the request that reaches its branch:** no arguments reaches the workspace
sweep, `filtered: false`; `{ module }` reaches the module scope, `true`; `{ name }` or
`{ symbolId }` reaches the subtree walk, `true`; no arguments on an empty ledger reaches the seeded
fallback, `true`. Renderer: `true` names the question, `false` does not, omitted does not, with the
lying case planted, a page of matching rows on a mixed total.

## Phase 4 - Orphaned knowledge: dated, migrated, or deleted by the store

Decided by the owner; see Question 4. No agent is ever asked to clean up, and nothing here is a
chore a person performs.

**Orphan:** a row in `answers` or `gaps` whose subject id resolves to no declaration.

**Who does what.** Two owners, because the repository puts source-dependent decisions in the
indexer and facts in the store, and presence is a source-dependent decision.

- The **indexer** orchestrates. After a completed scan, at the point both the full scan and the
  watcher batch already converge on prune, it runs the sweep inline. It is synchronous like prune
  and it is bounded, so it costs the scan a bounded amount; the plan does not claim it costs
  nothing.
- The **store** exposes `sweepOrphans(batch, presence, clock)`: one bounded batch, one transaction.
  `presence` is a function the indexer supplies, answering for a module whether it is present and
  parsing, defined below. The store never touches the filesystem.

**Transactions.** `inTransaction` is a raw `BEGIN`/`COMMIT` and not re-entrant, and the public
`migrateKnowledge` opens its own. The migration body is factored into a non-transactional
primitive used by both: the public method wraps it in a transaction as today, and the sweep calls
the primitive inside its own batch transaction. Each batch is one transaction; the sweep as a
whole is many, which is what lets it stop and resume.

**Presence, decided by the indexer, bound to content.** A module is present and parsing when its
source read is `text` and the read's content hash equals the `files.contentHash` the index holds
for it. `missing`, `binary` and `tooLarge` reads are not present. A file deleted and recreated
under the same path with different content hashes differently, so it is not the same file and its
missing symbol is a real strand.

**Two passes, so the loop can reach what it must.** An orphan-only loop can never un-strand,
because a row whose subject resolves again is not an orphan.

Pass A, over dated rows, read by the `strandedAt` index:

1. **Un-strand** a dated row whose subject resolves again: the date is cleared.
2. **Delete** a row whose date is thirty or more days behind the clock, answers and demand rows
   alike. A date ahead of the clock is treated as now, so a clock that went backwards cannot
   delete early.

Pass B, over undated orphans, read by a keyset over `(symbolId, question)` left-joined to
`symbols`:

3. **Exempt** when the subject's module is in `parse_failures` and `presence` says present. A
   present, failing file may be mid-refactor, and nothing is written for it.
4. **Migrate** when exactly one declaration in the index satisfies `sameDeclaration` from Phase 1.
   The primitive carries answers and demand the way a rename through the refactor tools does. No
   date is set on a move. **Collision:** the migration moves only the questions the destination
   lacks and deletes every remaining source row, so a stranded answer whose question the
   destination already holds is deleted and the destination's prose wins, even where the stranded
   prose was better. That is the current behaviour, kept as written, and it is the one place this
   phase asks the owner to look again.
5. **Date** otherwise: `strandedAt` is set on first sight and left alone after.

**Budget and continuation.** The unit is rows examined per scan across both passes, capped by one
constant beside `STALE_SCAN_CAP`. A sweep that reaches the cap stops, persists its keyset position
in store meta beside the scan summary, and resumes from it on the next scan; a sweep that finishes
clears the position. What it did is reported as an optional `knowledgeSweep` object on the scan
summary and on `overview`: examined, un-stranded, migrated, dated, deleted, and whether it stopped
early. Optional fields are a minor.

**The clock.** The store reads `Date.now` at four sites today and a residue holds one owner for
the routed modules, `clock.ts`, whose `Clock` is injectable. The sweep takes `now` from the clock
the indexer hands it, so the aging test sets the clock rather than faking a date in the row.

**What a dated row stops costing.** It leaves the stale sweep and the `STALE_SCAN_CAP` count at
once, it never leads the demand queue, and `recallAnswer` records no demand for it (Phase 1).
`knowledge_gaps` shows it in a stranded section with its date, so a person can see what is about to
go. That is a window, not a task.

**Storage.** One nullable `strandedAt` column on `answers` and on `gaps`, added in place with
`ALTER TABLE` like every other added column, one atomic statement, an old row reads as not yet
recorded. An index on `strandedAt` for each table, since pass A reads by it. Both columns added to
the fixed insert lists in `restoreKnowledge`, or a rebuild would silently clear every date and
restart every thirty-day count. No compatibility bump, no rebuild, no major.

**Wire.** The gap row gains an optional `strandedAt` and an optional `stranded` flag, never a
fourth `why` value, because clients ride forward and an older client would fail to parse the newer
row. With the `knowledgeSweep` report and Phase 1's recall field, this phase is a minor.

**Tests:** plant, record, answer, replace the file without the symbol: dated on the next sweep,
absent from the stale count, not at the head of the queue, no demand recorded on recall. Replace
it with a parse failure while the file is present: not dated. Delete the file and recreate it
parsing without the symbol: dated. Put the symbol back: pass A clears the date. Move it to another
module as the only `sameDeclaration` match: migrated, undated, recalled at the new id. Add a
second match: dated, not migrated. Record a different answer at the destination first, then move:
the destination's prose survives and the source row is gone, which pins the collision rule.
Advance the injected clock thirty days: gone. Set the clock behind a date: not deleted. Force a
rebuild: the date survives. Plant more orphans than the cap: the sweep stops, reports it, and the
next scan finishes from the persisted position. An older client parses a row carrying the new
fields. Each case watches the old behaviour fail first.

## Phase 5 - Fan-in seeding per language [deferred, decision-complete]

**The defect:** the cold-start fallback ranks the whole workspace by fan-in. Cross-language calls
do not bind, so any language that is called through a wire rather than an import is under-counted
and ranks last. Kotlin here; a Python extractor beside a TypeScript core elsewhere. The reviewer
who worked the two-language repository confirmed that a raw interleave would put `Protocol.kt`'s
generated containers in front of the console's real doctrine, because they have the highest Kotlin
fan-in and say nothing.

**Recommended design, priced against what the store holds.**

- **Eligible:** exported, not generated, and carrying at least one comment anchored to the
  declaration or at least one reference or literal beyond the declaration itself. The three counts
  are answered from indexes that exist: `comments_anchor`, `refs_target`, `literals_container`.
- **Generated, as a three-valued fact.** The scan learns it from `git check-attr` and today
  collapses "not generated" and "could not tell" into one empty set. It is persisted on `files` as
  `generated: yes | no | unknown` with a reason from a closed enum for unknown, `noGit` or
  `gitFailed`, added in place. Unknown files are eligible and the seeded result reports how many
  candidates were unknown, so the bias is visible rather than silent.
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
declaration is. A `noGit` workspace: candidates seed as unknown and the report says so. Equal
fan-in ties: the same order on two runs. The cheaper form: the comment-less substantive
declaration is absent and the test names it.

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
- No standing doubt to clear, or the wrong doubt id: names the fix (recall and cite it). Kept.
- A doubt with no reason: names what the reason is for (the next writer reads it). Kept.
- No answer recorded to re-affirm: names the fix (`record_answer` writes one). Kept.
- **"an answer needs prose": fails the rule.** It states a condition and no action. Reworded to
  say what to send.
- **"nothing to re-affirm: every citation resolves and no doubt stands": fails the rule.** It
  states a condition and no action, and an author who reached it wanted something. Reworded to
  say the answer is already sound and what re-affirming would change if they still want it.
- **"nothing is recorded about X to doubt": fails the rule.** It states a condition and no action.
  Reworded to say that doubting an unwritten answer is a request for one, and that `record_answer`
  is how it gets written.

## Verification

Ordered by how much it proves, as the repository already orders it.

- Unit: every phase plants the mistake and watches the old message fail before the new one is
  trusted. The render-shape gate already covers every renderer's output.
- A gate that can fail. Every refusal is composed through one owner, a catalog of reason
  constructors in the knowledge layer, and a residue fails the build on a refusal composed
  anywhere else, under any of the three shapes: a `recorded: false`, a `refused:`, or a helper's
  `ok: false` carrying a reason. The sweep asserts it found constructors and found call sites, so a
  run matching nothing fails. Each constructor is named by a test that asserts the returned reason
  AND the action taken, since a test that merely names a reason does not prove the branch ran. The
  density bar in the repository's rules stays. The gate is proven by planting a stray refusal under
  each of the three shapes and watching each fail.
- Drive the built server: hand each refusal the exact bad input from the overnight logs, a fact
  id as subject, a member id without its terminator, a stranded id, and read what comes back, and
  drive `diagnoseSubject` and one `sweepOrphans` batch through the real daemon.
- Release: **minor** after Phases 1, 0, 2 and 3 together. Phase 0 adds a daemon method, Phase 1
  and Phase 3 add optional fields, and the protocol doc prices each as a minor. Phase 4 is a minor
  for its optional fields. Phase 5 is priced in its own section and is in no release line until
  decided. Nothing here needs a major: no extraction changes and no method is removed or renamed.

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
