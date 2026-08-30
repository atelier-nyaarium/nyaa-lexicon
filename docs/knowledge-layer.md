# Knowledge layer

The facts below the line are derived from source. This layer is what someone knows about the code
that no parse can recover: why a design was abandoned, which two constants must never merge, that a
residue test enforces an invariant by grep. No reference edge connects any of that.

Lexicon never calls a model. The consumer of these tools is already an agent reading the code, so a
second model call inside the core would pay twice and bind the tool to a key and a bill. The core
hands over facts, takes back prose, refuses what it cannot verify, and remembers.

## The citation rule

An answer is prose PLUS the fact ids it consumed. That pairing is the whole design, because it
makes "never answer cold" a property of the store rather than a slogan: an answer citing nothing
cannot be written down at all.

What counts as a fact ABOUT a subject is its declaration, the references to it, the literals and
comments inside it, the imports that reach it, the answers already recorded on it, and, for a
heading, the prose under it. An answer is never ABOUT prose, but prose is evidence, so a section's
own text is what an explanation of that section cites.

Four citation refusals, each closing a different way of recording something ungrounded:

- **No citations.** The cold answer this layer exists to prevent.
- **A citation that is not a fact id.** Diagnosed separately from one that does not resolve,
  because the usual cause is copying only the trailing digest, and the unresolved wording sends
  that author off to re-fetch ids that were never the problem.
- **A citation that resolves to nothing.** A fact id is a digest of its own contents, so an id that
  does not resolve was either invented or describes something that has since changed.
- **Nothing cited about the subject.** An answer may cite a neighbour, since answers compound, but
  one citing only neighbours describes them rather than the symbol it claims to be about.

An answer whose citations all sit on the subject's own declaration is stored and graded THIN. It is
a paraphrase of what a reader already sees: grounded, legitimate, and adding little. Refusing it
would teach citation padding, so a visible grade invites a better answer instead.

## Refusals name the mistake

A refusal is the only channel through which an author learns what to do, since the core never
calls a model and cannot fix a write itself. So every refusal names what the author did and what to
do instead, and every one is composed in one module, `core/src/refusals.ts`, as a named constructor
returning a branded sentence. The ledger and the citation checker choose an outcome and put a
constructor's result in the reason slot; they compose none of their own. A raw string in that slot
is a type error in core, and a residue test refuses the cast, in every spelling, outside the owner.

## Question classes

A closed vocabulary rather than free-form chat, because a class the core cannot render is worse
than one it refuses.

| Question | Answers |
|---|---|
| `describe` | what this is and its role |
| `why` | rationale and scar tissue |
| `relate` | how it connects to what surrounds it |
| `contract` | what callers may assume, and what breaks them |
| `effects` | what it mutates, influences, or lets escape |
| `usage` | how to call it |

## Answers are facts one layer up

An answer carries its own citable id, so a description of a class can cite the descriptions of its
members. Knowledge compounds, and the walk that reads an answer is what carries doubt back down
from anything it leaned on.

## Three ways an answer goes bad

**Mechanical.** A cited fact's id stops resolving, because a fact id is a digest of its contents.
Noticing costs a lookup, not a model call. This is why a provider improving its analysis retires
ids: the facts genuinely changed identity, and the layer feels it.

**Declared.** Someone read the code and no longer trusts an answer, without rewriting it. Doubt
does not retire the answer's id, so citations still resolve; the recall walk carries it downstream
instead. Clearing a doubt requires citing the doubt's own id, which only a recall shows, so a
writer who never looked cannot erase a warning. An uncited doubt rides forward onto the rewrite
rather than being dropped.

**Adjudicated.** The answer is wrong while every input still holds. Replacing it requires covering
the incumbent's live citations or explaining the omission.

Re-affirming is the heal: the same prose re-grounded on current ids in one call, which retires the
old id so anything citing it heals the same way, leaves first.

## Knowledge is about a subject

A symbol id embeds the symbol's name and its module, and a member's id embeds its container's, so
renaming a class or moving it to another file re-mints its whole subtree: its methods, their
parameters, everything declared inside it. Nothing about the code changed meaning, but every id
written about it stops resolving.

Knowledge is therefore not keyed by the id. It is keyed by a subject: an opaque identity minted
the first time anything is written about a declaration, whose current address is the symbol id.
`core/src/subjects.ts` owns the table and every transition. The store reads through views that
join a row to its subject and hand back the current address, with the address the row was
recorded at beside it, and recall carries the subject: where the answer was recorded, the
evidence that brought it to this address, and since when. A row's key never changes: a trigger
refuses the update, no merge exists, and identity moves only by rebinding the address.

A write claims through one owner method: where the address resolves to a declaration it mints a
subject or restores the orphan kept there; where it does not, an orphan is kept as it is, and an
address holding neither is refused with the catalog's diagnosis. A recall is a read; the demand
it found is counted afterwards as the daemon's own write.

A rename or move through a refactor step builds the old-to-new address map from the id grammar
before it writes anything and journals it with the step. Once the files are written and the
reindex has been attempted, whatever it returned, the transaction manager rebinds the subjects
and records exactly what moved, each with the state it replaced, in the same transaction, so
recovery, undo and revert put back that and nothing else. An address that already holds a subject
is never a rebind target: two subjects never merge, and the one already there keeps describing
the code as it stands. Prose survives a move; its citations go stale on their own, which is
correct, because the facts underneath really did change identity.

An address that stops resolving keeps its subject, bound and unresolved, until a sweep judges it.
The indexer runs one after every prune, at the end of a full scan and of every watcher batch, and
the live index runs one every hour so an idle workspace still ages; the store's identity owner does
the judging in `sweepSubjects`, one bounded batch in one transaction, from what the indexer just
decided about presence: a module is absent when the prune did not reach it, failing when it holds
a parse failure, parsing otherwise. Every write of a module sets its bound subjects' pattern
digests to exactly what the index holds, null after an outline or surface parse.

- **Exempt.** A subject in a failing module is left alone; nothing is dated while a person is
  mid-edit. A malformed address has no module and is never exempt.
- **Rebound.** Exactly one declaration among the modules first indexed in the pass digests the
  same, with the same name and kind: the subject moves there with evidence `batchExactMatch`, no
  date is set, and the old address forwards. A subject with no digest never matches, and the timer
  has no new modules, so it never rebinds. A target another subject already holds is refused, and
  the refusal reads `ambiguous` naming the holder.
- **Orphaned.** Otherwise the subject is dated, with evidence `ambiguous` and the candidates when
  several declarations matched, `none` when none did. An orphan leaves every queue at once and
  costs nothing until a module write restores it: a re-index that puts the declaration back at the
  kept address restores the subject as it lands, so does a write there, and a compat rebuild keeps
  an orphan orphaned with its date.
- **Deleted.** Thirty days after the date, with its answers and its demand. A date ahead of the
  clock reads as now, so a clock that went backwards deletes nothing early.

A sweep examines at most `ORPHAN_SWEEP_CAP` subjects and persists a cursor in store meta, so the
next one resumes where it stopped and every subject is examined within an epoch. What it did is
the `knowledgeSweep` field of the scan summary. The indexer, the store and the sweep timer read one
`Clock`, the same instance the daemon opens the store with, which is what lets one fake clock age a
workspace in a test.

## A refusal says what stands at the address

Every write at an address the index does not hold, and every recall of an answer whose address no
longer resolves, is diagnosed from the subject's state (`KnowledgeSubjects.stateOf`) before any
sentence is composed, so the wording agrees with what the identity owner last recorded:

- **Moved.** The address was vacated by a rebind: the refusal names the new address and the
  evidence, and says the knowledge is recalled there. Only the last vacated address of a subject
  forwards; one two rebinds old reads as unminted.
- **Stranded.** A subject still names the address and the index no longer holds it: the refusal
  says whose knowledge stands there (the answers, or only the demand), the date it was orphaned if
  it was, and where a reader might find the declaration now. Candidates are declarations elsewhere
  with the same name and kind (`sameNameAndKind` in the id grammar, applied by `candidatesFor`);
  they are for a person to read, and nothing is ever bound by one.
- **Waiting on a parse failure.** A bound subject whose module is present and not parsing: the
  refusal names the failure's reason and says nothing is orphaned or deleted while that holds.
- Otherwise the unminted shortlist, the unknown module, or the unparsable spelling. The shortlist
  leads with the declarations the bad id spells, as the grammar reads it: `parseSymbolIdPrefix`
  keeps the descriptors parsed before the failure and the text from the failing descriptor on, and
  `spellsName` matches a name against those descriptors and the whole tokens of that rest, so a
  name like `at` is not promoted by every id containing those letters.

Recall carries the same diagnosis as `stranded` beside the answer, and the MCP surface renders it in
place of the re-affirm instruction, which a stranded subject cannot follow.

The diagnosis is one value, `diagnoseSubject` in `core/src/refusals.ts`: a closed kind
(`factIdAsSubject`, `unminted`, `moved`, `stranded`, `waiting`, `unknown`), the sentence, the ids a
reader might mean, and for a vacated address where it forwards. `subjectRefused` is its sentence,
and every site in core that meets a symbol id naming nothing routes through it: the knowledge
writers, `typeOf`, `SourceWorkspace`, and the refactor planner. The daemon exposes it as the read
method `diagnoseSubject`; the MCP adapter's `resolveOne` asks `declarationOf` for any supplied id
and answers with the diagnosis on a miss, so every tool taking a symbol id says what a writer says.
An indexed module holding no declarations is unminted territory; an unindexed one is unknown. A
residue forbids the two absence sentences in production outside the owner.

## Work exists only at an address the index holds

The identity owner declares `answers_live` and `gaps_live`, the addressed views joined to
`symbols`, and every ranking reader in the ledger (the gap queue, both recheck scans, the overview's
stale count) reads them through the store's `live*` surfaces, so a dead address cannot reach a
queue. The raw readers stay for recall, doubt and diagnosis, which must see stranded rows, and a
residue forbids them in the ledger's ranking paths. Demand is decided at the write: `recordGap`
inserts only where `symbols` holds the address, so a recall of a stranded answer counts nothing,
and the `stranded` field on the wire is explanation, never eligibility.

Orphaned subjects are still seen. The workspace gap list appends their rows after the actionable
ones, each flagged `stranded` with the date and the evidence, and carries their count apart from
`total`, which counts actionable rows only; the seeded fallback decides on actionable rows, so a
workspace whose only knowledge is stranded still seeds its hubs. The rows come from
`strandedRows`, the identity owner's one reader over the addressed views, in the order pass A
reads. That is a window, not a task, and a module scope or subtree walk never holds one.

The gap list says whether it filtered by the asked question: `filtered` is set by every core
return, `false` from the workspace demand sweep, which carries every question with rechecks first,
and `true` from the seeded fallback, the module scope and the subtree walk. The MCP renderer names
the question only when the core says so, and reads an omitted flag as unfiltered.

## Rules

- **Narration never edits facts.** The answer path can only resolve ids, so a hallucinated edge has
  nowhere to land. That is enforced by construction, not by care.
- **Generate on demand.** Bulk-describing a repository is expensive vanity; the gap ledger records
  what people actually asked for and could not get.
- **Report health honestly.** An answer over a partial index says so. A caveat that is usually
  wrong is one a reader learns to skip.
