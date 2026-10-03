# Knowledge layer

The facts below the line are derived from source. This layer is what someone knows about the code
that no parse can recover: why a design was abandoned, which two constants must never merge, that a
residue test enforces an invariant by grep. No reference edge connects any of that.

Lexicon never calls a model. The consumer of these tools is already an agent reading the code, so a
second model call inside the core would pay twice and bind the tool to a key. The core hands over
facts, stores notes and refuses what it cannot resolve.

## Notes

One markdown note per symbol, mermaid blocks included. Its opening paragraph is the summary that
cards, hovers, `describe` and backlinks show. The markdown parser reads it (`noteOpening`), and a
read carries it as `summary` with `restAt`, where the rest starts. A note whose first block is not
a paragraph (a heading, list, quote, code block, rule, HTML block or link definition) bounces. Empty text removes the note. A write
carries the revision it read, and a mismatch bounces with the note as it stands.

What to write is the `write_note` prompt: what the symbol is for, then only what the code and its
doc comment do not show.

A ref is a link, `[label](ref://path:Scope:Name)`, or `[label](ref://path)` for a file, anywhere in
the text, a mermaid `click` line included; never inside other code. Saving resolves each to a
subject and refuses a broken or ambiguous one with candidates and its text offset (`at`). Refs are stored by subject, so a read
renders each at its target's current address and a rename needs no rewrite. `noteBacklinks` reads
them back.

Advisories are computed on read: the symbol's source changed since the revision was saved or
confirmed, a ref's target is gone or changed, a doubt stands, a proposal waits. A doubt belongs to
one revision; the next save or confirm clears it.

The author comes from the harness, never the writer. A client names a person or the agent it
launched; the MCP adapter names the client from its handshake. An agent's write over a note a person
wrote or confirmed becomes a proposal for that person. A newer proposal replaces it with a later
`at`; resolving names the revision and the `at` shown, so a replaced proposal refuses.

The MCP tools are `read_note`, `write_note`, `doubt_note` and `note_backlinks`. Notes are written on
demand, never as a coverage sweep. A parameter or a local takes no note; its owner does.

## Refusals name the mistake

A refusal is the only channel through which an author learns what to do, since the core never
calls a model and cannot fix a write itself. So every refusal names what the author did and what to
do instead, and every one is composed in one module, `core/src/refusals.ts`, as a named constructor
returning a branded sentence. The note ledger chooses an outcome and puts a constructor's result in
the reason slot; it composes none of its own. A raw string in that slot
is a type error in core, and a residue test refuses the cast, in every spelling, outside the owner.

That holds beyond the knowledge layer. Everything that says why a read, a refactor step, a journal
operation or a write will not happen answers with the same brand: the source reader, the planner,
the executor, the transaction journal and the file writer. Where the protocol carries a plain
string on the wire, `core/src/refusalSlots.ts` narrows the shape for core alone, and
`refusalSlots.types.ts` asserts each of those slots against the compiler, so widening one back to
`string` fails the build. A warning is not a refusal and stays a string: `RefactorIssue.detail`
rides a step that succeeded, and putting it in the catalog would claim otherwise.

## Knowledge is about a subject

A symbol id embeds the symbol's name and its module, and a member's id embeds its container's, so
renaming a class or moving it to another file re-mints its whole subtree: its methods, their
parameters, everything declared inside it. Nothing about the code changed meaning, but every id
written about it stops resolving.

Knowledge is therefore not keyed by the id. It is keyed by a subject: an opaque identity minted
the first time a note is written about a declaration, whose current address is the symbol id.
`core/src/subjects.ts` owns the table and every transition. The store reads through views that
join a row to its subject and hand back the current address, with the address the note was saved
at beside it. A row's key never changes: a trigger refuses the update, no merge exists, and
identity moves only by rebinding the address.

A write claims through one owner method: where the address resolves to a declaration it mints a
subject or restores the orphan kept there; where it does not, the write is refused with the
catalog's diagnosis.

A rename or move through a refactor step builds the old-to-new address map from the id grammar
before it writes anything and journals it with the step. Once the files are written and the
reindex has been attempted, whatever it returned, the transaction manager rebinds the subjects
and records each move as a `refactor_rebinds` row, with the state it replaced, in the same
transaction as the move; the row's schema vouches for every field, so nothing is validated at
the read. Recovery, undo and revert put back exactly those moves, newest first, and delete the
rows in the same commit, so a crash between the two cannot report a reversed move as kept. A move
a reversal cannot put back, because its subject is gone, has moved on, or another subject holds
its old address, is named with that reason on the undo and revert results and in the recovery
log rather than silently left. An address that already holds a subject is never a rebind target:
two subjects never merge, and the one already there keeps describing the code as it stands. A note
survives a move.

An address that stops resolving keeps its subject, bound and unresolved, until a sweep judges it.
The indexer runs one after every prune, at the end of a full scan and of every watcher batch, and
the live index runs one every hour so an idle workspace still ages; the store's identity owner does
the judging in `sweepSubjects`, one bounded batch in one transaction, from what the indexer just
decided about presence: a module is absent when the prune did not reach it, failing when it holds
a parse failure, parsing otherwise. Every write of a module sets its bound subjects' pattern
digests to exactly what the index holds, null after an outline or surface parse. A pattern digest
covers kind, name and text, with comments cut and whitespace collapsed outside string literals.

- **Exempt.** A subject in a failing module is left alone; nothing is dated while a person is
  mid-edit. A malformed address has no module and is never exempt.
- **Rebound.** Exactly one declaration among the modules first indexed in the pass digests the
  same, with the same name and kind: the subject moves there with evidence `batchExactMatch`, no
  date is set, and the old address forwards. A subject with no digest never matches, and the timer
  has no new modules, so it never rebinds. A target another subject already holds is refused, and
  the refusal reads `ambiguous` naming the holder.
- **Orphaned.** Otherwise the subject is dated, with evidence `ambiguous` and the candidates when
  several declarations matched, `none` when none did. An orphan costs nothing until a module write
  restores it: a re-index that puts the declaration back at the
  kept address restores the subject as it lands, so does a write there, and a compat rebuild keeps
  an orphan orphaned with its date.
- **Deleted.** Thirty days after the date, with its note. A date ahead of the
  clock reads as now, so a clock that went backwards deletes nothing early.

A sweep examines at most `ORPHAN_SWEEP_CAP` subjects and persists a cursor in store meta, so the
next one resumes where it stopped and every subject is examined within an epoch. What it did is
the `knowledgeSweep` field of the scan summary. The indexer, the store and the sweep timer read one
`Clock`, the same instance the daemon opens the store with, which is what lets one fake clock age a
workspace in a test.

A compat rebuild salvages the knowledge tables before the index is emptied and puts them back
after. `normalizeSalvaged` maps every raw row into a closed value first, so nothing past it reads a
raw row: a row missing its address or its text is dropped and counted. The subject rows go back as
they were, and every note is placed through `placeRow`, the one method that decides which subject a
salvaged row belongs to. A row naming a subject that survived keeps it. A row naming a subject that
is gone revives that id, bound at the address its note was saved at, and is refused `held` when
another subject holds the address, since two subjects never merge. A row naming no subject joins
the holder of its address, or mints one there with evidence `none`. The open result carries the
unplaced and dropped counts and the daemon logs both.

## A refusal says what stands at the address

Every write at an address the index does not hold is diagnosed from the subject's state
(`KnowledgeSubjects.stateOf`) before any sentence is composed, so the wording agrees with what the
identity owner last recorded:

- **Moved.** The address was vacated by a rebind: the refusal names the new address and the
  evidence, and says the note moved there. Only the last vacated address of a subject
  forwards; one two rebinds old reads as unminted.
- **Stranded.** A subject still names the address and the index no longer holds it: the refusal
  says a note stands there, the date it was orphaned if it was, and where a reader might find the
  declaration now. Candidates are declarations elsewhere
  with the same name and kind (`sameNameAndKind` in the id grammar, applied by `candidatesFor`);
  they are for a person to read, and nothing is ever bound by one.
- **Waiting on a parse failure.** A bound subject whose module is present and not parsing: the
  refusal names the failure's reason and says nothing is orphaned or deleted while that holds.
- Otherwise the unminted shortlist, the unknown module, or the unparsable spelling. The shortlist
  leads with the declarations the bad id spells, as the grammar reads it: `parseSymbolIdPrefix`
  keeps the descriptors parsed before the failure and the text from the failing descriptor on, and
  `spellsName` matches a name against those descriptors and the whole tokens of that rest, so a
  name like `at` is not promoted by every id containing those letters.

A stranded note is still read at its address.

The diagnosis is one value, `diagnoseSubject` in `core/src/refusals.ts`: a closed kind
(`factIdAsSubject`, `unminted`, `moved`, `stranded`, `waiting`, `unknown`), the sentence, the ids a
reader might mean, and for a vacated address where it forwards. `subjectRefused` is its sentence,
and every site in core that meets a symbol id naming nothing routes through it: the note writer,
`typeOf`, `SourceWorkspace`, and the refactor planner. The daemon exposes it as the read
method `diagnoseSubject`; the MCP adapter's `resolveOne` asks `declarationOf` for any supplied id
and answers with the diagnosis on a miss, so every tool taking a symbol id says what a writer says.
An indexed module holding no declarations is unminted territory; an unindexed one is unknown. A
residue forbids the two absence sentences in production outside the owner.

## A scope, members first

`scopeSymbols` answers a symbol, a symbol with its declared members, or a whole module: each
declaration with its depth. Members come before the declaration holding them, siblings by line then
character, so a container is noted after its members. A symbol id the index does not hold answers
null; a module the index does not hold answers an empty scope.

- **Groupings hold nothing:** a `file`, `module`, `namespace` or `package` is not listed, and what
  it groups sits a level up, so a namespace's classes are a module's top level.
- **Locals:** a parameter, or anything under a container that holds locals, is left out unless
  asked for and counted with its subtree as `localsExcluded`. A container holds locals when its
  `contains` says `locals`, or it says nothing and its kind runs (`function`, `method`,
  `constructor`, `operator`). Core cannot tell a data value from a function value by kind, so the
  provider marks a value that runs: a TypeScript arrow constant, arrow property or getter says
  `locals`, and a nested JSON or YAML key under its parent key stays a member. `core/src/locals.ts`
  owns the rule.
- **Live declarations only:** a scope lists what the index holds, so it carries no stranded state.

It walks containment.

## Rules

- **Narration never edits facts.** A note only resolves refs; it never adds an edge.
- **Write on demand.** A note records what a reader learned that the code does not show, never a
  sweep for coverage.
- **Report health honestly.** A note's advisories say when its source or a ref changed.
