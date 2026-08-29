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

## Question 4 - Does knowledge follow a symbol that moves? [Open, owner's call]

Q: `currentHost` moved from `core` to `client`. Its answer is stranded at the dead id, permanently
STALE, citing facts that can never resolve. Its prose is better than what a fresh reader wrote for
the live symbol, and `recall_answer` on the live symbol never shows it. Demand rows strand the same
way and lead the gap list, which both agents read as the queue being exhausted. What should happen?
A: Undecided. Phase 4 lays out the options with a recommendation.

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

## Phase 4 - Knowledge that follows a moved symbol [decision]

Three options, cheapest first. They compose.

**Surface it.** `knowledge_gaps` gains a state, STRANDED, for a demand row or an answer whose
subject no longer resolves. Stranded rows do not merely sort last, where a long list buries them:
they render as their own section after the live rows, each with its prose and its live candidates
from Phase 1, so re-homing is a read and a `record_answer`, not a search. Honest, cheap, and it
never guesses.

**Demote it.** At minimum, rows whose subject does not resolve never lead the list. This is the
part of the first option that costs nothing to decide.

**Migrate on detection.** When a declaration with the same name and descriptors appears in a new
module after its old id vanished, treat it as a move and carry answers and demand forward, the way
`migrateKnowledge` already does for a rename through the refactor tools. A hand move, an edit plus
a `git mv`, is how files usually move, and it bypasses that path entirely. Both reviewers rejected
this as the default: "exactly one new module" does not distinguish a move from a copy, a split, a
wrapper, or a regenerated declaration, and each of those would attach prose to the wrong symbol
silently. If it ever ships, detection proposes the candidate and a person or an agent confirms
the migration explicitly; it never applies itself.

**Recommendation:** surface and demote now, in one change. Migration stays a proposal, never an
action, because a wrong migration is the one lie this project exists to stop telling.

**Reclaim it [proposed, unbuilt].** Surfacing fixes visibility; nothing above frees a row. The
store keeps `answers` and `gaps` keyed by `(symbolId, question)` with no link to the declaration,
and `replaceFile` and `forgetFile` clear the fact tables only, so a hand move leaves both rows for
the life of the store. The cost is not memory. A dead demand row holds its slot at the head of the
queue by ask count forever. A stranded answer is stale forever, so the recheck sweep resolves its
citations on every workspace `knowledge_gaps` call and lists it as work nobody can do, and it
counts toward `STALE_SCAN_CAP`, past which staleness detection switches off for the whole
workspace. The rule is asymmetric because the two rows are worth different amounts:

- A stranded **answer** is kept. It is prose somebody wrote and may re-home. It leaves the stale
  sweep and the cap count, and appears only in the stranded section.
- A stranded **demand row with no answer** is deleted once it has been shown as stranded. Nothing
  can ever satisfy it, and its only remaining effect is to occupy the queue.

**Tests:** plant, record, answer, replace the file without the symbol. The workspace gap list
shows the answer as stranded and does not count it as stale; the demand row is gone after one
listing; the cap arithmetic excludes stranded answers.

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
