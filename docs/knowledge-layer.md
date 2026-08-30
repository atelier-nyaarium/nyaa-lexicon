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

An address that stops resolving keeps its subject, bound and unresolved, until a write at the kept
address restores it. Nothing orphans a subject on its own yet: the sweep that judges a vanished
address by pattern digest, dates orphans and deletes them is not built, and `unresolved` lists
what it would judge.

## Rules

- **Narration never edits facts.** The answer path can only resolve ids, so a hallucinated edge has
  nowhere to land. That is enforced by construction, not by care.
- **Generate on demand.** Bulk-describing a repository is expensive vanity; the gap ledger records
  what people actually asked for and could not get.
- **Report health honestly.** An answer over a partial index says so. A caveat that is usually
  wrong is one a reader learns to skip.
