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

**How it is reached:** one new read method on the daemon answers the diagnosis for any id. A new
method grows the table, which the protocol doc prices as a **minor**, the same as a new optional
field. Decide at implementation whether the adapter calls it on every absence or the daemon's
lookups return it beside the null; either way the sentence is composed in one place.

**Per tool, because "every tool" was found not to mean one thing.** Only `describe_symbol` and
`symbol_facts` compose the absence sentence today. `type_of` never checks absence: it renders the
type's own Unknown, which already carries `NotIndexed` as its reason, so it stays three-valued and
gains nothing from the diagnosis. `find_references` never checks either and answers an empty list
for an absent id, which reads as "nothing uses it" and is the wrong answer; it calls the diagnosis.
The implementation enumerates every tool that takes a symbol id and states, per tool, which of the
two it does. No tool is left implicit.

**The residue, matched on the token and not the phrase.** "is indexed" is the wrong token: the
adapter also says "No symbol named X is indexed" for a name-lookup miss, which is deliberate and
stays, and core spells the same bad-subject concept "is not in the index" in `service`,
`sourceWorkspace` and `refactorPlanner`. The sweep forbids the narrowest token that only the owner
may compose, scoped by concept rather than by directory, and it is run against every existing
instance listed above before it is trusted, as the repository's rule for residues requires.

**Tests:** each of the four mistakes, handed to `describe_symbol`, `symbol_facts` and
`find_references`, produces the sentence `record_answer` produces for it; `type_of` produces its
Unknown with `NotIndexed`. The residue is planted and watched failing before it is kept.

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

**Why it is its own phase:** Phase 4 decides what the store does with a stranded row over time.
This phase decides what an author is told the moment they touch one, which is needed on day one
and in the window before the sweep has run or migrated. Execution is Phase 4's; the wording is
this phase's, and it must agree with whatever state the sweep has left the row in.

**Tests:** plant a symbol, record an answer, replace the file without the symbol. `recordAnswer`,
`reaffirmAnswer` and `recallAnswer` on the dead id each say stranded and name the live shortlist.
Watch the old wording fail first.

## Phase 2 - The shortlist matches names at a boundary

**What:** the shortlist promotes declarations whose name appears in the bad id by substring, so a
name like `at` or `to` is promoted by any id containing those letters. The first fix proposed
matching at structural characters, and the audit showed that is still wrong twice: a disambiguator
sits raw between parentheses, so a declaration named `to` matches inside `(to)` where `to` is not a
name, and `quoteName` wraps any name carrying a structural character in backticks, doubling inner
ones, so the raw `declaration.name` is never found in the encoded tail for such a name. Compare
against what the grammar actually produces instead: parse the bad id as far as it goes and match
declaration names against the parsed descriptor names, falling back to `quoteName(name)` against
the tail when the id does not parse. The grammar owns the spelling; the ranking borrows it.

**Tests:** plant `at` and `Total`; a bad id naming `Total` lists `Total` first and does not promote
`at`, and one naming `at` still finds it. Plant a declaration named `to` and a bad id whose
disambiguator is `to`: not promoted. Plant a name that quotes, such as one carrying a dot: found.

## Phase 3 - The gap header is told whether it filtered

**What:** `renderKnowledgeGaps` decides whether to name the asked question by inferring which core
branch produced the rows, which mirrors the core's structure into the renderer. The core says so
instead. `KnowledgeGapsSchema` gains an optional `filtered: boolean`, true when every row honours
the asked question. The seeded, module and subtree branches set it. The workspace demand sweep,
which deliberately carries every question with rechecks first, leaves it unset. The renderer reads
the flag and the scope inference goes.

**Wire:** an optional field on a result shape is additive, and the protocol doc prices it as a
**minor**, not a patch. No protocol major.

**Tests:** core, that `moduleGaps`, the seeded fallback and the subtree walk each flag filtered,
and the workspace sweep does not; the subtree walk is the third return path and was unlisted until
the audit named it. Renderer, that a flagged result names the question and an unflagged one does
not, with the lying case planted: a page of matching rows on a mixed total.

## Phase 4 - Orphaned knowledge: dated, migrated, or deleted by the store

Decided by the owner; see Question 4. The store does this inside the scan. No agent is ever asked
to clean up, and nothing here is a chore a person performs.

**Orphan:** a row in `answers` or `gaps` whose subject id resolves to no declaration.

**Who owns it.** The store exposes one sweep as a single method, and that method runs every step
below inside one transaction: candidate selection, the uniqueness read and the migration it
authorizes are never separate operations, because a reindex landing between them would migrate
onto a declaration that just vanished. The indexer invokes it once, after a completed scan, at the
same point both the full scan and the watcher batch already converge on prune. "In the store" and
"in the indexer" were two descriptions of the same thing; this is the one.

**Orphan:** a row in `answers` or `gaps` whose subject id resolves to no declaration.

**The sweep.** For each orphan, in this order:

1. **Exempt** when the subject's module is in `parse_failures` AND its file is present. The store
   records only `(module, reason)` for a failure, so presence is a read the sweep makes itself,
   through the workspace's own source reader, never a bare filesystem call, and it is bound to
   content: a file deleted and recreated under the same path is present and parsing, so its
   missing symbol is a real strand, not an exemption. A present, failing file may be mid-refactor
   and nothing is written for it.
2. **Migrate** when exactly one declaration in the index matches. "Matches" is defined once, as
   one matcher in the id grammar over the parsed descriptors: same name, same kind, same descriptor
   path including disambiguators and occurrences, in a different module. The store does not hold
   descriptor shape as a column; the matcher parses both ids. `migrateKnowledge` then carries the
   rows the way a rename through the refactor tools already does. No date is ever set on a move.
   **Collision, stated because the code decides it today:** the migration moves only the questions
   the destination lacks and deletes every remaining source row. So a stranded answer whose
   question the destination already holds is deleted, and the destination's prose wins, even where
   the stranded prose was better. That is the current behaviour, kept as written, and it is the one
   place this phase asks the owner to look again. The guard is uniqueness, and it is the only thing
   separating a move from a copy, a split, a wrapper or a regenerated declaration; where it fails,
   the row is dated and waits.
3. **Date** otherwise: `strandedAt` is set on first sight and left alone after.
4. **Un-strand** any dated row whose subject resolves again: the date is cleared on that scan.
5. **Delete** any row whose date is thirty or more days behind the clock, answers and demand rows
   alike. A date ahead of the clock is treated as now, so a clock that went backwards cannot delete
   early.

**The clock.** The store reads `Date.now` directly at four sites today, and a residue already holds
one owner for the routed modules. The sweep takes its now from that owner, injected, so the aging
test sets the clock rather than waiting thirty days or faking a date in the row.

**Cost at scale.** `gaps` has a bounded read and `allAnswers` does not, and the knowledge layer
already refuses a full answer scan past `STALE_SCAN_CAP`. The sweep reads orphans through paged,
indexed queries and mutates in bounded batches, and when it exceeds its budget in one scan it
stops, reports how far it got the way the stale scan reports `staleScanSkipped`, and resumes on the
next scan. It never blocks the scan that invoked it.

**What a dated row stops costing.** It leaves the stale sweep and the `STALE_SCAN_CAP` count at
once, and it never leads the demand queue. `knowledge_gaps` shows it in a stranded section with
its date, so a person can see what is about to go. That is a window, not a task.

**Storage, corrected by the audit.** The plan first asked for a store-compatibility bump "so an
older core refuses the newer store". That was wrong twice: the compatibility key is the release
major and nothing else, so it cannot move without a major, and a mismatch does not refuse, it drops
every table and rebuilds. The store already has the right pattern: a nullable column added in
place with `ALTER TABLE`, one atomic statement, an old row reads as not yet recorded. `strandedAt`
goes onto both tables that way. No bump, no rebuild, no major. Because a rebuild still salvages
knowledge through fixed column lists in `restoreKnowledge`, the column is added to both inserts
there too, or a rebuild would silently clear every date and restart every thirty-day count.

**Wire, corrected by the audit.** Showing a stranded row with its date is a wire change: the gap
row's `why` is a closed enum and carries no date. It gains an optional `strandedAt` and an optional
`stranded` flag, never a fourth `why` value, because clients ride forward and an older client
would fail to parse the newer row. The protocol doc prices an optional field as a **minor**, and
that is what this phase is.

**Tests:** plant, record, answer, then replace the file without the symbol: dated on the next
sweep, absent from the stale count, not at the head of the queue. Replace it with a parse failure
while the file is present: not dated. Delete the file and recreate it parsing without the symbol:
dated. Put the symbol back: date cleared. Move it to another module as the only candidate:
migrated, undated, recalled at the new id. Add a second candidate: dated, not migrated. Record a
different answer at the destination first, then move: the destination's prose survives and the
source row is gone, which pins the collision rule. Advance the injected clock thirty days: gone.
Set the clock behind a date: not deleted. Force a rebuild: the date survives. An older client
parses a row carrying the new fields. Each case watches the old behaviour fail first.

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

**What the audit found the recommendation resting on.** Generated status is not a fact the store
holds. It is a scan-time `git check-attr linguist-generated` lookup in `generatedFiles`, consumed
while scoping files and never written to a declaration. So "non-generated" is either a new
persisted per-file fact, one nullable column on `files` set by the scan, or it is not available to
the seed at all. The rest of the filter was named without a predicate. Before the owner decides,
the recommendation is priced as follows, and each item is a line the implementation must write:

- **Generated:** persisted on `files` at scan time, nullable, added in place like every other
  column here. Cost is one column and one write per scanned file.
- **Comment-bearing:** at least one comment fact anchored to the declaration, which the store can
  answer from the comments table by anchor id. **Substantive facts** means at least one reference
  or literal fact beyond the declaration itself. Both are one indexed count each.
- **Language order:** the order languages first appear in the index, fixed for the life of the
  store, so the interleave is stable as files are added. **Tie-break** within a language is by
  symbol id, so two runs over one store agree.
- **Reserved hubs:** the top five global hubs by fan-in stay at the head regardless of language,
  then the interleave begins. Five is a number to be argued with, and it is written down so it can
  be.

The cheaper alternative, if the owner does not want a new persisted fact: interleave only among
comment-bearing declarations and skip generated status entirely, accepting that a generated file
with comments still competes. That is honest about what the store knows and costs no column.

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
exclusion and an unlisted remainder is a rule nobody can check. The disposition of each:

- Cites nothing: names the fix (cite the facts drawn from). Kept.
- A citation is not a fact id: names the fix (the whole line, never the digest). Kept; it is the
  shape the rest are raised to.
- A citation does not resolve: names both causes and the fix (re-fetch or refuse). Kept.
- Nothing cited about the subject: names the mistake (neighbours describe themselves). Kept.
- Fact id as subject, unminted id, unknown module: rewritten overnight; Phase 0 spreads them.
- Prose too long: names the limit and the length. Kept.
- Replacing an answer whose citations still hold: names the fix (`omitting`). Kept.
- No standing doubt to clear, or the wrong doubt id: names the fix (recall and cite it). Kept.
- **"an answer needs prose": fails the rule.** It states a condition and no action. Reworded to
  say what to send.
- **"nothing to re-affirm: every citation resolves and no doubt stands": fails the rule.** It
  states a condition and no action, and an author who reached it wanted something. Reworded to
  say the answer is already sound and what re-affirming would change if they still want it.

## Verification

Ordered by how much it proves, as the repository already orders it.

- Unit: every phase plants the mistake and watches the old message fail before the new one is
  trusted. The render-shape gate already covers every renderer's output.
- A gate that can fail, corrected by the audit. The first version swept `recorded: false` reason
  literals, and there are almost none: every reason is an interpolated template built inside a
  helper and returned through a caller. The gate sweeps construction sites instead. Every refusal
  is composed through one owner, a catalog of reason constructors, and the residue fails the build
  on a `recorded: false` composed anywhere else, asserts it found constructors to check so a run
  matching nothing fails, and requires each constructor to be named by a test that asserts the
  returned reason AND the action taken, since a test that merely names a reason does not prove
  the branch ran. The density bar in the repository's rules stays; it was never this gate's to
  replace, and this gate is proven by planting a stray refusal and watching it fail.
- Drive the built server: hand each refusal the exact bad input from the overnight logs, a fact
  id as subject, a member id without its terminator, a stranded id, and read what comes back.
- Release, corrected by the audit: **minor** after Phases 0 to 3. Phase 0 adds a daemon method
  and Phase 3 an optional field, and the protocol doc prices each as a minor, not a patch. Phase 4
  is a minor for its optional gap-row fields. Phase 5 ships when decided, a minor if it persists
  the generated flag, a patch if it takes the cheaper form. Nothing here needs a major: no
  extraction changes and no method is removed or renamed.

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
- Lap 1 of plan refinement: eight auditors, sixteen findings, sixteen held against the code, none
  dismissed. The plan had been confident about its own cost in three places it had not read: a
  compatibility bump that was a major and rebuilt rather than refused, a "no wire change" that was
  a minor, and a migration that deletes colliding prose. A plan should be audited at the same bar
  as the code it describes, and this one was not until it was.
