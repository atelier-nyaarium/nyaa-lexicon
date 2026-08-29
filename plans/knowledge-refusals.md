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
A: Undecided. Phase 5 lays out the options with a recommendation.

# Plan

The rule this plan installs, stated once: **a refusal names what the author did and what to do
instead, or it is not finished.** Every phase below is that rule applied to one message, plus the
two design questions the overnight run surfaced.

## Phase 0 - One diagnosis for a bad subject id, reached from every tool

**Found by review, not by the author.** The overnight patches taught `record_answer`,
`reaffirm_answer` and `invalidate_answer` to tell a fact id from an unminted member id from an
unknown symbol. The READ tools never learned. `describe_symbol`, `symbol_facts`, `type_of` and
their siblings still answer "No symbol with ID `...` is indexed. Copy IDs verbatim from a result
row." That is the message an agent hit for a member id missing its terminator, and it could not
tell which of the three mistakes it had made. Same class, different door.

**What:** the subject diagnosis in `subjectRefused` becomes the one owner every tool reaches when
a symbol id names nothing: fact id as subject, unminted id with the module's shortlist, stranded
id with its live candidates, or genuinely unknown. The adapter stops composing its own sentence.

**How it is reached:** either the daemon's lookups return the diagnosis beside the null, or one
new read method answers it. A new method grows the table, which is allowed within a protocol
major; a changed result shape is additive only if the field is optional. Decide at implementation,
and write the residue that keeps a second phrasing from appearing in the adapter.

**Tests:** each of the four mistakes, handed to `describe_symbol`, produces the same sentence
`record_answer` produces for it. A sweep fails the build on the old "is indexed" phrasing anywhere
under the adapter.

## Phase 1 - A stranded answer says it is stranded

**What:** `subjectRefused` gains one branch. When the subject has no declaration but DOES have
recorded answers, that is the moved-symbol case, and today's refusal says "not in the index" and
lists the module, which is true and misses the point. The refusal says the answers recorded under
this id are stranded because the symbol is gone, and points at the live id in the shortlist so the
prose can be recorded again where a reader will find it.

**Where else it shows:** `recallAnswer` on a stranded id returns the answer as STALE with the
reaffirm instruction, and reaffirm cannot succeed because there is nothing current to cite. The
status line says stranded instead, and names the re-record path. `renderKnowledge` carries it.

**The live candidates:** the module is the thing that changed, so the shortlist for a stranded id
is NOT the old module's declarations. It is every declaration in the index with the same name and
kind, and for a member, the same name under a container of the same name. One hit is the answer.
Several are listed. None means the symbol is gone, and the prose is worth keeping only by hand.

**Why now:** it turns Question 4 from a blocking design decision into something an author can act
on today, by hand, with the prose preserved. The migration question stays open without costing
anyone the answer in the meantime.

**Tests:** plant a symbol, record an answer, replace the file without the symbol. `recordAnswer`,
`reaffirmAnswer` and `recallAnswer` on the dead id each say stranded and name the live shortlist.
Watch the old wording fail first.

## Phase 2 - The shortlist matches names at a boundary

**What:** the shortlist promotes declarations whose name appears in the bad id by substring, so a
name like `at` or `to` is promoted by any id containing those letters. Match the name at the id
grammar's structural boundaries instead: at the start of the descriptor tail or after a structural
character, and followed by the end or a structural character.

**Tests:** plant `at` and `Total`. A bad id naming `Total` lists `Total` first and does not promote
`at`. A bad id naming `at` still finds it.

## Phase 3 - The gap header is told whether it filtered

**What:** `renderKnowledgeGaps` decides whether to name the asked question by inferring which core
branch produced the rows, which mirrors the core's structure into the renderer. The core says so
instead. `KnowledgeGapsSchema` gains an optional `filtered: boolean`, true when every row honours
the asked question. The seeded, module and subtree branches set it. The workspace demand sweep,
which deliberately carries every question with rechecks first, leaves it unset. The renderer reads
the flag and the scope inference goes.

**Wire:** an optional field on a result shape is additive. No protocol major.

**Tests:** core, that `moduleGaps` and the seeded fallback flag filtered and the workspace sweep
does not. Renderer, that a flagged result names the question and an unflagged one does not, with
the lying case planted: a page of matching rows on a mixed total.

## Phase 4 - Orphaned knowledge: dated, migrated, or deleted by the store

Decided by the owner; see Question 4. The store does this inside the scan. No agent is ever asked
to clean up, and nothing here is a chore a person performs.

**Orphan:** a row in `answers` or `gaps` whose subject id resolves to no declaration.

**The sweep.** Runs after each scan completes, in the indexer, over both tables. For each orphan,
in this order:

1. **Exempt** when the subject's module exists on disk and is in `parse_failures`. That file may be
   mid-refactor, and a date set now would count down on a symbol that is coming back. Nothing is
   written for it.
2. **Migrate** when exactly one declaration in the index has the same name, kind and descriptor
   shape in a different module. `migrateKnowledge` carries the answers and demand to it, the way a
   rename through the refactor tools already does. No date is ever set on a move. The guard is
   uniqueness, and it is the only thing separating a move from a copy, a split, a wrapper or a
   regenerated declaration; where it fails, the row is dated and waits.
3. **Date** otherwise: `strandedAt` is set on first sight and left alone after.
4. **Un-strand** any dated row whose subject resolves again: the date is cleared on that scan.
5. **Delete** any row dated thirty or more days ago, answers and demand rows alike.

**What a dated row stops costing.** It leaves the stale sweep and the `STALE_SCAN_CAP` count at
once, it never leads the demand queue, and `knowledge_gaps` shows it in a stranded section with
its date, so a person can see what is about to go. That is a window, not a task.

**Storage:** one nullable `strandedAt` column on each table, a store-compatibility bump so an
older core refuses the newer store honestly, no wire change, no protocol major.

**Tests:** plant, record, answer, then replace the file without the symbol: dated on the next
sweep, absent from the stale count, not at the head of the queue. Replace it with a parse failure
instead: not dated. Put the symbol back: date cleared. Move it to another module as the only
candidate: migrated, undated, recalled at the new id. Add a second candidate: dated, not migrated.
Age a date past thirty days: gone. Each case watches the old behaviour fail first.

**Why the leak mattered.** `answers` and `gaps` are keyed by `(symbolId, question)` with no link
to the declaration, and `replaceFile` and `forgetFile` clear the fact tables only, so a hand move
left both rows for the life of the store. A dead demand row held the head of the queue by ask
count. A stranded answer was stale forever, so every workspace `knowledge_gaps` call resolved its
citations and listed it as work nobody could do, and it counted toward the cap past which
staleness detection switches off. The sweep above is what closes it.

## Phase 5 - Fan-in seeding per language [decision]

**The defect:** the cold-start fallback ranks the whole workspace by fan-in. Cross-language calls
do not bind, so any language that is called through a wire rather than an import is under-counted
and ranks last. Kotlin here; a Python extractor beside a TypeScript core elsewhere.

**Options:** rank within each language present in the index and interleave, so every language's
best candidates appear in the first page. Or weight by each language's share of declarations. Or
leave the global ranking as it is.

**What the reviewer who worked the two-language repository said:** a raw interleave would have
put `Protocol.kt`'s generated containers in front of the console's real doctrine, because they
have the highest Kotlin fan-in and say nothing. Fan-in is the wrong primary signal for a language
nothing binds into. A comment-bearing declaration is the better one: it is where that half of the
repository keeps its reasoning, and it is what the run actually found worth recording.

**Recommendation:** filter, then interleave. Candidates are exported, non-generated declarations
that carry a comment or substantive facts; generated containers and declaration-only shells are
out before ranking. Within a language, order by language-local fan-in. Across languages, take one
strong candidate per language in turn, and keep the workspace's top global hubs at the head so
the protocol and core symbols a newcomer needs are not pushed under an obscure provider's best
representative. Saying so in the `knowledge_gaps` description is honesty, not a substitute for
any of that.

## Doctrine

Add to the rules that already cost something: **a refusal names what the author did and what to
do instead.** "Not in the index" was correct and cost a night: two agents concluded a queue was
exhausted, one re-derived ids by hand for a batch, and one mistake minted demand rows nobody could
answer. The test for a refusal is whether the author can act on it in one turn.

For a bad symbol id specifically, the rule has a shape: the refusal distinguishes an unknown
symbol id, a fact id supplied as the subject, a member id missing its terminator, and a stranded
id whose symbol moved. A reviewer who hit the undistinguished version could not tell which he had
done, and that is the whole cost.

## Verification

Ordered by how much it proves, as the repository already orders it.

- Unit: every phase plants the mistake and watches the old message fail before the new one is
  trusted. The render-shape gate already covers every renderer's output.
- A gate that can fail: every refusal reason the knowledge layer produces is exercised by a test
  that plants its mistake. A residue sweep collects each `recorded: false` reason literal from the
  layer and fails the build on one that no test names. Both reviewers called the density target
  a number that gates nothing, and they were right; this replaces it.
- Drive the built server: hand each refusal the exact bad input from the overnight logs, a fact
  id as subject, a member id without its terminator, a stranded id, and read what comes back.
- Release: patch after phases 1 to 3, since nothing changes extraction or the method table.
  Phases 4 and 5 ship when decided; neither needs a major.

## Painpoints

Collected during the overnight knowledge run and the review of its patches.

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
