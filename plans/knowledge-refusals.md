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
for a proposal-only form; the owner heard that and decided. Question 9 later replaced "migration"
with rebinding an address, which honours every requirement here without moving a row.

> "we need to do more than just make them visible. don't make the AI clean it up either. that
> would just be stupid."

> "Being able to detect all orphans in the database. Periodic checks to date them. But if the file
> exists and is just failing to parse, don't strand date that file. It could literally be in the
> middle of a long refactor. Stranded entries that get unstranded remove date next scan."

> "Auto migration as you suggested." ... "Orphans deleted after 30 days."

## Question 5 - Should fan-in seeding rank within a language? (settled in chat)

Q: References do not bind across Kotlin and TypeScript, so the console's fan-in counts only its
own callers and ranks permanently below the server, even where its doctrine is as deep. The agent
confirmed the Kotlin comments carry the same weight. Should seeding rank per language?
A: Yes, the full design in Phase 5: eligibility, generated persisted as a three-valued fact,
language order derived from declaration counts, five reserved global hubs, `seededUnknown`
reported. It lands after the replan point, with Phase 4, since both rewrite the seeding path in
`knowledgeGaps`. The cheaper form is not taken.

> "A."

## Question 6 - When a migration collides, what wins? [Superseded by Question 9]

Q: Migration fires only when exactly one same-shaped declaration exists elsewhere, and the sweep
runs in the batch that saw the change, so a destination holding an answer to the same question
held it before the move. Keep the destination's prose, keep the newer, carry the stranded prose as
a doubt, or refuse to migrate?
A: The owner chose the destination. Superseded: under Question 9 knowledge never moves between
subjects and two subjects never merge, so the collision cannot occur.

> "A"

## Question 7 - What counts as move evidence? [Folded into Question 9]

Q: Shape alone cannot tell a move from a surviving twin: two files each declaring `const db`,
one deleted, and the survivor is the only match without being a move target. Proposed evidence:
the destination's module was first indexed in the same scan or batch that forgot the source.
A: Not answered on its own; the owner asked to explore a concept that could supersede it. The
evidence survives inside Question 9's closed evidence set as `batchExactMatch`.

> "I'm afraid of committing to any answers yet. let's explore another concept that could
> supercede it."

## Question 8 - A heuristic signature as the key? [Folded into Question 9]

Q: Key knowledge by the declaration's code pattern (kind, name, comment-stripped text, hashed) so
twenty identical `const db = blah();` share one answer and a moved file keeps its knowledge.
A: As evidence, never as the key. Six investigators priced it and the author measured the twin
rate: about fourteen percent of body-bearing declarations have a same-shaped twin in another file
(an upper bound by provider header and metrics), nearly all of them one-to-three-line test setup
constants; substantive twins are under half a percent. Answers are contextual, grounded in
references, imports, comments and other answers, so identical text can carry different answers;
citations are bound to one holder's module and position; the name is in the signature, so a rename
would change the key. The pattern digest survives as `batchExactMatch` evidence and nothing more.

> "Heirustics signature as a key. Based on the pattern of code, that is the signature. Regardless
> of comments around it, we know `const db = blah();` is always intending to do exactly the thing
> it's trying to do. We don't need 20 of the same defs."

## Question 9 - What is knowledge about, and what identity survives which transition? (settled in chat)

Q: Every option so far treated identity as something the knowledge rows carry, so every identity
change was a row rewrite with a merge policy. A second opinion from a Sol agent named the frame
and a fifth option: knowledge is about a durable logical declaration, held by an opaque subject
id, with the symbol id as its current address, rebound through one owner on move or rename, the
signature demoted to closed-valued evidence, twins distinct, subjects never merged. The author
vetted it against the code and moved to it.
A: Adopted. The identity phase below specifies it. It says no to sharing: twenty identical
definitions are twenty subjects, because an answer about one may not be true of another, and the
measured substantive cases are under half a percent.

> "Our /architecture goal is always high engineering. Not laziness because our codebase is
> somewhat solid. Think critical about a strong foundation."

> "ok if you like E, lock it in"

## Question 10 - A writes fact in core [Open, after the identity phase]

Q: Does any fact say whether a function mutates its parameters or its class's properties?
A: Not yet. References carry a `write` role that the TypeScript, C, C++, C# and Rust providers
mark on assignment targets, including property writes bound to the property with the enclosing
declaration recorded, and nothing in core consumes it. A three-valued derivation in core is
possible without a provider change and is wanted for its own sake. It is its own question after
this plan, held on the board.

> "I actually want that to exist in core for side goal reasons. perhaps a question after E.
> excellent potential IDE info."

# Plan

The rule this plan installs, stated once: **a refusal names what the author did and what to do
instead, or it is not finished.** Every phase below is that rule applied to one message, plus the
identity model the overnight run's stranded knowledge turned out to need.

Phases read as a specification. What each phase looked like before an audit corrected it, and why,
lives under Painpoints, so an implementer meets only the current design here.

**Order and dependencies.** The catalog phase lands first, because the gate in Verification fails
the build on any refusal composed outside it, so every later phase's wording is a constructor. The
identity phase lands second: every later phase reads knowledge through it. Phase 1 defines the
candidate predicate and the stranded wording that Phase 0 and Phase 4 both use, so it lands third.
Phase 0 and Phase 3 are independent of each other. Phase 4 depends on the identity phase and on
Phase 1. Phase 2 depends on the catalog only. Phase 5 waits on the owner.

## The catalog phase - Every refusal is a named constructor in one module

✅ Shipped: the catalog and its residue (39832c9), the brand (7cfcc1c), the doc and the rule
(23c8556, 6c21819). `strandedId` and `movedId` land with Phases 1 and 0.

**What:** the knowledge layer composes fifteen refusal strings inline today, eleven in the ledger
and four in the citation checker, plus the four diagnoses `subjectRefused` composes. They move
into `core/src/refusals.ts`, one exported constructor per refusal, each returning the finished
sentence; `subjectRefused` moves there with them, since it is the constructor that reads the
store. The ledger and the checker keep their three return shapes, `recorded: false`, `refused:`
and `ok: false`, and put a constructor's result in the reason slot. The refactor planner and the
service reach `subjectRefused` from the same module when Phase 0 routes them.

**The brand.** A constructor returns `Refusal`, a branded string only the owner mints through its
one cast, and the ledger's outcomes and the checker's result are typed with it in core
(`LedgerRecordOutcome`, `LedgerInvalidateOutcome`, narrowed views of the wire shapes), so a raw
sentence in a reason slot anywhere in core is a type error. The brand widens to the wire's
`string` by subtyping, so the protocol schemas and every adapter are untouched. A cast is the way
past a brand, in several spellings, and an `any` is another the type checker cannot see; the
residue in Verification sweeps core for every minting spelling outside the owner, and `any` is
the one hole it states rather than closes.

**The constructors, by the branch each replaces:** `needsProse`, `proseTooLong`, `noDoubtStands`,
`wrongDoubtId`, `replacesSoundAnswer`, `doubtNeedsReason`, `nothingToDoubt`,
`noAnswerToReaffirm`, `citationsNoLongerResolve`, `nothingToReaffirm`, `clearingRequiresCiting`,
`citesNothing`, `malformedCitations`, `unresolvedCitations`, `citesOnlyNeighbours`, and the
diagnoses `factIdAsSubject`, `unmintedId`, `strandedId`, `movedId`, `unknownModule`,
`unparsableId`. The last two are the two branches of Phase 0's `unknown` outcome: a module that
is not indexed, and a spelling with no module to read. A constructor takes the values its
sentence names and nothing else.

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

**Release:** internal. No wire shape changes; the same reasons reach the same slots.

## The identity phase - Knowledge is about a subject, and the symbol id is its address

Decided by the owner; see Question 9.

**What knowledge is about.** A durable logical declaration, called a subject. A position is where
its evidence sits. A symbol id is its address, durable within a module and re-minted on a move or
a rename. Declaration text is an observation twins can share. A fact set is grounding at one
revision. None of those is the subject, so none of them is the key.

**The owner.** One module, `core/src/subjects.ts`, over one new table:

```
knowledge_subjects (
  subjectId        TEXT PRIMARY KEY,            -- opaque, minted once
  currentSymbolId  TEXT NOT NULL UNIQUE,        -- the address, kept across orphaning
  state            TEXT NOT NULL CHECK (state IN ('bound', 'orphaned')),
  boundAt          INTEGER NOT NULL,
  orphanedAt       INTEGER,                     -- the thirty-day clock
  fromSymbolId     TEXT,                        -- the address vacated by the last rebind
  evidence         TEXT NOT NULL CHECK (evidence IN ('sameLocator', 'journalMove',
                     'journalRename', 'batchExactMatch', 'ambiguous', 'none')),
  lastDigest       TEXT,                        -- the address's pattern digest when last seen bound
  lastCoverage     TEXT,                        -- commentsStripped | commentsKept, null with no digest
  CHECK ((state = 'bound' AND orphanedAt IS NULL) OR (state = 'orphaned' AND orphanedAt IS NOT NULL)),
  CHECK (lastCoverage IS NULL OR lastDigest IS NOT NULL)
)
CREATE INDEX knowledge_subjects_orphaned ON knowledge_subjects(orphanedAt);
CREATE INDEX knowledge_subjects_state ON knowledge_subjects(state);
CREATE INDEX knowledge_subjects_from ON knowledge_subjects(fromSymbolId);
```

The address is never erased. An orphaned subject keeps the address that stopped resolving, which
is the only key by which a refusal, a recall or the sweep's restore can find it again; `state`
alone says whether it resolves. `answers` and `gaps` are keyed by `(subjectId, question)` and
`answers.factId` is `UNIQUE`. Each row keeps `recordedAs`, the address at record time for an
answer and at first ask for a gap, never rewritten. `subjectId` is minted from the first address
and the clock through the protocol's `hashContent` and is opaque afterwards. `subjects.ts` owns
the table's DDL, the DDL of `answers` and `gaps`, and three views (`subjects_addressed`,
`answers_addressed`, `gaps_addressed`) that project a row onto its subject's current address; the
store embeds that DDL in its schema and reads through the views, so no module but the owner
names the table, which a residue in Verification holds.

**Answer identity carries the subject.** `answerFactId` digests the address, the question, the
prose and the citations today, and an address is reusable under this model: a subject rebinds
away and a later write at the vacated address mints a new subject, so two subjects could hold one
citable id and `factById` would resolve whichever row comes first. The two signatures become
`answerFactId(subjectId, recordedAs, question, prose, citations)` and
`doubtFactId(subjectId, recordedAs, question, reason, at)`: the module is taken from
`recordedAs`, as it is taken from the address today, and `subjectId` is digested as the first
part, never handed to `moduleOf`. Stored ids are never recomputed, so existing rows
keep the ids other answers cite; only new records carry the new digest. The `UNIQUE` on `factId`
is the loud guard underneath.

**Invariants, and who enforces each.** By the schema: one row per subject (`PRIMARY KEY`), one
subject per address (`UNIQUE`), a closed state and a closed evidence (`CHECK`), a date on every
orphan and none on a bound subject, so a restore that forgot to clear the clock fails to write, a
coverage only beside a digest, and a `subjectId` that never changes on any of the three tables,
held by a `BEFORE UPDATE OF subjectId` trigger that aborts the write. By the owner, backed by the
residue and by a test that refuses each illegal transition: no merge operation exists, and
identity changes only by rebinding `currentSymbolId`. The repository's own `migrateKnowledge` is the standing proof that a key an
application can rewrite will be rewritten, which is why it is retired rather than kept beside
this.

**Resolution.** Every knowledge operation keeps taking a symbol id on the wire and resolves it
through `subjects.forAddress(symbolId)`, which finds bound and orphaned subjects alike since the
address is kept. A read on an address with no subject reads nothing. A write claims through one
owner method: where the address resolves to a declaration it mints a subject, or restores the
orphan kept there, bound, evidence `sameLocator`; where it does not, an orphan is kept as it is,
and an address holding neither is refused by the catalog's diagnoses. One indexed read per call.

**Projection, stated once.** Every reader is address-shaped today: `answer`, `answersFor`,
`allAnswers`, `doubtedAnswers`, `gaps`, `askCount`, `factById`'s answer branch, and `rowToAnswer`,
which requires a `symbolId`. Under subjects each of them joins the row to its subject and returns
`currentSymbolId` as the address, which is the current address for a bound subject and the last
known one for an orphaned subject, and carries `recordedAs` beside it. `AnswerSchema` gains an
optional `recordedAs`. `recallAnswers`, the plural, which today maps `answersFor` with no
resolution, resolves once through `forAddress`, returns nothing for an address with no subject,
and carries Phase 1's `stranded` field on every row when the subject is orphaned, exactly as the
singular does.

**Transitions, and the evidence each records.** The closed set: `sameLocator`, `journalMove`,
`journalRename`, `batchExactMatch`, `ambiguous`, `none`.

| Transition | What happens |
|---|---|
| Edit in place | Same address, same subject. The declaration's facts re-mint, so citations go stale as they do today. Nothing else. |
| Move through `refactor_move` | The step's id map rebinds every affected subject to its new address, evidence `journalMove`. |
| Rename through `refactor_rename` | The same, evidence `journalRename`. |
| External move | The sweep rebinds only on `batchExactMatch`: exactly one declaration whose module was first indexed in the pass that lost the address and whose pattern digest equals `lastDigest`. |
| Delete, or vanish without evidence | The sweep sets `orphaned` with `orphanedAt` and the evidence it had, `ambiguous` with the candidates or `none`. The address and the rows stay. |
| Reappear | An orphaned subject whose kept address resolves again is bound, evidence `sameLocator`, date cleared. A write at that address finds the orphan through `UNIQUE` and restores it rather than minting a second subject. |
| Thirty days orphaned | The subject and its rows are deleted. |
| Duplicate | A new declaration with identical text is a new subject when knowledge is first recorded against it. |
| Converge | Two live subjects whose text becomes identical stay two subjects. |

A copy-then-delete inside one pass is indistinguishable from a move with the inputs the index
has, and rebinds; the evidence says `batchExactMatch`, so the window shows what was concluded and
from what. That residual is written here rather than hidden.

**The rebind is journaled, and the dispatch rituals go.** Today `dispatch.ts` builds the id map
(`rebaseIntoModule` for a move, `renameIdMap` for a rename) and calls
`service.migrateKnowledge(idMap)` in the `finish` callback it hands the step, which the step runs
only after `completeStep("reindexed")`, and `recover` never replays `finish`. So a crash between
the reindex and the finish leaves the files moved and the knowledge addressed to ids that no
longer exist, and the sweep would orphan them with `none` although a journaled move is exactly
the evidence that existed. The rebind therefore becomes part of the step record: `PlannedStep`
gains `rebind`, read after `begin` and journaled inside the step's plan record at `beginStep`, so
the entries exist before any file is touched. The executor applies them through the transaction
manager once the files are written and the reindex has been attempted, whatever it returned: the
journal is the evidence, and an address the index has not caught up with is unresolved with
evidence `journalMove` until it does, which the sweep can tell from a loss. The move and its
record are one transaction: the step record gains what actually moved, each subject with the
state it replaced, so a reversal restores exactly that, a journaled no-op reverses nothing, and a
subject two steps moved retraces both. `recover` undoes an unfinished step by restoring its
before-images, so it reverses what the step moved the same way, keeping a move whose modules both
conflicted; `undo` reverses the top step's and `revert` retraces every step's, newest first. A
replay finds nothing at the vacated address and does nothing. No new journal phase:
`StepPhase` is on the wire in `refactor_status`, and a new enum value would break an older client
where an optional field would not. `migrateKnowledge` is retired from the ledger, the service,
the store and dispatch, and its name is forbidden by the residue so a row move cannot come back.
The sweep remains a detector for an unjournaled loss, never the recovery path for a journaled one.

**The pattern digest, for `batchExactMatch` only.** At `indexFile`, where the text is held
transiently and `attachComments` already walks every declaration with it, core computes per
declaration a digest of kind, name and the declaration's range text with the reported comment
ranges removed and whitespace collapsed. No language is named: the provider reported the comment
ranges, or it reported none. A digest is computed only for a full-depth parse: a shallow parse
returns no comments even from a provider whose tier is on, so an outline row would carry the
comment bytes under a label that says they were stripped, and the same unchanged declaration
would digest differently at the two depths. An outline or surface row has no digest until it is
upgraded. `symbols` gains `patternDigest` and `patternCoverage`, both nullable, `commentsStripped`
when the provider's comments tier is on and `commentsKept` when it is off, so a digest says what
it covers. The values travel in one new `replaceFile` parameter,
`digests: Array<{ symbolId, patternDigest, patternCoverage }>`, computed in `indexFile` beside
the `attachComments` call. Existing rows fill on the next full scan. `replaceFile` also refreshes
`lastDigest` and `lastCoverage` on every bound subject whose address is in the module, one update
joined on `currentSymbolId`, so the digest survives the declaration it describes. Two digests
match only when their coverages match. A subject with no digest can never rebind by evidence,
and orphans honestly.

**Storage and upgrade.** The store opens through two gates today: a `user_version` that differs
from `SCHEMA_VERSION` rebuilds every table and carries knowledge across through
`salvageKnowledge` and `restoreKnowledge`, and after that the in-place additions run, each guarded
by `columnExists`. `SCHEMA_VERSION` does not change here, so a store at the current version never
reaches the rebuild, and the re-key needs its own trigger on the in-place path: the absence of
`answers.subjectId`, probed by `columnExists` like every other addition, is it. When absent, in one
transaction: create the subjects table and the new `answers` and `gaps`, copy every row minting
one subject per distinct old `symbolId`, bound if `symbols` holds the address and orphaned as of
the upgrade otherwise, drop the old tables and rename. The subjects table alone is
`CREATE TABLE IF NOT EXISTS`. On the rebuild path, `salvageKnowledge` and `restoreKnowledge` carry
subjects with the rows; a restored subject keeps its address, which the scan re-mints for
unchanged source, and one that does not come back is orphaned by the next sweep, so no post-index
pass exists beyond the sweep that already runs. Two pre-identity stores are the gate, because the
two paths are different code, and the test synthesizes both from the address-keyed DDL rather than
committing a binary: a store rewound at the same version, opened by the new code, proves the
in-place re-key on first open; one rewound at the previous version proves the rebuild path carries
subjects. Both end with every answer bound and recalled. A build older than this one cannot read
a re-keyed store, since its readers name `answers.symbolId`; a plugin ships as one checkout, and
`SCHEMA_VERSION` stays, so no store is rebuilt for this.

**Wire.** `AnswerSchema.symbolId` and every result keep carrying the current address. Recall gains
an optional `subject: { id, recordedAs, evidence, since }`, additive. No method is removed or
renamed. A minor.

**Tests, this phase:** a journaled step whose reindex succeeds rebinds and reports the count
through `finish`; one whose reindex fails is rebound all the same and says `ReindexFailed`. A step
planted as unfinished with its rebind applied: `recover` reverses the rebind with the files; when
both of an entry's files conflict, the rebind stays where the step put it, because nothing
restored them; when only the destination conflicts, it goes back with the source. A step that
never rebound leaves a subject already at the destination alone, and a journaled no-op after an
earlier move leaves that move alone on undo. `undo` and `revert` reverse a rebind with the files,
and `revert` retraces a subject two steps moved to the state it started in. A rebuild that cannot
place a row, its subject lost and its recorded address held, counts it for the daemon's log. A re-mint at a reused address in the same millisecond gets a distinct id.
A second subject's answer under an existing fact id is refused, not swapped in. A rebuild that
lost a subject row revives it at the recorded address. A comment straddling a declaration's edge
digests nothing outside it. A provider that reports comments without declaring the tier loses
them at the supervisor, so its digests say `commentsKept`. Twenty identical twins: twenty subjects, each recorded and recalled alone, and a rebind of
one moves one. Two subjects re-indexed onto one digest: both bound, both recalled. Orphan, then
write at the kept address: bound again, date cleared; delete: subject and rows gone. Move a
subject away, then record an answer with identical prose and citations at the vacated address:
two subjects, two distinct fact ids. A gap asked at an address nothing holds mints no subject. The
two pre-identity stores above. Digest one declaration at outline depth and at full depth: no
digest at outline, one at full. The residue: its patterns fire on the spellings they forbid, and
production names the table nowhere but the owner.

**Tests, in later laps:** record, then move the file through `refactor_move`: recalled at the new
address with evidence `journalMove`, the old address diagnosed as moved; rename through
`refactor_rename`: the same with `journalRename` (Phase 0, which supplies the diagnosis). Move the
file with the editor: the batch rebinds on `batchExactMatch` and `recordedAs` still names the old
address. Two identical twins, delete one: the survivor untouched, the other orphaned with `none`.
Delete for thirty injected days: subject and rows gone. A forgotten rebind, planted by bypassing
the step: orphaned with `none` on the next sweep (Phase 4, which is the sweep).

### Bug Classes

**Rebind reversal in the journal.** The class: a reversal inferred from the subject's current
state instead of from the step's own record. Round one reversed any subject found at the
destination; a twin that already lived there went back to a source it never came from. Round two
reversed only a subject whose `fromSymbolId` named the source; a journaled no-op then reversed an
earlier step's move, and a subject two steps moved stopped halfway on revert, because one mutable
field is not a history. Round three closed the class: `TransactionManager.rebind` writes what the
rebind moved, each subject with the state it replaced, in the same transaction as the move, and
every reversal restores exactly that.

## Phase 1 - Candidates, and an orphaned subject says it is orphaned

**The candidate predicate.** The id grammar gains one named predicate over parsed descriptors, in
`symbolId.ts`, so nothing outside the grammar decides what "the same name and kind" means:
`sameNameAndKind(a, b)`, same language, same kind, same last descriptor name, and for a member,
the same name on the container descriptor too, different module. It returns false for a local id,
whose parse carries an ordinal and no descriptors, matching `rebaseSymbolId`'s refusal to trace
one. The store's `declarationsNamed(name)`, already indexed by name, returns the shortlist
unchanged, and one helper in the knowledge layer, `candidatesFor(symbolId)`, applies the
predicate. Candidates are for a person to read; nothing is ever authorized by them. Authorization
is the identity phase's evidence.

**Subject state, readable by every refusal.** The identity owner exposes `stateOf(symbolId)`:
`{ subject: id | null, state: bound | orphaned | none, orphanedAt: number | null, evidence,
forwardedTo: symbolId | null, exempt: boolean, reason: string | null, answers: number,
gaps: number }`, where `exempt` is true when the address's module is in `parse_failures`,
`reason` is that failure's recorded reason, and `forwardedTo` is set when the address was rebound
away: an equality read on the `fromSymbolId` index, naming the subject that vacated it, or the
most recently bound one when more than one did. Only the last vacated address of a subject
forwards; an address two rebinds old has no row naming it and diagnoses as unminted, which is
stated here so nobody expects a chain. Exemption is a property of subjects: with no subject at the
address, `exempt` is reported but nothing is waiting, and the id falls through to the unminted
shortlist. `subjectRefused` reads the state before composing, so the wording agrees with whatever
the sweep last left the subject in:

- An address whose subject was rebound elsewhere: **moved**. The refusal names the new address
  and the evidence, and says the knowledge is recalled there.
- Orphaned subject, not exempt: **stranded**. The refusal says the knowledge recorded here
  belongs to a subject whose address no longer resolves, names `orphanedAt` and that deletion
  follows thirty days after, names the evidence if it was `ambiguous` with its candidates, and
  lists `candidatesFor` so the prose can be recorded again where a reader will find it.
- Bound subject whose address does not resolve and is exempt: **waiting on a parse failure**. The
  refusal says the module is present and not parsing, that nothing will be orphaned or deleted
  while that holds, and names the failure's reason.
- A subject with only demand and no answer: the same sentences with "the demand recorded against
  it" in place of "the answers".

**Recall carries it on the wire.** `RecalledAnswerSchema` gains an optional
`stranded: { since: number | null, exempt: boolean, evidence, candidates: string[] }`.
`recallAnswer` fills it when the subject is orphaned or its address does not resolve.
`renderKnowledge` renders the status line from it and replaces the reaffirm instruction, which
an orphaned subject cannot follow, with the re-record path and the candidates. Optional, a minor.

**Recall stops charging for it.** Today `recallAnswer` records demand on a miss only when the
subject has an indexed declaration, and on every unhealthy recall (stale, doubted, or inheriting
either) regardless of the subject. The miss path is already right. The unhealthy path is the one
that charges for an orphaned subject, since its answer exists and is permanently stale, so the
orphan check goes before `recordGap` there. An orphaned subject is also excluded from the stale
count in `knowledgeGaps`, or it would re-enter the queue this plan says it leaves.

**An orphaned answer stays doubtable.** `invalidateAnswer` refuses only an address with no
subject, by design: a doubt is prose about the answer, a rebind carries it, and a reader who found
the prose wrong is right to say so. What it must not do is mint demand: today the doubt path
records a gap unconditionally after `setDoubt`, where the unwritten-answer path already guards on
the subject being indexed. The doubt path takes the same guard, and the comment above it carries
this rule in place of the one it states now.

**Tests:** record, then delete the file: `recordAnswer`, `reaffirmAnswer` and `recallAnswer` on
the address each say stranded and name the candidates; `recallAnswer` carries the field and
records no gap on the unhealthy path; `invalidateAnswer` records the doubt and no gap. Rebind
through `refactor_move`, then ask the old address: moved, with the new address. Plant only a gap
at a dead address: the demand wording. Put the module into `parse_failures` with the file present:
the waiting wording with the failure's reason, nothing orphaned. Plant two same-named declarations
in other modules: both listed as candidates, neither bound to. Strand a local: no candidates, and
the refusal says why. Rebind twice: the middle address forwards, the first diagnoses as unminted.
Watch the old wording fail first.

## Phase 0 - One diagnosis for a bad subject id, reached from every tool

**What:** the subject diagnosis in `subjectRefused` becomes the one owner every tool reaches when
a symbol id names nothing. Five outcomes, closed: a fact id supplied as the subject, an unminted id
with the module's shortlist, a moved address with where it went, a stranded subject with its
candidates and state from Phase 1, or an unknown id. The line between the last and the second is
the one the code already draws: an id whose module field decodes to an indexed module is
unminted and gets the shortlist, whether or not the rest of it parses; one whose module is
unindexed or does not decode is unknown.

**The daemon method.** `diagnoseSubject`, request `{ symbolId: string }`, response
`{ kind: "factIdAsSubject" | "unminted" | "moved" | "stranded" | "unknown", reason: string,
candidates: string[], forwardedTo?: string }`, where `reason` is the sentence `record_answer`
already composes and `candidates` is the shortlist. Registered in the method table, dispatched in
`dispatch.ts` through the same `.parse(params` path as every other method, exposed on the client
session. A new method is a minor.

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

**Tests:** each of the five outcomes handed to `describe_symbol`, `symbol_facts`, `symbol_source`
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

## Phase 4 - Orphaned subjects: rebound, dated, or deleted by the store

Decided by the owner; see Questions 4 and 9. No agent is ever asked to clean up, and nothing here
is a chore a person performs. The sweep works on subjects, which are few (one per declaration with
knowledge), never on rows.

**Orphan:** a bound subject whose `currentSymbolId` resolves to no declaration.

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
  the reachable set it last pruned against, and the modules first indexed in its last pass,
  derived where the only place that knows is: `indexFile` reads `depthOf(module)` before its
  write, and a module with no depth before the write and a successful `replaceFile` after it is
  new to the pass, which covers roots and everything `followImports` reached alike; a parse
  failure writes no facts and is not new. A file that changed since is a watcher event, and that
  event's batch runs its own sweep. Both triggers share one cap and one cursor, so a capped sweep
  resumes within the hour.
- The **store**, through the identity owner, exposes `sweepSubjects(batch, pass, now)`: one
  bounded batch, one transaction. `pass` is what the indexer supplies: `presence(module)`, one
  closed value `presentParsing`, `presentFailing` or `absent`; `newModules`, the modules first
  indexed in the pass that just ran, empty for the timer. The store never touches the filesystem
  and never sees a hash of a file.

**Presence, decided by the indexer from the scan it just finished.** The sweep runs after prune,
and prune has just computed the reachable set and forgotten every module outside it, including
that module's `parse_failures` row. So a module is `absent` when it is outside the reachable set,
`presentFailing` when it is inside it and `parseFailureOf` holds a row, and `presentParsing`
otherwise. No source is read: a parse failure never writes `files.contentHash`, so a hash
comparison would call every file edited into a failure changed, which is the mid-refactor case
the owner exempted. A file deleted and recreated under the same path is `presentParsing` if it
parses, and its vanished symbol is a real orphan, or `presentFailing` if it does not, and is
exempt like any other failing file.

**Two passes.**

Pass B first, over bound subjects whose address resolves to no declaration, read by joining
`knowledge_subjects` to `symbols` on `currentSymbolId` and keeping the misses, in `subjectId`
order:

1. **Exempt** when `presence` of the address's module answers `presentFailing`. Nothing is
   written. What protects the ordinary mid-refactor file is upstream of this step: a parse
   failure writes no facts, since a provider throw and an error diagnostic return before
   `replaceFile`, and a fact set the store refuses is rejected by `replaceFile`'s admission guard
   before its transaction opens, so a failing module keeps the declarations of its last good
   parse, its subjects keep resolving, and pass B never selects them; retained declarations in a
   failing module cause neither orphaning nor aging. This step
   is reached only by the narrower sequence in which a clean reindex first dropped the
   declaration and a later edit broke the parse, and its test reaches it that way. A malformed
   address has no module through `moduleOf`, can never be exempt, and is orphaned on first sight.
2. **Rebind** on `batchExactMatch`: exactly one declaration among `newModules` whose
   `patternDigest` and `patternCoverage` equal the subject's `lastDigest` and `lastCoverage`, and
   whose kind and name match. The subject's address becomes that declaration, `fromSymbolId`
   remembers the old one, no date is set. A subject with no digest never matches. The timer pass
   has no `newModules`, so it never rebinds by evidence.
3. **Orphan** otherwise: `state = orphaned`, `orphanedAt = now`, evidence `ambiguous` with the
   `candidatesFor` list when more than one declaration matched by digest, `none` when none did.

Pass A, over orphaned subjects, read by the `orphanedAt` index in `(orphanedAt, subjectId)` order:

4. **Restore** a subject whose address resolves again: `bound`, evidence `sameLocator`, date
   cleared.
5. **Delete** a subject orphaned thirty or more days behind the clock, with its answers and its
   demand. A date ahead of the clock is treated as now, so a clock that went backwards cannot
   delete early.

**Budget and continuation.** The unit is subjects examined per sweep across both passes, capped by
`ORPHAN_SWEEP_CAP`, owned by the indexer beside the sweep call and passed into `sweepSubjects`;
`STALE_SCAN_CAP` is a file-local constant of the knowledge layer, which neither the indexer nor
the store imports, and stays where it is. A sweep that reaches the cap stops and persists a cursor
in store meta beside the scan summary, shaped by the pass it stopped in:
`{ epoch, pass: "B", after: subjectId | null }` or
`{ epoch, pass: "A", after: { orphanedAt, subjectId } | null }`, starting at pass B with no key,
crossing to pass A with no key when pass B ends, and resuming by a strict tuple comparison on the
pass's own order, so subjects that share an `orphanedAt` advance past the key rather than repeat
under it. The next sweep resumes from the cursor. A
sweep that reaches the end of pass A clears the key and advances the epoch, so the one after it
starts pass B from the beginning, and the epoch advances even when every sweep is capped, since
each capped sweep still moves the key forward. A subject written behind the key is therefore
examined within the following epoch, and one deleted behind it costs nothing. What a sweep did
is reported as an optional `knowledgeSweep` field on `ScanCountsSchema`, which `writeScanSummary`
persists and `readScanSummary` restores and `overview` already carries as `scan`: examined,
rebound, orphaned, restored, deleted, ambiguous, and whether it stopped early. Both the scan and
the watcher batch fold the result into the summary they already write. Optional fields are a
minor.

**Transactions.** `inTransaction` is a raw `BEGIN`/`COMMIT` and not re-entrant. Each batch of
the sweep is one transaction opened by the identity owner; the sweep as a whole is many, which is
what lets it stop and resume. Nothing inside a batch opens another.

**The clock.** `clock.ts` owns time for the routed modules and its `Clock` is injectable into the
service, but the service builds `WorkspaceIndexer` without one. The indexer gains a `Clock`
parameter, the service passes its own, and the clock residue's routed list grows by `indexer.ts`
and `subjects.ts`, so a `Date.now` in the sweep fails the build. The sweep passes `now` into
`sweepSubjects` as a value, so the store's four existing `Date.now` reads, all write timestamps,
stay unrouted and the aging test sets the clock rather than faking a date.

**What an orphaned subject stops costing, and where it is still seen.** It leaves the stale sweep
and the `STALE_SCAN_CAP` count at once, it never leads the demand queue, and `recallAnswer`
records no demand for it (Phase 1). The workspace demand sweep reads `gaps` and `allAnswers`
today, neither of which sees a subject's state, so the identity owner gains two reads for the
window: `orphanedSubjects(limit)`, oldest first with their rows, and `orphanedCount()`. The sweep
excludes orphaned subjects' rows from its recheck and missing groups, appends the orphaned rows
after them inside the page, each carrying `stranded: true`, `strandedAt` set to `orphanedAt` and
the evidence, and reports the count as an optional `stranded` number on the result; `total` keeps
counting actionable rows only. A page full of actionable rows shows no orphaned row and still
shows the count. The renderer groups the rows under a stranded heading with their dates and
evidence. A module scope or subtree walk never holds one, since an orphaned subject has no
declaration under any scope. That is a window, not a task.

**Storage.** The subjects table, its three indexes and the two digest columns on `symbols` come
from the identity phase; pass A reads by `orphanedAt`, the window by `state`, and the moved
diagnosis by `fromSymbolId`. No compatibility bump, no rebuild.

**Wire.** The gap row gains an optional `strandedAt`, an optional `stranded` flag and an optional
`evidence`, never a fourth `why` value, because clients ride forward and an older client would
fail to parse the newer row. `why` keeps its ordinary value on an orphaned row, `stale` for an
answer whose citations can never resolve again and `missing` for demand, so an older client reads
it as it always did, and the renderer checks `stranded` before `why` when choosing the heading
and the state word. With the result's `stranded` count, the `knowledgeSweep` report and Phase 1's
recall field, this phase is a minor.

**Tests:** record, then delete the file: orphaned on the next sweep with evidence `none`, absent
from the stale count, not at the head of the queue, no demand recorded on recall. Replace it with
a parse failure while the file is present: not orphaned. Delete the file and recreate it parsing
without the symbol: orphaned. Put the symbol back: pass A restores it. Move the file with the
editor: rebound on `batchExactMatch`, undated, recalled at the new address, the old address
diagnosed as moved. Move it and edit the body in the same save: orphaned with `none`, since the
digest changed. Two identical twins, delete one: the survivor untouched, the deleted one orphaned
with `none`. Two candidates by digest among new modules: orphaned with `ambiguous` and both named.
Advance the injected clock thirty days with no scan and no event: the timer's sweep deletes it,
so an idle workspace ages. Set the clock behind a date: not deleted. Force a compat rebuild: the
subject and its date survive. Plant more orphaned subjects than the cap: the sweep stops, reports
it, and the next scan finishes from the persisted key; insert a subject behind the key between
two capped sweeps and it is examined within one epoch. Reindex the symbol away cleanly, then
break the parse, then sweep: exempt, and the test names that as the only way to step 1. Move a
file whose destination is reached through an import rather than as a root: rebound. Plant a
malformed address and a local
address: both orphaned, neither rebound, neither exempt. An older client parses a row carrying
the new fields. Each case watches the old behaviour fail first.

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

**Release:** decided by the owner in Question 5, the full design. A minor, in the second release
line with Phase 4, after the replan point.

## Doctrine

Add to the rules that already cost something: **a refusal names what the author did and what to
do instead.** "Not in the index" was correct and cost a night: two agents concluded a queue was
exhausted, one re-derived ids by hand for a batch, and one mistake minted demand rows nobody could
answer. The test for a refusal is whether the author can act on it in one turn.

For a bad symbol id specifically, the rule has a shape: the refusal distinguishes an unknown
symbol id, a fact id supplied as the subject, a member id missing its terminator, an address whose
subject moved, and a stranded subject whose address is gone. A reviewer who hit the
undistinguished version could not tell which he had done, and that is the whole cost.

And one more, from Question 9: **knowledge is about a subject; a symbol id is its address.** Rows
never change key. Identity changes by rebinding an address through one owner, with closed-valued
evidence, and two subjects never merge. `docs/knowledge-layer.md` and `docs/architecture.md` say
so in the same words once the identity phase lands.

**Every refusal the knowledge layer produces, audited against the rule.** A rule with one named
exclusion and an unlisted remainder is a rule nobody can check. The disposition of each, across
all three shapes a refusal is returned in, `recorded: false`, `refused:` and the citation
checker's `ok: false`:

- Cites nothing: names the fix (cite the facts drawn from). Kept.
- A citation is not a fact id: names the fix (the whole line, never the digest). Kept; it is the
  shape the rest are raised to.
- A citation does not resolve: names both causes and the fix (re-fetch or refuse). Kept.
- Nothing cited about the subject: names the mistake (neighbours describe themselves). Kept.
- Fact id as subject, unminted id, moved address, unknown id, stranded subject: Phase 0 and
  Phase 1, one constructor each.
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
- A gate that can fail, for refusals. Every refusal is composed through one owner, the catalog
  phase's `refusals.ts`, and the refusals reach their three shapes, a `recorded: false`, a
  `refused:`, or the citation checker's `ok: false`, only through it; the fifteen inline literals
  that exist today are the catalog's migration and the gate's first catch. The residue is scoped,
  not workspace-wide: `refused:` has two dozen unrelated instances across core and `ok: false`
  three dozen, in dispatch, the refactor planner, transactions and argument parsing, none of them
  refusals of this layer, so a token sweep over those spellings would fail everywhere or be
  narrowed until it checked nothing. The sweep reads `knowledge.ts` and `answers.ts` only, and
  forbids a string literal composed directly after `reason:` or `refused:` anywhere in them,
  which is the narrowest token a refusal composed inline carries and a constructor call does not.
  The catalog module is exempt because it is the owner, and the citation checker's `ok: false` is
  a catalog member, not a violation. The sweep asserts it found the two files and found
  constructor calls, that every exported constructor is called and every call names an export,
  and that nothing in core but the owner, matched by exact path, mints the brand in any spelling
  of a cast.
  Each constructor is named by a test that asserts the returned reason AND the action taken,
  since a test that merely names a reason does not prove the branch ran; the four reworded
  sentences are pinned independently of their constructors. The density bar in the repository's
  rules stays. The gate is proven by planting one inline literal per shape in the scoped files
  and watching each fail.
- A gate that can fail, for identity. Scoped the way the index-writer residue already is,
  production source across the five packages with `__tests__`, `dist`, `fixtures` and the like
  excluded, so plan and doc prose is exempt by the same convention: the token
  `knowledge_subjects` is forbidden outside `subjects.ts`, and the
  token `migrateKnowledge` is forbidden once retired, so a row move cannot come back and no
  second writer of identity can appear. The two tests in `service.test.ts` that call
  `migrateKnowledge` today are rewritten against `rebind` as part of the identity phase, since the
  exclusion would not catch them. Both tokens planted and watched failing. The sweep asserts it
  found the owner.
- Drive the built server: hand each refusal the exact bad input from the overnight logs, a fact
  id as subject, a member id without its terminator, a stranded subject, a moved address, and read
  what comes back; drive `diagnoseSubject`, one `sweepSubjects` batch and one `refactor_move`
  rebind through the real daemon; open the 3.0.x fixture store through it.
- Release: **minor** after the catalog phase, the identity phase and Phases 1, 0, 2 and 3
  together. Phase 0 adds a daemon method, the identity phase, Phase 1 and Phase 3 add optional
  fields, and the protocol doc prices each as a minor; the catalog is internal. The identity
  phase's in-place table rebuild preserves the store, which is what a minor promises, and its
  fixture gate is what proves it. Phase 4 is a minor for its optional fields. Phase 5 is priced in
  its own section and is in no release line until decided. Nothing here needs a major: no
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
- Questions 6 to 8, and the frame they were asked in. Three questions in a row were about how to
  move knowledge rows: what wins on collision, what proves a move, whether a text pattern should
  be the key. A Sol second opinion, asked for by the owner, named the frame instead of answering
  inside it: all four options treated identity as something the rows carry. Six investigators had
  priced the pattern key and none had said that. The measurement the author took, a fourteen
  percent twin rate that is almost all one-line test setup, would have argued for the cheapest
  row-moving option and would still have left every identity change a row rewrite. Sol also
  caught a fact the author had stated to the owner and to six investigators from memory:
  `files.content` is the `code | data | document | text` classification, not source text. The
  lesson is the one the doctrine already carries about refusals, turned on design: name the
  class, not the instance.
- Identity rewrite, lap 1: nine auditors, fourteen findings, fourteen held. The two blockers
  were one paragraph contradicting itself: a schema comment erased the address on orphaning while
  every refusal, recall and restore was keyed by it, and the answer fact id digested an address
  the model had just made reusable. Both fixed by saying what the address is, kept and never
  identity, and putting the subject into the answer's id. The majors clustered where the last
  series' seams did: the sweep's inputs (`newModules` had no derivation, the cursor could skip a
  subject for as long as every sweep stayed capped, and the parse-failure exemption was credited
  with a protection that retained declarations already provide), the storage surface (a
  same-version store had no trigger for the re-key, and the fixture gate proved the other path),
  the rebind sitting outside the journal it should have been part of, and a coverage label a
  shallow parse would have worn falsely. "Invariants, enforced by the schema" had listed four and
  the schema held one; the repository's own `CHECK` pattern now holds three and the owner holds
  the rest, in writing.
- Identity rewrite, lap 2, narrow: four auditors, five findings, five held, two angles clean, all
  fourteen lap 1 fixes landed, three in part. The one that would have shipped wrong was lap 1's
  own fix: moving the rebind into `completeStep("reindexed")` moved it out from behind the
  `fullyReindexed` guard today's migration sits behind, so a step whose destination failed to
  reindex would have committed an address that resolves to nothing. The journal gains a `rebound`
  phase and pending entries instead. The rest were shapes left to prose: a scalar cursor key for
  a composite order, a one-directional `CHECK`, two fact id signatures, and one wrong reason for
  a right conclusion about parse failures. Two blocker claims were the auditors' misreadings and
  the plan's text settled both. Stopped here: the synthesis judged a third lap worth less than
  these five sentences, and the owner's implement-and-see order puts Phase 4, the phase with the
  most inferred mechanism, behind an amendment with real code in front of it.
- Building the catalog phase: the answers test file's `plant` helper is documented as giving "two
  facts to cite and one to leave out" and returns only the declaration's fact id, so the literal
  has to be fetched through `literalsContainedBy` by hand, which cost one wrong test. The file is
  past twelve hundred lines with one fixture set shared across nine describes, a split candidate
  for a later architecture pass. The coordinate residue caught a line count by `split` in the new
  residue test, which is the gate working, though its message names the owner file and not the
  method (`positionAt`) that should be called instead. The catalog itself went cleanly; the
  brand was the one design move the phase did not plan and should have.
