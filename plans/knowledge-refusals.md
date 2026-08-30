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
reported. It lands after the replan point, with Phase 4. The two do not share the seeding path:
they share `replaceFile`'s parameter list, the `knowledgeGaps` result shape, and the gate that
decides whether the seeded fallback runs at all. The cheaper form is not taken.

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

## Question 11 - What lands before Phase 4? (settled in chat)

Q: Five replan items came out of the identity build: one injected clock, a row-placement
primitive, typed rebind rows, a provider port with a move-capable fixture, and Refusal-typed slots
outside the knowledge layer. Is any of them something the sweep reads, or are all five follow-ups?
A: Phase 4 as written, all five after. Everything the sweep reads is shipped in the identity
owner; the thirty-day expiry reads `orphanedAt`, written only by the sweep from its own `now`;
the placement primitive targets the schema rebuild Phase 4 forbids itself; the fixture provider
gates the refactor end-to-end, not the editor move the sweep matches. Four advocates, a pick and
two adversaries; the adversaries landed four corrections to Phase 4's text, applied there: the
`restoreResolving` call inside `replaceFile` routed through the indexer's clock, pass A's restore
stated as reachable mostly at index time, an explicit collision rule for a held target address,
and the store's clock-read count corrected.

> "C it is."

## Question 12 - Cut a 3.1.0 before Phase 4? (settled in chat)

Q: Everything since `Build 3.0.3` (2ddb025) is unreleased: the catalog, the identity phase and
Phases 1, 0, 2 and 3. Cut a minor now, or hold for Phase 4, or for Phases 4 and 5?
A: Cut 3.1.0 now; Phase 4 becomes 3.2.0. Nothing since 3.0.3 is a major by the release contract
(no provider extraction change, no removed daemon method, `PROTOCOL_VERSION` unchanged);
`SCHEMA_VERSION` is unchanged, so a 3.0.3 store takes the in-place re-key in one transaction and
keeps every fact id; nothing in production orphans a subject yet, so the accumulation holding
was argued against does not exist; the live views already keep dead addresses out of the queue
and ship only with a release. Gated on driving the built daemon against a real 3.0.3 store,
the grade run, and one conformance pass since the id grammar was rewritten. A rolled-back
3.0.3 cannot read the re-keyed store, loudly; rows survive and roll forward. Release note:
`answerFactId` and `doubtFactId` changed arity in the public protocol package; upgrade-minted
orphan rows stay until Phase 4.

> "A it is."

## Question 13 - Where does Phase 5 sit? (settled in chat)

Q: Question 5 settled Phase 5's design and put it with Phase 4; only its place in the order and
its release line were open.
A: Directly after Phase 4, in the same release line, full design. The two phases do not share the
seeding path (the live views already keep dead addresses out of the queue); they share
`replaceFile`'s parameter list, the `knowledgeGaps` result shape, and the gate that decides
whether the seeded fallback runs, which is where one interaction waits for whichever phase lands
first: a workspace whose only knowledge is stranded. Two adversaries: one corrected Question 5's
reason, one argued Phase 5 first on a premise the plan contradicts.

> "A"

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
Phase 1. Phase 2 depends on the catalog only. After the replan (Questions 11 to 13): 3.1.0 carries
everything shipped so far; Phase 4 as amended and then Phase 5 land together as 3.2.0; the five
replan items on the board follow, the clock first.

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

✅ Shipped: the owner, the journaled rebind and its reversals, the digest, the upgrade and the
surface (2fc8701, after two alignment audits and two red teams); every daemon handler declaring
its effect, with recall demand counted as the daemon's own write (b64d7d5, the architecture
pass, red-teamed); the documentation, the walker's stat-time race and this record in the commit
that carries this line. No version bump. The end-to-end refactor tests wait for Phase 0, the
sweep tests for Phase 4, as the Tests paragraphs say.

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
| Reappear | An orphaned subject whose kept address resolves again is bound, evidence `sameLocator`, date cleared: the re-index that puts the declaration back restores it as it lands, and a write at that address finds the orphan through `UNIQUE` and restores it rather than minting a second subject. |
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

**Gating.** Every daemon handler declares its effect: `read` runs under the shared gate, `write`
alone under the exclusive one, `staged` takes the gate in parts through the one it is handed, and
only those three mint a handler, so a bare function cannot sit in the table and no method runs
without saying whether it writes. The three knowledge writes are `write`. A recall is a read;
the demand it found is `demandOf`, a value, and `recordDemand`, a write the daemon runs under
its gate after the read, so a count never rides inside a shared hold and a read-only face never
records one. The protocol's `mutates` flag answers a different question, whether a lost call may
be asked again, and stays separate. The planners' full-parse upgrade runs ungated, as the
background pass's own work does; only their answer takes the gate. `staged` is the one shape the
type cannot check, since a handler handed the gate may ignore it, so a residue pins the methods
that take the gate in parts by name and the mint calls to three: adding either is a reviewed edit.

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
them at the supervisor, so its digests say `commentsKept`. A recall on the service counts
nothing; through the daemon it counts, as the daemon's own write. The one cast to the handler
brand is counted by a residue. Twenty identical twins: twenty subjects, each recorded and recalled alone, and a rebind of
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

✅ Shipped: the predicate, the subject state, the candidates, the three diagnoses, the `stranded`
field and its rendering (b6f3503, after a hygiene audit, an alignment audit and a red team); the
store-owned live projection with the guarded gap write and the re-index restore (385d864, the
architecture pass, red-teamed); the documentation and this record in the commit that carries this
line. No version bump. The `refactor_move` sentence is driven through the owner until Phase 0's
move-capable fixture.

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

**Recall stops charging for it, and the store owns the rule.** Work exists only at an address the
index holds. The identity owner declares two views over the addressed ones, `answers_live` and
`gaps_live`, joined to `symbols`, and the store reads them through `liveAnswers`,
`liveDoubtedAnswers`, `liveGaps` and `liveAnswerCount`; every ranking reader in the ledger, the
demand rows and both recheck scans of `knowledgeGaps` and the overview's stale count, reads those
and cannot see a dead address, which a residue holds by forbidding the raw readers in the ledger.
The raw readers stay for recall, doubt and diagnosis, which must see stranded rows. `recordGap`
is guarded in its own statement, an insert selected only where `symbols` holds the address, so a
recall's demand for a stranded answer is decided at the write and writes nothing; `demandOf`
decides nothing about eligibility, and the `stranded` field on the wire is explanation only.

**An orphaned answer stays doubtable.** `invalidateAnswer` refuses only an address with no
subject, by design: a doubt is prose about the answer, a rebind carries it, and a reader who found
the prose wrong is right to say so. What it must not do is mint demand: today the doubt path
records a gap unconditionally after `setDoubt`, where the unwritten-answer path already guards on
the subject being indexed. The doubt path takes the same guard, and the comment above it carries
this rule in place of the one it states now.

**Tests:** record, then delete the file: `recordAnswer`, `reaffirmAnswer` and `recallAnswer` on
the address each say stranded and name the candidates; `recallAnswer` carries the field and
records no gap on the unhealthy path; `invalidateAnswer` records the doubt and no gap. Rebind
the subject away (through the owner until Phase 0's move-capable fixture lets `refactor_move`
itself be driven), then ask the old address: moved, with the new address. Plant only a gap
at a dead address: the demand wording. Put the module into `parse_failures` with the file present:
the waiting wording with the failure's reason, nothing orphaned. Plant two same-named declarations
in other modules: both listed as candidates, neither bound to. Strand a local: no candidates, and
the refusal says why. Rebind twice: the middle address forwards, the first diagnoses as unminted.
Demand recorded before the address vanished leaves the queue with the stale rows, and the
overview's stale count skips a stranded answer. An orphan under a module that later fails to
parse reads as stranded, since only a bound subject waits. Watch the old wording fail first.

### Bug Classes

**Work at a dead address.** The class: every reader that ranks or counts knowledge work has to
remember that an address the index no longer holds is not work. Round one added the check to the
two recheck loops in `knowledgeGaps`; round two added it to the demand rows there and to
`staleAnswerCount`, beside the one `recordGap` already carries. Four sites remembered one rule.
Closed by the architecture pass: the store's live projection is the one owner, the four checks
are gone, the write is guarded in its own statement, and a residue forbids the raw readers in the
ledger's ranking paths.

## Phase 0 - One diagnosis for a bad subject id, reached from every tool

✅ Shipped: the one value, its daemon method, the chokepoint, the five routed core sites and the
residue (ac125eb, after a hygiene audit, an alignment audit and a red team); the documentation
and this record in the commit that carries this line. The built server was driven by hand:
`describe_symbol`, `symbol_source` and `record_answer` answer a ghost id with one sentence and the
module's shortlist, where 3.0.3 gave three. No version bump.

**What:** the subject diagnosis becomes one value, `diagnoseSubject` in the refusals module, that
every tool reaches when a symbol id names nothing, and `subjectRefused` is its sentence. Six
outcomes, closed: a fact id supplied as the subject, an unminted id with the module's shortlist, a
moved address with where it went, a stranded subject with its candidates and state from Phase 1,
a bound subject waiting on a parse failure (Phase 1's fourth wording, which the first draft of
this list omitted), or an unknown id. The line between the last and the second is the one the
code already draws: an id whose module field decodes to an indexed module is unminted and gets the
shortlist, whether or not the rest of it parses; one whose module is unindexed or does not decode
is unknown.

**The daemon method.** `diagnoseSubject`, request `{ symbolId: string }`, response
`{ kind: "factIdAsSubject" | "unminted" | "stranded" | "waiting" | "unknown", reason: string,
candidates: string[] }` or `{ kind: "moved", reason, candidates, forwardedTo: string }`, a
discriminated union so the wire refuses `forwardedTo` on any kind but the one that vacated an
address; `reason` is the sentence `record_answer` already composes and `candidates` is the
shortlist for an unminted id and the same-name-and-kind declarations for a stranded one.
Registered in the method table, dispatched as a `read` through the same `.parse(params` path as
every other method, exposed on the client session, which derives its calls from the table. A new
method is a minor.

**The chokepoint.** `resolveOne` in the MCP adapter is where a supplied `symbolId` was returned
unvalidated to eleven handlers. It now asks `declarationOf`, one indexed read, and when the id
names no declaration returns the diagnosis's reason as the problem, so every handler that funnels
through it says the same thing without knowing it. `symbol_source` takes a symbol id without
`resolveOne`; its refusal is composed in core, where `SourceWorkspace` holds the store and calls
`subjectRefused`, so the adapter renders what core said; its `factId` argument is a separate
parameter, so a fact id in the `symbolId` slot is the fact-id-as-subject case and nothing has to
guess. The knowledge writers already diagnose in core and are unchanged. The two sites that
answered `No symbol with ID ... is indexed` after a `null` from core, in `describe_symbol` and
`symbol_facts`, remain as guards against a file replaced between resolution and the read, and
answer through the diagnosis too.

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

**Tests:** through the fake backend, every handler behind the resolver (`describe_symbol`,
`find_references`, `type_of`, `symbol_facts`, `refactor_preview`) renders the diagnosis it is
handed, and the guard in `describe_symbol` is proven to fire after the resolver passed. Through a
real daemon over its socket with a real provider process, the four outcomes that harness can
reach (`factIdAsSubject`, `unminted`, `unknown`, and `stranded` after the file vanishes) produce,
from `describe_symbol`, `symbol_facts`, `find_references`, `symbol_source`, `type_of` and
`refactor_preview`, the sentence `record_answer` refuses with; `moved` and `waiting` are proven at
the writer by the identity and Phase 1 tests, and the chokepoint never reads the kind. The daemon
sample asks `diagnoseSubject` and compares its reason with the writer's. An indexed module holding
no declarations is unminted, not unknown. The residue was planted at a seventh and an eighth site,
`service` and the adapter's tools module, and named both. No test launches the built bundle; the
built server is driven by hand before the commit.

## Phase 2 - The shortlist matches names the grammar recognises

✅ Shipped: the prefix parse, the matcher and the ranking (3a74cd5, after a hygiene audit, an
alignment audit and a red team); the documentation and this record in the commit that carries
this line. No version bump.

**What:** the shortlist promoted declarations whose name appeared in the bad id by substring, so a
name like `at` or `to` was promoted by any id containing those letters, and a name like `ref` by
every id whose language or module field held it. The grammar owns the spelling, so the ranking
now borrows the grammar's own parse.

**The partial parse.** `parseDescriptors` kept its results in a local and every failure path
discarded them, so a malformed id yielded nothing. It now fills a caller's array and, on a failure,
rewinds to the mark it set at the failing descriptor and reads the rest through the cursor, per
the parsing law; `readOccurrence` no longer re-marks at its bracket, so a failure there brackets
the whole descriptor. `parseSymbolIdResult` is unchanged in what it answers. The grammar gains `parseSymbolIdPrefix`, returning `{ descriptors, failure,
rest }`: the descriptors parsed before the failure, the failure itself, and the descriptor text
from the failing descriptor on, empty when everything parsed or the head failed. It is exported
from the protocol barrel like its neighbours, or core cannot reach it.

**The matcher.** `spellsName(symbolId)` in the grammar returns a predicate over declaration
names: a name is spelled when a parsed descriptor carries it or the unparsed rest holds it as a
whole token. The rest is read through the cursor, per the parsing law, and two span kinds are one
unit each: a `(...)` span, whether a disambiguator or a parameter, since nothing parsed can tell
them apart, and a backtick-quoted name, whose interior can hold a bare declaration name such as
`to`; structural characters bound every other token. Names compare NFC-normalized, as the composer
writes them. The ranking in `diagnoseSubject` sorts the declarations the id spells first and keeps
store order among the rest. A descriptor that parsed and text that did not are matched together
rather than the latter only when nothing parsed, so `Cart#Total` promotes both.

**Tests:** at the grammar, a prefix keeps what parsed and the text from the failing descriptor on;
a whole id and a local leave nothing over; a failing head parses nothing. `Total` spells `Total`
and not `at`, and `at` still spells `at`; `Cart(to)#x` spells `Cart` and `x` and not `to`, and
`#(to)` spells nothing; a quoted `a.b` is found and a quoted `a.to` does not spell `to`;
`Cart#Total` spells both. At the service, `at`, `Cart` and `Total` planted in that order: a bad id
naming `Total` lists `Total` first and leaves `at` in store order, one naming `at` leads with it,
and `Cart#Total` leads with `Cart` then `Total`.

## Phase 3 - The gap header is told whether it filtered

✅ Shipped: the field, the four core returns and the renderer (6cd53fe, after a hygiene audit, an
alignment audit and a red team); the documentation and this record in the commit that carries
this line. No version bump. The run stops here for the replan before Phase 4.

**What:** `renderKnowledgeGaps` decides whether to name the asked question by inferring which core
branch produced the rows, which mirrors the core's structure into the renderer. The core says so
instead. `KnowledgeGapsSchema` gains an optional `filtered: boolean`. Every return sets it
explicitly: `true` from the seeded fallback, the module scope and the subtree walk, whose rows all
honour the asked question; `false` from the workspace demand sweep, which deliberately carries
every question with rechecks first. The renderer names the question only on `true`, in the
zero-row branch, the listed one and the seeded sentence, since before this the zero-row branch
and the seeded sentence named it unconditionally. An omitted field is a legacy or synthetic
result and reads as unfiltered, which is the safe direction: a legacy module-scoped result loses
its question label rather than a legacy workspace sweep gaining a false one. The zero-row branch
also carries the skipped-staleness-scan note the listed branch already had, since "no gaps" over a
scan that did not run was the same lie by omission.

**Wire:** an optional field on a result shape is additive, and a minor.

**Tests, at the core layer, each named by the request that reaches its branch:** `{}` reaches the
workspace sweep, `filtered: false`; `{ module }` reaches the module scope, `true`; `{ root }`
reaches the subtree walk, `true`; `{}` with no outstanding gap or recheck rows reaches the seeded
fallback, `true`, and that trigger is reached by a workspace whose every gap has been answered,
not only by one never asked, since `saveAnswer` clears the gap it answers. At the adapter,
`resolveOne` turns `name` or `symbolId` into `root`, one test. Renderer: `true` names the
question, `false` does not, omitted does not, in both branches and the seeded sentence, with the
lying case planted, a page of matching rows on a mixed total; the zero-row branch shows the
skipped-scan note. The daemon sample proves the flag survives the wire on both the workspace and
the module call.

## Phase 4 - Orphaned subjects: rebound, dated, or deleted by the store

✅ Shipped: the sweep, the cursor, the clock at open, the window and the wire (8847dc9, after a
hygiene and alignment audit and two red team rounds); the documentation and this record in the
commit that carries this line. No version bump; 3.2.0 waits for Phase 5. Not written: the
import-reached move test, which waits for a harness where a file is not a root.

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
  `gate.exclusive(() => service.sweepKnowledge())` the same way and queued on the batch tail behind
  any batch in flight, so it never overlaps a batch, gate or not, and it stops when the live index
  stops: a sweep queued behind a batch when the stop lands never starts, and the batch still
  applies. Its clock is a change, not a given: `startLiveIndex` accepts
  a `clock` today and forwards it only to the watcher's debounce, and the daemon passes none,
  while it builds the service on the default `systemClock`. The daemon holds one `Clock` and
  hands the same instance to the store at open, the service and `startLiveIndex`, so the store's
  stamps, the service, the indexer it builds, the watcher debounce and the sweep timer read one
  time source, and a test that supplies a fake through those three options controls all of them;
  `clock` stops being optional on `startLiveIndex`. The indexer keeps
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
   failing module cause neither orphaning nor aging. Every pass sweeps after its prune, so a
   declaration dropped cleanly is orphaned by that pass's sweep, and this step is reached only
   when a capped sweep left the subject unexamined and a later edit broke the parse before the
   next one; its test hands the sweep that presence directly. A malformed address has no module
   through `moduleOf`, can never be exempt, and is orphaned on first sight; a local address has
   one, and is exempt or orphaned like any other.
2. **Rebind** on `batchExactMatch`: exactly one declaration among `newModules` whose
   `patternDigest` and `patternCoverage` equal the subject's `lastDigest` and `lastCoverage`, and
   whose kind and name match. The subject's address becomes that declaration, `fromSymbolId`
   remembers the old one, no date is set. A subject with no digest never matches: every write of a
   module sets its bound subjects' digests to exactly what the index holds, null after an outline
   or surface parse, so a body the index does not know never matches by the body it had before. So a subject
   minted between scans takes the digest the index holds at its address when it is minted, and
   the re-key does the same for a bound address; only a subject whose module was never fully
   parsed has none. The timer pass has no `newModules`, so it never rebinds by evidence. A match whose target address another
   subject already holds is not a rebind: `KnowledgeSubjects.rebind` skips it and names in
   `applied` only what moved, so an entry the sweep submitted and `applied` does not name was
   refused for a held target, since the sweep read the subject it submitted. It takes step 3 with
   evidence `ambiguous`, never `none`; the diagnosis names the holder when `candidatesFor`
   includes it, which is a holder in another module with the same name and kind, and a holder in
   the same module is the same-name twin case and reads `ambiguous` without a name.
3. **Orphan** otherwise: `state = orphaned`, `orphanedAt = now`, evidence `ambiguous` with the
   `candidatesFor` list when more than one declaration matched by digest, `none` when none did.

Pass A, over orphaned subjects, read by the `orphanedAt` index in `(orphanedAt, subjectId)` order:

4. **Delete** a subject orphaned thirty or more days behind the clock, with its answers and its
   demand. A date ahead of the clock is treated as now, so a clock that went backwards cannot
   delete early.

Restore is not a sweep step. An address resolves again only when its module is written, and
`replaceFile` restores every orphan its module holds again through `restoreResolving` as it
writes; a write at an orphaned address restores it through `claim`; and the compat rebuild keeps
an orphan orphaned with its date through `restoreSubjects`. A third owner of the transition would
be reached by nothing.

**Budget and continuation.** The unit is subjects examined per sweep across both passes, capped by
`ORPHAN_SWEEP_CAP`, owned by the indexer beside the sweep call and passed into `sweepSubjects`,
which floors it at one, since a budget of nothing would persist the same cursor forever;
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
rebound, orphaned, deleted, ambiguous, and whether it stopped early. Both the scan and
the watcher batch fold the result into the summary they already write. Optional fields are a
minor.

**Transactions.** `inTransaction` is a raw `BEGIN`/`COMMIT` and not re-entrant. Each batch of
the sweep is one transaction opened by the identity owner; the sweep as a whole is many, which is
what lets it stop and resume. Nothing inside a batch opens another.

**The clock.** `clock.ts` owns time for the routed modules and its `Clock` is injectable into the
service, but the service builds `WorkspaceIndexer` without one. The indexer gains a `Clock`
parameter and the service passes its own, so the sweep passes `now` into `sweepSubjects` as a
value. The store holds seven `Date.now` reads: four write timestamps (`files.indexedAt`, the
parse failure's `failedAt`, the scan summary's `at`, the notes marker) and three identity stamps,
`restoreKnowledge` and `rekeyKnowledge` at open and `restoreResolving` inside `replaceFile`, which
writes `boundAt`, the column `forwardedFrom` orders by. `replaceFile` keeps its signature, since a
dozen tests call it directly: `IndexStore.open` takes a `Clock`, default `systemClock`, every
`Date.now` in `store.ts` becomes the store's clock, and the daemon hands one `Clock` instance to
the store at open, the service and `startLiveIndex`. The residue's routed list, which already
holds `subjects.ts`, grows by `indexer.ts` and `store.ts`, so a raw time read in either fails the
build, and the aging test opens the store and the service on one fake clock rather than faking a
date.

**What an orphaned subject stops costing, and where it is still seen.** It leaves the stale sweep
and the `STALE_SCAN_CAP` count at once, it never leads the demand queue, and `recallAnswer`
records no demand for it (Phase 1). The workspace demand sweep reads the live views, which
already keep a dead address out of its recheck and missing groups (Phase 1), and the identity
owner already answers `orphaned(limit)`, oldest first, and `orphanedCount()`. What the window
still needs is the orphaned subjects' rows, and the ledger may not fetch them through the raw
readers, which its residue forbids, so the owner gains `strandedRows(limit)`, one reader over
`answers_addressed` and `gaps_addressed` returning, per row, the address, the question, whether it
is an answer or a demand, whether an answer is under a doubt, `recordedAs`, `orphanedAt` and the
evidence, in pass A's order. The
gate that decides whether the seeded fallback runs reads actionable rows only, so a workspace
whose only knowledge is stranded still seeds its hubs. The sweep appends the stranded rows after
the actionable ones inside the page, seeded or not, each carrying `stranded: true`, `strandedAt`
set to `orphanedAt` and the evidence, and reports the count as an optional `stranded` number on
the result; `total` keeps counting actionable rows only. A page full of actionable rows shows no
stranded row and still shows the count. The renderer renders the stranded section, with dates and
evidence, whenever the result carries stranded rows or a stranded count, before the no-gaps
return that a zero `total` takes today. A module scope or subtree walk never holds one, since an
orphaned subject has no declaration under any scope. That is a window, not a task.

**Storage.** The subjects table, its three indexes and the two digest columns on `symbols` come
from the identity phase; pass A reads by `orphanedAt`, the window by `state`, and the moved
diagnosis by `fromSymbolId`. No compatibility bump, no rebuild.

**Wire.** The gap row gains an optional `strandedAt`, an optional `stranded` flag and an optional
`evidence`, never a fourth `why` value: an older client validates the row with its own schema,
which strips the optional fields it does not know and reads on, and refuses a `why` value it does
not know. `why` keeps its ordinary value on an orphaned row, `doubted` for an answer under a
standing doubt, `stale` for any other answer, whose citations can never resolve again, and
`missing` for demand, so an older client reads
it as it always did, and the renderer checks `stranded` before `why` when choosing the heading
and the state word. With the result's `stranded` count, the `knowledgeSweep` report and Phase 1's
recall field, this phase is a minor.

**Tests:** record, then delete the file: orphaned on the next sweep with evidence `none`, absent
from the stale count, not at the head of the queue, no demand recorded on recall. Replace it with
a parse failure while the file is present: not orphaned. Delete the file and recreate it parsing
without the symbol: orphaned. Put the symbol back: bound again with no date, asserted on the
subject's end state, since the module write restores it and the sweep never does. Move the file
with the
editor: rebound on `batchExactMatch`, undated, recalled at the new address, the old address
diagnosed as moved. Move it and edit the body in the same save: orphaned with `none`, since the
digest changed. Two identical twins, delete one: the survivor untouched, since its module is not
new to the pass and so is no match, and the deleted one orphaned with `none`. Two candidates by
digest among new modules: orphaned with `ambiguous` and both named. A digest match whose target
address another subject holds, planted in another module with the same name and kind: not
rebound, orphaned with `ambiguous` naming the holder. A workspace whose only knowledge is
stranded: the fallback still seeds its hubs and the stranded rows follow the candidates, with the
count, and the renderer shows the stranded section when the actionable total is zero.
Advance the injected clock thirty days with no scan and no event: the timer's sweep deletes it,
so an idle workspace ages. Set the clock behind a date: not deleted. Force a compat rebuild: the
subject and its date survive. Plant more orphaned subjects than the cap: the sweep stops, reports
it, and the next scan finishes from the persisted key; insert a subject behind the key between
two capped sweeps and it is examined within one epoch. Reindex the symbol away cleanly, then
break the parse, then sweep: exempt, handed that presence directly, since a sweep runs after every
prune. Move a file whose destination is reached through an import rather than as a root: rebound,
which the same `indexFile` path marks new; not written, since the fake harness roots every owned
file, and it waits for the fixture provider. Plant a malformed address and a local address under
an absent module: both orphaned, neither rebound. An older client parses a row carrying the new
fields. Recreate a deleted body under another name in a new module: orphaned with `none`, never
rebound. Write a module as an outline after recording: the subject's digest is forgotten, and the
same body elsewhere no longer matches. Stop the live index: no timer stands and an hour later
nothing sweeps; stop it with a sweep queued behind a batch: the batch applies and the sweep never
starts. Call the timer's sweep before any prune: nothing examined. Doubt a stranded
answer: its row reads `doubted`. Each case is written before its mechanism and watched failing
first; where a
behaviour exists today, the case pins it before exercising the changed path.

## Phase 5 - Fan-in seeding per language [after Phase 4, same release line]

✅ Shipped: the verdict on every file, the eligibility reader, the reserved hubs and the
per-language interleave, the wire field and the renderer line (52baa65, after a hygiene, test and
alignment audit and two red team rounds); the documentation and this record in the commit that
carries this line. No version bump; Phase 4 and this phase are 3.2.0 when the owner cuts it.

**The defect:** the cold-start fallback ranks the whole workspace by fan-in. Cross-language calls
do not bind, so any language that is called through a wire rather than an import is under-counted
and ranks last. Kotlin here; a Python extractor beside a TypeScript core elsewhere. The reviewer
who worked the two-language repository confirmed that a raw interleave would put `Protocol.kt`'s
generated containers in front of the console's real doctrine, because they have the highest Kotlin
fan-in and say nothing.

**Recommended design, priced against what the store holds.**

- **Eligible:** not `exported: false`, not generated, and carrying at least one comment anchored
  to the declaration, prose anchored to it (a document heading's section), a reference from
  outside itself, or, in a code file only, a literal inside it. A data field's value literal is
  the field, not evidence of doctrine: driven against the two-language checkout, the first page
  gave JSON, YAML, XML and HTML fields and a frontmatter key their turns on their own values. The
  counts are answered from indexes that exist: `comments_anchor`, `docs_anchor`, `refs_target`,
  `literals_container`, and the file's content class on `files`. `exported` is optional on the declaration and stored as null when a
  language cannot answer, so requiring `true` would exclude such a language whole; an unknown is
  eligible and counted in the same report as unknown generated status.
- **Generated, as a three-valued fact, with a path to the row.** The scan learns it from
  `git check-attr`; the reader it replaces returned one set of paths, collapsing "not generated"
  and "could not tell", which its one caller used only to compute reachability and dropped. It is
  `generatedVerdicts`, a per-module verdict map, `yes`, `no`, or `unknown` with a reason from a closed enum,
  `noGit` or `gitFailed`, threaded from the scan through `indexFile` into a new `replaceFile`
  parameter and persisted on `files` in two columns added in place; a rebuild rescans every file
  through the same admission, so nothing salvages it. A watcher batch recomputes its roots through
  the same admission that runs the git call, so it persists a verdict exactly as a full scan does
  and no third reason is needed. A module reached past admission, an import into ignored
  territory, is asked of git in one call per round of the import closure and the answer is kept
  for the pass. Every pass then writes its verdicts onto the `files` rows it holds one for, before
  it prunes, so a file the pass left unread, an unchanged root, an import-reached module, a file
  whose provider was down, takes the verdict of the attributes as they stand; a stored verdict is
  as of the last admission, and the background upgrade writes that one. Git's
  `linguist-generated=false` reads as `no`, as linguist reads it. A
  writer that never asked git, a direct `replaceFile`, records no verdict: a null, read as unknown
  and counted, kept apart from git asked and unable to tell. Unknown files are eligible, and the
  seeded result reports how many rows on the page were unknown through an optional
  `seededUnknown: { generated, exported }` on `KnowledgeGapsSchema`, filled by the fallback and
  rendered as one line under the header, so the bias is visible rather than silent.
- **Order within a language:** language-local fan-in, ties by symbol id.
- **Language order:** the store persists no language and every symbol id carries one, so the order
  is derived, not stored: languages sorted by their declaration count descending, ties by name,
  the language read through the grammar's `languageOf` from one id per module, since a module has
  one provider. It is stable under rescans and drifts only when the workspace's proportions do.
- **Reserved hubs:** the top five eligible hubs by global fan-in stay at the head, ties by symbol
  id, then the interleave takes one candidate per language in turn. Five is `RESERVED_HUBS`,
  written down so it can be argued with. The eligibility predicate is the store's
  `seedCandidates`, one reader the fallback alone uses; `mostReferenced` keeps its meaning for
  the `hubs` tool, which asks a different question, and gains only the tie-break it lacked.

**The cheaper form, with its loss stated:** interleave only among comment-bearing declarations,
skip generated status and the reference and literal counts. It costs no column and drops every
eligible declaration that carries substantive facts but no comment, which is a documented loss to
be accepted or not, not an accident.

**Tests, so the phase is done when decided:** a two-language store where one language's top
symbol is a generated container: the container is not seeded, the language's best comment-bearing
declaration is. A `noGit` workspace: candidates seed as unknown and the report says so. A language
that reports no `exported`: its declarations are eligible and counted as unknown. Seeding on a
workspace whose every gap has been answered, not only on one never asked. Equal fan-in ties: the
same order on two runs. The cheaper form was not taken (Question 5), so its test is the inverse: a
comment-less declaration carrying references or a literal is seeded, and one carrying nothing is
not. A generated file reached only through an import from ignored territory: its verdict is
persisted `yes` on the scan and again on a watcher batch, its importer's `no`; an attributes edit
delivered as a batch changes the stored verdict of two files the batch never re-reads. A no-git
workspace whose provider discovers the file still indexes it, unknown `noGit`. A store whose
migration stopped between the two column adds finishes it on the next open. A declaration whose
only reference is its own is not seeded. A stored `yes` beside a stray reason reads as no
verdict. The renderer's line appears only under a seeded header with a count above zero. A data
file's field holding only its value is not seeded; a document heading with prose under it is. A
row written without a verdict reads as unknown and is counted. An older client parses the result
without the field. Driven through the built server against the two-language checkout: five
TypeScript hubs, then TypeScript, Kotlin and the rest in turn, the unknown line counting the
providers that report no export verdict.

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

## Replan 1 - One clock through the composition root

The first of the five replan items (Question 11), scheduled after Phase 5. Phase 4 landed most of
it: the daemon hands one `Clock` to the store at open, the service, the indexer it builds and the
live index, and `store.ts`, `indexer.ts` and `subjects.ts` sit on the clock residue's routed
list. What is left is every raw time read in `core/` production outside `clock.ts`, so that one
fake clock controls a whole daemon and no operation mixes two clocks.

**What remains, by site.**

- The ledger. `KnowledgeLedger` stamps four moments itself: an answer's `createdAt`, a doubt's
  `doubtAt` in `invalidateAnswer`, the `now` the re-affirm path passes down, and the gap's ask in
  `recordDemand`. The ledger gains a `Clock` in its constructor, handed by the service, which
  already holds one, and every stamp reads it. Nothing on the wire changes: the stamps were
  milliseconds and stay milliseconds.
- The transaction manager. It accepts an injected `now()` but the daemon builds it with the store
  and the root only, so it runs on its default `Date.now`; the daemon hands it the same clock's
  `now`, so a step's `startedAt` and a rebind's `boundAt` agree with the store's.
- The daemon's own moments, all raw `Date.now` today: the startup allowance and the `retryInMs`
  it computes in `daemon.ts` and `daemonCli.ts`, the warm timings in the log, the drift ask
  interval. `startDaemon` takes the clock the daemon built, both files read it, and the routed
  list grows by both, so a test can drive the startup allowance and the drift cadence on a fake.
- `indexCli.ts` reports an elapsed time to a person and calls `Date.now` directly today; it is
  the one entry point that builds no daemon, so it reads `systemClock` by name at its top, which
  the residue permits for that file and no other.

**The residue.** The routed list becomes the whole of `core/src` production: every module but
`clock.ts` is swept, the sweep asserts it found the files, and a raw `Date.now`, `new Date()`
without an argument, `setTimeout` or `setInterval` in any of them fails the build. `client/` and
`protocol/` keep their own measurements: they are importable from a consumer's node process with
no core clock, and what they time is a transport's patience, not a stored fact.

**Tests:** open a store and a service on one fake clock, record an answer, doubt it, re-affirm it
and ask for it through the daemon's own write: `createdAt`, `doubtAt`, the gap's ask and the
subject's `boundAt` all read the fake. Advance the fake past the startup allowance and read the
daemon's refusal-in-progress `retryInMs` on the fake. The residue planted with a `Date.now` in
the ledger and watched failing.

**Release:** a patch. No wire change, no store change.

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
  rebind through the real daemon; open the 3.0.x fixture store through it. Done for 3.1.0 with a
  store seeded under the shipped 3.0.3 bundle and opened twice through the 3.1.0 daemon: the
  answer and its doubt kept their fact ids, the deleted file's subject read as stranded and
  refused a write with the same sentence, the gap header carried the flag, and an unminted id got
  the shortlist. Done after Phase 4 and 5 through the built server on a scratch git workspace of
  markdown files: a deleted file's subject was orphaned by the watcher batch's sweep, dated, and
  its recall and describe refused with the stranded sentence naming the date and the thirty days;
  a moved file's subject was rebound by `batchExactMatch` and recalled at the new address as
  REBOUND and STALE, the old address diagnosed as moved; the gap list showed the stranded window
  and `overview` the sweep's report. The seeded page against the two-language checkout: five
  TypeScript hubs, then TypeScript, Kotlin, a `CLAUDE.md` section and the other languages one
  turn each, with the unknown line counting the providers that report no export verdict. The
  `refactor_move` rebind still waits for the fixture provider; a fact id as subject, a member id without its terminator and a moved address were
  driven at the writer by the tests and by hand only for the moved address.
- Release: **minor** after the catalog phase, the identity phase and Phases 1, 0, 2 and 3
  together; cut as 3.1.0 (58a7bb0) by Question 12, after the migration probe above, the grade
  run and a conformance pass whose one failure predates it. Phase 0 adds a daemon method, the identity phase, Phase 1 and Phase 3 add optional
  fields, and the protocol doc prices each as a minor; the catalog is internal. The identity
  phase's in-place table rebuild preserves the store, which is what a minor promises, and its
  fixture gate is what proves it. Phase 4 is a minor for its optional fields. Phase 5 is in the
  second release line with Phase 4, by Question 5. Nothing here needs a major: no
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
  phase and pending entries instead. (Built without that phase: the executor applies the rebind
  once the files are written, and the step journals what moved; see the phase's Bug Classes.) The rest were shapes left to prose: a scalar cursor key for
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
- Building the identity phase: the Write tool put a raw NUL where an escaped separator was meant,
  in `mintSubjectId` and the digest, and the first scan called the files clean because grep goes
  silent on a file it thinks binary; an auditor was right and was dismissed for a round. The
  rebind reversal was patched three times before `TransactionManager.rebind` journaled what
  moved (the phase's Bug Classes entry). Six test files hand-roll a `ProviderSupervisor` fake, so
  the indexer's first call to `declares` broke comment indexing at runtime and not at the type
  level; the boundary then moved into the supervisor, which is where it belonged. The step plan is
  a JSON blob in `refactor_steps.plan` that `appliedOf` validates by hand. The ledger stamps
  `Date.now` while the store, subjects and the journal take a clock. `restoreKnowledge` decides a
  salvaged row's subject three ways. `comment-attach-mutants.test.ts` writes into `core/src` and
  raced the residue sweeps until the walker tolerated a vanished path; the writer should still
  move to a temp copy. The protocol table's `mutates` flag means safe to retry and reads as
  "writes", which nearly got it cross-checked against the handler effects. The MCP renderer puts
  ids into markdown tables and code spans with no escaping for a pipe or a backtick, a class older
  than this phase. The cycle's step text carries the phase as it read when the cycle started, not
  as the file reads after reconciliation; auditors were pointed at the file each time.
- Building Phase 1: where demand eligibility lives moved three times, from the recall, to
  `demandOf` reading the `stranded` field, to the store's guarded insert, before it had one owner;
  the "dead address is not work" rule was remembered at four ledger sites before the live views
  owned it (the phase's Bug Classes). `replaceFile` clears `parse_failures` for its module, so a
  test that wants a present-and-failing module has to empty the file before recording the
  failure, which nothing documents. The reference provider refuses moves, so the end-to-end
  `refactor_move` sentence still waits on a fixture provider. The residue that keeps raw readers
  out of the ledger matches spellings, so an alias or a helper in another module walks past it,
  the same limit the refusal residue has. The overview's answer total is raw and its stale count is
  live, which reads as a discrepancy until one knows the first is coverage and the second is work.
- Building Phase 0: two of four relay agents returned "ready, awaiting instruction" in place of the
  report their Codex agent had written, and the collator counted the angles as empty; the reports
  were recovered from the relay transcripts and the relay prompt now demands the final response
  verbatim and nothing else. The hygiene audit caught the line the plan had claimed the code
  already drew: an indexed module was decided by whether it held declarations, so an indexed
  module holding none read as unknown, and the store's `depthOf` now decides. The wire shape had
  let `forwardedTo` ride on any kind; it is a discriminated union. The red team found two refactor
  handlers returning the resolver's problem without the index state every other handler wraps it
  in, and `symbol_source` picking the symbol id when handed both ids. The plan's "built-server
  test" was never a test in this repository; the built bundle is driven by a probe script, and the
  plan now says so. The stranded case could be reached through the daemon by deleting a file; a
  moved one needs a provider that moves, which the reference provider refuses, so it is proven at
  the writer.
- Building Phase 2: the plan's own fixture was wrong about its trap, since `Total` does not contain
  `at`, and the first service test passed for the substring ranking as much as for the grammar's;
  `Cart` contains `at` and `ref` sits in every id's language and module fields, which is the
  fixture that discriminates. The first cut sliced the unparsed rest from the text by offset, past
  the cursor the parsing law names as the only reader; rewinding to the descriptor's mark reads it
  through the cursor, at the cost of `readOccurrence` no longer marking its own bracket, so an
  occurrence failure now brackets the whole descriptor like every other descriptor failure. The
  plan had said the tail fallback runs only when nothing parses; matching parsed names and the
  rest together is simpler to state and promotes `Total` in `Cart#Total`, and the plan was
  rewritten to what shipped. The relay prompt that demands the final response verbatim held for
  all six relays this lap.
- Building Phase 3: the smallest phase, and the audits still found the seeded sentence naming the
  question whatever the flag said, one of four places the renderer composed the question and the
  only one the plan had not listed; the fix was the same `asked` the other three use. The
  zero-row branch said "no gaps" over a staleness scan that had not run, a lie by omission older
  than the phase and one line to close. A relay swallowed its report for the third time across
  three laps despite the verbatim demand, so the recovery script in the scratchpad is now part of
  the routine rather than a repair. Every `knowledgeGaps` test that mocks the shape had to learn
  the field, since an omitted flag now drops the question label, which is the safe direction
  the plan chose and the cost it did not name.
- Phase 4 refinement, narrow, after the replan: five auditors over the five paragraphs amended
  at Questions 11 to 13, eleven findings, nine held, two misread. The amendments made in a day
  had the same fault the plan's own rule names: a mechanism stated from memory. The store's
  clock reads were miscounted and misclassified, and routing one of them through a new
  `replaceFile` parameter would have broken a dozen direct test callers, so the store takes the
  clock at open instead and joins the routed list. `rebind` names only what moved, so a refused
  collision is read as the submitted entry `applied` does not name, and the holder is named only
  where the candidate predicate already includes it. Pass A's restore step was reached by
  nothing: `replaceFile` restores on the write, `claim` on a write at the address, and the
  rebuild keeps an orphan orphaned, so the step is gone and restore has the two owners it had.
  The stranded window sat above the seeding gate, which would have stopped seeding on a
  workspace whose only knowledge is stranded, and the renderer's no-gaps return would have
  hidden it; both decided in the text. The two misreads: the twins test, whose survivor is no
  match because its module is not new to the pass, and the wire sentence, which was right about
  the fourth `why` value and muddled about why.
- Building Phase 4: one hygiene and alignment finding, then two red team rounds, eight and three
  findings, ten fixed and one held. The two majors were both a mechanism trusted one step past
  where it was proven: `refreshDigests` ran only when a write carried digests, so an outline
  write left a subject wearing the digest of a body the index no longer knew, and the timer's
  sweep ran under the gate but not on the batch tail, so without a gate it could delete an
  expired orphan while the batch recreating its file was mid-parse. Both fixes narrowed to what
  the code already owns: every write sets the module's digests to what `symbols` holds, and
  `serializeBatches` gained `run` so a sweep is one more item on the one tail. The test harness
  bit twice: `advance` fires timers inside the call and the sweep now runs in the microtask after
  it, so a test that read "not yet deleted" between the two was reading the old synchronous
  timing; and the store lived inside the watched root, so its own sqlite writes arrived as a
  watcher batch whose sweep took the deletion the timer test was asserting on. The daemon's two
  teardown paths differ: the handover holds the gate through `releaseEverything` so a queued
  batch can never reach a closing store, and the signal path does not, so a batch mid-parse at
  SIGTERM can still write after `store.close()`. Pre-existing, one line to align, and the owner's
  call, since holding the gate at SIGTERM makes a wedged provider a wedged exit. Held: a provider
  outage on a module whose last good parse already lacked the declaration orphans it, which is
  the plan's orphan, and the next parse restores it.
- Building Phase 5: an eleven-finding first audit, then two red team rounds, fifteen and five
  findings, of which fourteen were fixed, four held and one disproved. The pattern was the same
  as Phase 4's: a verdict trusted one step past where it was written. The map admission built was
  read at write time only, so a `.gitattributes` edit reached no file the pass left unread, an
  outage kept an old verdict, and the background upgrade wrote the map it had; the fix was to
  make every pass write its map onto every row before pruning, a sync, rather than to chase each
  reader. The migration put two column adds under one existence check, so a crash between them
  would have skipped the second forever: each column checks itself now. The seeding SQL and the
  decoder read a corrupt row two different ways until the SQL was written to say exactly what
  `verdictFromRow` says. Pre-existing and found by the way: `linguist-generated=false` had read as
  generated since the reachability rule was written. The test harness bit again: a root that
  becomes generated is pruned, correctly, so two tests that expected a stored verdict to change
  under a root were asserting on a row the pass had rightly forgotten; the sync is only visible
  on a file something still imports. One auditor claim, that the batch test would pass without
  the sync, was settled by removing the call and watching the test fail, which is the cheapest
  argument there is. Deviations recorded in the phase text: `mostReferenced` keeps the `hubs`
  tool's meaning and gains only the tie-break, the language is read from one id per module
  through `languageOf`, `seededUnknown` counts the page, and a direct writer records no verdict
  rather than a lie.
- The verification drive after Phase 5, through the built server. The sweep scenario passed on
  the first run. The seeded page against the two-language checkout took two runs, twelve minutes
  to index 1172 files and a probe whose timeout was shorter than that, and showed what no
  planted store had: with one turn per language, JSON, YAML, XML and HTML fields took turns on
  their own value literals, so eligibility now counts a literal in code files only and a heading
  by its prose. What the rule still admits is by design and is the owner's to weigh: a YAML key
  with a comment above it, a fixture language under `tests/fixtures` with fan-in one, and a test
  helper as a global hub (`frame()` in a `__tests__` helper, fan-in 300). Three minified vendor
  scripts time out the TypeScript provider at sixty seconds on every scan; pre-existing, and the
  page says so. The plan's own Replan 1 section was written in the present tense about wiring
  that does not exist yet and the audit caught it, the same fault the refinement laps kept
  naming.
