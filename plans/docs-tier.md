# Questionaire

## Question 0 - What is this for? (settled in chat, pre-questionaire)

Q: Why a docs tier at all?
A: Because searching this repo for `band-aid` returns nothing. That rule lives in `CLAUDE.md`, no
provider claims markdown, and half this project's own doctrine is invisible to its own tools.

> Add non-languages to your task board to do after shipping. md/mdc, json/jsonl/ndjson/json5, yml,
> xml, html, and plain text as a fallback for non provided ext. This will be a provider that doesn't
> quite provide types or anything fancy. Just a structured data format.

## Question 0b - Reuse `find_comments`, or a new tier? (settled in chat)

Q: Documentation prose is prose. Should it ride the comment tier that already exists?
A: No. A new DOCS tier with its own tool.

> how about this, we treat documentation format files as a new type: docs? so you "search docs"
>
> See tool treeMd and try it

The owner was right and I was wrong. I argued for reusing the comment tier because its data model
fits. Trying `treeMd` changed my mind, and the reasoning is the whole design:

In CODE, structure and prose are separate, and deciding which symbol a comment belongs to is the
entire hard problem. That was Phase 3 of the comment work: two range conventions, scope containment,
annotation gaps, four bugs. In a DOCUMENT there is no such problem. Prose under a heading belongs to
that heading, trivially, by position.

Routing docs through the comment tier would carry four form values (leading, trailing, inline,
standalone) that are all meaningless for a paragraph, an attachment resolver with nothing to
resolve, and a name that lies about what a paragraph is.

The deciding argument is that a docs search must ANSWER differently. The useful answer to
"band-aid" is not a span at a line number, it is a heading path (`CLAUDE.md > Principles > No
band-aids`) and then the prose. Different result shape, so a different tool.

`treeMd` against this repo's own `CLAUDE.md` returns exactly that shape: nested headings, each with
a size. Layout, Principles, Development (containing Releasing), Verifying a change, Rules that
already cost something, Blind test corpora, References.

## Question 1 - Is a heading a declaration, or its own fact class?

Q: Headings as declarations, documents as their own fact class, or both split by purpose?
A: C - both, split by what each is for.

> alright C

A heading is a DECLARATION of a new `heading` kind, added to `SymbolKindSchema`. The prose under it
is its own searchable fact with its own tool. Structure reuses the symbol machinery; prose gets the
search that this feature exists for.

**Why C, and it was the recommendation:** A and B both fail the founding use case, just
differently. `search_symbols` matches NAMES, so neither headings-as-declarations nor a
documents-only fact class finds `band-aid`, which lives in prose. Only splitting them makes prose
searchable at all. The new kind is simultaneously the filter that stops document headings polluting
`search_symbols`, the overview counts and `type_of`.

Rejected A because reuse without a distinguishing kind poisons every existing query surface.
Rejected B because it discards `outline_module`, id addressing, range lookup and reference edges,
all of which already work and all of which documents genuinely have.

Accepted costs: two things to build instead of one, and heading renames re-mint every heading
nested beneath. The churn is judged to be real information rather than noise, since prose written
about a renamed section may genuinely no longer apply.

## Question 1b - What is a "function" in a document? (asked by the owner)

Q: If a heading is a declaration, what are the other kinds?
A: There are none, and that is not a problem.

No document has a function, a type, a parameter or a constructor. Nothing in a document is invoked.
The objection this raises, that the declaration model is being forced onto prose, does not survive
contact with what the providers actually emit: the kind enum is ALREADY a union no single language
uses fully. C emits no interface and no enum. GDScript emits no namespace. TypeScript emits eleven
kinds nobody else does. A document using one kind is a difference of degree from C using six, not a
difference in nature.

What a document actually has:

- **A section**, which is the new `heading` kind.
- **A key**, in JSON and YAML, which is already `property` or `field`. Its value is already a
  literal. So structured data reuses two kinds that exist and needs nothing new.

What being a declaration BUYS a heading, none of which is hypothetical:

- An addressable id, so an answer can be recorded about a section and cited.
- A container, so `outline_module` returns a table of contents with no new code.
- A range, so `symbol_source` reads a section's exact text.
- **References.** A markdown link to `#releasing` is a real edge. "What links to this section" is
  `find_references`, working on documents for free. This is the strongest argument for the
  declaration model and it is easy to miss.

## Question 2 - What happens to a fenced code block?

Q: Ignore fences, treat them as text, index them as literals, or hand them to a provider?
A: pending the owner, but three of the four options are eliminated by evidence rather than taste.

One Luna argued each option, each told to argue honestly including against itself.

**Option 3, index fence contents as LITERALS: dropped, its own advocate said never.** It is a
category error at the protocol level. `LiteralSchema` defines a literal as ONE atomic value of kind
string, number or boolean, and a multi-line shell command is neither one decoded value nor one
lexical token. Forcing it in would pollute `find_literals`: a numeric range query would start
returning version numbers and flag values scraped out of documentation. The narrower variant, lexing
fences and indexing the tokens found inside, is coherent but needs shell, TypeScript, Python and
JSON lexers in core, which the never-branch-on-a-language residue test forbids.

**Option 4, hand the fence to its language provider: dropped, its own advocate said never.**
`parseFile` assumes a whole file, so a snippet embedded at an offset inside another file breaks the
range contract. Doc examples are routinely invalid standalone: no imports, one method body,
pseudocode. Worst of all, a `function foo()` in a README example would become a declaration that
does not exist, indistinguishable from a real one, which is precisely the lie this project exists
to stop telling. Reconsider only if fenced examples ever need to be type-checked.

**Option 1, ignore fences: self-defeating here.** Its own advocate concluded pure silent ignoring is
indefensible under the project's doctrine and only ships if it REPORTS what it skipped. The measured
table above is the reason: four of five operational terms in `CLAUDE.md` live only inside fences.
It also hides the wire surface itself, since `docs/provider-protocol.md` documents `initialize`,
`parseFile`, `resolveImport`, `bind`, `typeOf`, `renameEdits` and `moveEdits` inside a fence.

**Option 2, a fence is TEXT belonging to its section: recommended.** Fence contents join the
enclosing heading's prose fact, searchable as text, never parsed as code. It is the cheapest option
that answers the real questions, and the semantics are right: a shell command in documentation IS
prose about how to use the thing.

The bloat objection is already solved machinery rather than new work: the comment tier caps a
preview by lines AND width (`COMMENT_PREVIEW_LINES`, `COMMENT_PREVIEW_WIDTH`) while keeping the full
text searchable. Generalize that contract rather than copying it.

### The one sub-choice that is genuinely open

Should a doc fact record WHETHER a match sits inside a fence, so a result can say "this is in a code
block"? Both advocates raised it and both suggested deferring, on the grounds that it touches the
parser, the schema, persistence, the protocol types and the renderer.

That reasoning is right for an EXISTING schema and wrong here. This schema does not exist yet. A
flag costs almost nothing while the shape is being born, and costs a migration once it has shipped.

## Question 2b - Should a docs match surface during a SYMBOL search?

Q: The owner objected to certainty and counter-proposed a hedged pointer.

> I don't think we should mark fences to a degrtod absolute certainly: Foo is a class in blah file.
> At most, we attempt to detect and say in a symbol_search: This thing in [Docs > # Title ##
> Section] MIGHT be relevant.

A: The fence marker, and nothing else.

> hmm. let's keep it simple. Fence marker is all it needs.

So the hedged hint is dropped, and the resolve-only doc-to-code bridge is descoped with it. Reading
that as scope rather than rejection: markdown links that resolve to a heading are a plain
consequence of headings being declarations, so they are deferred rather than ruled out.

Five adversarial angles produced a third answer better than either side's, and it is recorded below
because the reasoning outlives the decision.

**The two proposals were never the same claim, and the adjudicator ruled so.** A fence marker
records that bytes sat between two fence lines. It asserts nothing about any symbol. The precedent
is already in the comment tier: `isBlockComment` recognises shape, and `form` and `placement`
describe geometry rather than truth. Even `anchorId` is positional association, not semantic
identity. Conceded against it: a marker is a foothold, and each step from presence to correlation to
ranking looks neutral until the accumulated surface invites resolution.

**The hedged hint fails this project's own uncertainty rule, which is the opposite of the intuition
behind it.** The doctrine is that every Unknown carries a reason from a CLOSED ENUM. "MIGHT be
relevant" carries no value about the symbol and no closed reason; it is unfalsifiable, so it can
never be wrong and therefore never informative. "This match is inside a fence" is falsifiable and
carries a reason. By the project's own standard the MARKER is the rigorous one and the HINT is not.

**Measured rather than argued: roughly 25 to 30 percent useful.** Of seven real symbol names sampled
against this repo's documentation, two appeared, and both would have been useful pointers. But the
inverse direction is where it dies: common words like build, index, provider and answer appear
constantly, so every textual coincidence becomes a breadcrumb. Search results are ordered by module
and start line with no relevance ranking, and the 50-result default would let documentation
displace real declarations. A 25 percent signal is precisely "the caveat a reader learns to skip".

**The better shape, from the angle told to propose what neither side had: build only on what
RESOLVES.** Two things in a document are verifiable with zero inference:

- A markdown link to a heading anchor that RESOLVES is a real reference edge.
- A fenced command naming a file path that EXISTS in the index is a verifiable observation.

"This document links to the heading `#releasing`" and "this fenced command names the existing path
`core/src/indexReads.ts`" are both actionable and assert nothing speculative. A symbol name merely
appearing in prose is not surfaced at all. The bridge fails closed.

This gives the owner exactly what they asked for, which is no assertion, while still connecting
documents to code. And it makes the fence marker MORE useful rather than less: a resolved path
inside a fence is a command someone can run, while the same path in prose is a mention.

**Evidence that this is not theoretical:** `toolsTreeMd` in nyaascripts, the tool that prompted this
whole design, scans headings with `/^(#{2,})\s+(.+)$/` line by line and does NOT skip fenced blocks.
A markdown example inside a fence registers as a real heading. This repo survives it by luck, since
its fences hold shell comments that use a single `#`. Any document quoting markdown would produce a
phantom section. Whatever v1 decides about fence CONTENTS, it has to skip fences when finding
headings, or it inherits that bug on day one. That much is forced and is not the question.

### Measured against this repo's own documentation

817 lines across six documents, holding seven fenced blocks: four in `CLAUDE.md`, two in
`docs/provider-protocol.md`, one in `README.md`. `architecture.md`, `knowledge-layer.md` and
`parsing.md` have none at all.

Every fence in `CLAUDE.md` is a RUNNABLE COMMAND, and those commands answer the questions people
actually ask. Counting occurrences of each term in the whole file:

| Term | Occurrences | Where |
| --- | --- | --- |
| `index-workspace` | 1 | inside a fence |
| `build patch` | 1 | inside a fence |
| `conformance.js` | 1 | inside a fence |
| `bun install` | 1 | inside a fence |
| `grade.js` | 2 | one in a fence, one in prose |

So ignoring fences makes four of five operational terms UNFINDABLE, and the fifth findable only by
luck. "How do I cut a release" is answered by `bun run build patch|minor|major`, and that string
exists exactly once in the repository, inside a fence.

That is the `band-aid` failure repeated with different words, in the same file, which makes option 1
close to self-defeating for the corpus that motivated the feature.

## Question 3 - Release timing

Q: Does the docs tier ship inside the unpushed `2.0.0`, or as a later major?
A: Inside `2.0.0`.

> 2.0

So breaking the wire is free for the duration of this work. Users rebuild their index once rather
than twice. Every option below is costed on that basis.

## What the research established

Seven angles, one Luna each. The lean split was 2 for A, 2 for B, 3 for neither, and the split is
itself the finding: the fork as posed was a false binary.

**The decisive fact: `search_symbols` matches NAMES only.** The motivating example is `band-aid`,
which lives in the prose under `## Principles`, not in any heading. So headings-as-declarations
does NOT solve the problem this feature exists for. Structure and prose are separate questions and
only one of them was ever the point.

**Headings need no protocol change.** `DeclarationSchema` already carries symbolId, kind, name,
range, selectionRange and containerId, and does not distinguish code from prose. A heading can flow
through the declaration channel untouched.

**But reuse poisons the query surface.** There is no `heading` or `section` member of
`SymbolKindSchema`, so nothing can filter documents apart from code. `search_symbols` would
conflate heading names with code names, the overview symbol count and largest-module ranking would
inflate, and `describe_symbol`, `type_of` and the refactor tools would offer code semantics on a
paragraph. `most_referenced` is unaffected, since it ranks on reference edges documents will not
have.

**`outline_module` works on a document for free**, needing only that a provider emit valid
declarations with `containerId`. The algorithm itself has no code assumption.

**A new REQUIRED tier costs 9 provider declaration sites plus 3 test fixtures**, and is a protocol
major because an older provider's initialize response then fails validation. An OPTIONAL fact field
avoids that, following the pattern where absence means the tier is false.

**Editing a heading re-mints every heading nested under it,** because a member id embeds its
container. Documents are edited more often than code is refactored, so this is real identity churn.

**The plain-text fallback is more dangerous than it looks.** Routing is by exact extension, and
there is NO binary guard anywhere in the read path: every claimed file is read as UTF-8. A fallback
claiming every unclaimed extension would claim lockfiles, minified bundles and images, and would
turn honest "unclaimed" reporting into false coverage. Deferred to its own question.

## Question 3 - What formats does v1 claim?

Q: The owner named md/mdc, json/jsonl/ndjson/json5, yml, xml, html, and plain text as a fallback for
any extension no other provider claims. Is that one provider, and is it all of v1?

A: The whole set. Markdown gets its own phase, then one Luna per remaining format.

> whole set. we can do markdown as a place, and do the usual 1 Luna per new language.
>
> * place = phase

So the recommendation below was NOT taken, and the concerns it raised become work rather than
reasons to defer. In particular the plain-text fallback ships, which makes the binary guard a
REQUIRED deliverable rather than a precondition for starting. It is listed as its own slice, before
the fallback that needs it.

Evidence already gathered, so this does not need another fan-out:

**"Just a structured data format" hides a real split.** One provider PROCESS can host several
format-specific parsers, but one PARSER for all of them is not sane. Markdown is an ordered document
with inferred heading nesting. JSON is a value tree. JSONL is a sequence of independent roots. YAML
has mappings, sequences, aliases and multiple documents. XML is an ordered element tree with
attributes and namespaces. HTML is error-tolerant with implied elements. Those differ in identity,
parentage and prose ownership, and `FileFacts` is declaration-shaped: it does not naturally carry
arrays, attributes, mixed content or multiple roots.

**Markdown needs no dependency at all.** `toolsTreeMd` proves the heading scan is about fifty lines,
and fence tracking is a few more. Every other format wants a real library (`json5`, `yaml`,
`fast-xml-parser`, `parse5`, a commonmark implementation), and `docs/parsing.md` rule 1 says use one
rather than hand-writing. But `dist/` is committed and shipped, currently 9.9 MB with provider
bundles from 376 KB up, so each library is permanent artifact weight for every consumer.

**The plain-text fallback is the dangerous part.** Routing is by exact extension, and there is NO
binary guard anywhere in the read path: every claimed file is read as UTF-8. A fallback claiming
every unclaimed extension would claim lockfiles, minified bundles and images, producing replacement
characters and parse noise. It would also turn honest "unclaimed" reporting into false coverage,
which is the misalignment class this project exists to hunt.

**Recommendation: markdown only in v1.** It is the motivating case, it is the cheapest, and it needs
nothing new on disk. JSON and YAML keys as declarations with their values as literals is a genuinely
good second provider, not a v1 obligation. The plain-text fallback should not ship until a binary
guard exists, and should probably be opt-in even then.

## Question 4 - Divide providers into Docs, Structured Data and Code?

Q: Should lexicon gain a top-level provider FAMILY with three members?

> should we keep it divided between Docs (markdown), Structured Data (json, yml, xml), and Code
> (everything we have so far?

A: No family field. The division is real and already lives one level down, on the symbol.

> sounds good! lock that answer into the questionaire plan

Four angles split two and two, and both halves of my own hunch were refuted.

**Derivation is unsound, which kills half my hunch.** I guessed a family could be derived from the
tiers a provider already declares. It cannot. All eight current providers declare every tier true,
so no tier combination identifies anything. More fundamentally, tiers describe CAPABILITY and a
family would describe KIND: a weak code provider that cannot answer types is not a documentation
provider, and derivation would say it was.

**A provider-level family is unsound too, which kills the other half.** The meaning varies WITHIN a
file, not per provider. HTML is a document and a tree at once. XML is generic data, and also DocBook
and SVG. Markdown with YAML frontmatter is a document containing structured data. A Jupyter notebook
is JSON containing markdown containing code. Ghidra output is machine-generated and still C. A file
cannot carry one family honestly, and a provider certainly cannot.

**The right granularity is the SYMBOL, and it already exists.** What actually differs between the
three is what a symbol MEANS: something callable, a section whose payload is prose, or a key whose
payload is a literal. `SymbolKind` is exactly that concept, it is already the single owner of it,
and `search_symbols` already takes a `kind` filter (`adapters/mcp/src/tools.ts`).

So the `heading` kind decided in Question 1 already buys the whole division:

- A markdown file with frontmatter emits `heading` declarations AND `property` declarations. No
  file-level lie, because the classification sits on each symbol.
- Overview honesty is a group-by-kind, not a new field.
- "Search only code" is a kind filter that already exists and starts working the moment `heading`
  is added.

**What a family field would have cost:** 9 provider declaration sites plus 3 test fixtures, the same
as a required tier. Its own strongest advocate conceded it must NOT classify unclaimed files, since
routing knows only extensions and that would be a second source of truth, and must NOT annotate
search rows, since that repeats derivable information. That shrinks its remaining value to overview
counts, which grouping by kind already provides.

**Deferred rather than rejected:** if a caller ever needs a grouping that kind cannot express, a
field on the provider contract is the sanctioned shape, and this project's rule against branching on
a language in core says so explicitly. Nothing here closes that door.

# Plan

Ships inside the unpushed `2.0.0`, so wire changes are free for the duration. Markdown is the
reference implementation, built by hand; the remaining formats fan out one Luna each, the shape that
worked for the comment tier.

## Phase 1 - Protocol

Revised by the first audit lap. What changed is recorded under "### What the audit changed" below,
because the reasoning is worth more than the diff.

- `heading` joins `SymbolKindSchema`. This is the whole Question 4 answer: it is what makes a
  document symbol filterable, countable and honest, and `search_symbols` already takes a `kind`.
- **`SYMBOL_KIND` in the LSP adapter becomes `Record<SymbolKind, number>`,** in the same commit.
  Today it is `Record<string, number>` read as `SYMBOL_KIND[declaration.kind] ?? 13`, so a new kind
  compiles clean and silently renders as an LSP Variable. This is the same silent-default class
  fixed in `factById` this release, in a second file, and it must be closed before the kind lands.
- A `docs` fact channel on `FileFacts`. **Facts are per REGION, not per section.** Each carries its
  own text, range, anchoring heading, and a `fenced` flag. A section is normally prose, then a
  fence, then more prose, so one flag per section cannot describe it: true would call the prose
  fenced and false would lose the fence. Per-region also mirrors how comment spans already work.
- The range contract is stated, not assumed: a region's range covers its content and excludes the
  fence delimiter lines, so a range always slices its own text back out. The conformance checker
  already enforces exactly that for comments and gets reused here.
- **`anchorHeading` is nullable, and the reason is named**: prose before the first heading, and a
  document with no headings at all, both anchor to the module. That is the same shape the comment
  tier settled on, where a module-level comment has a null anchor.
- A `docs` tier boolean on `ProviderTiers`, REQUIRED. **This is an ATOMIC edit, not an additive
  one:** `InitializeResponseSchema` validates the tier set, so all eight providers plus the
  reference provider plus 3 test fixtures move in the SAME commit or every provider fails to start.
- A doc fact id kind, and `factById` gains its branch. Verified rather than assumed: planting a fake
  member in `FactKind` fails the type check at that switch today.
- **Duplicate sibling headings need a rule, and the grammar cannot express one.** Only a `method`
  descriptor may carry a disambiguator, so two sibling headings with identical text collide into one
  symbolId. Repeated heading text is normal in documents. Decide here and write it down: an
  occurrence index on the descriptor, or a documented refusal. Do not discover it in Phase 2.
- **`SymbolSummary` gains `containerId`.** A docs search returns a heading PATH, which means walking
  ancestors, and today only `outline` re-adds the container through an intersection type. Without
  this the path cannot be built at all.
- Conformance cases, shared across languages: a heading tree with nesting, prose attribution, a
  fence that must not yield a heading, a fence whose text is searchable and marked, a section mixing
  prose and fence and prose, prose before any heading, and a document with no headings.

### What the audit changed

Seven angles, one Luna each, then every blocker re-checked against the code by hand. Three were
sharpened rather than accepted, and one was corrected.

**The fact shape was wrong.** `fenced` as one boolean per section cannot describe the ordinary case
of prose around a fence. Caught before any code existed, which is the entire point of auditing a
plan rather than a diff.

**The LSP default is a live instance of a class we just closed.** `factById` fell through to the
literals table for any unhandled fact kind; `SYMBOL_KIND` falls through to Variable for any
unhandled symbol kind. The second was found only because the first taught us the shape.

**The binary guard finding was corrected, and it matters.** The audit said the guard must sit in the
shared read path rather than in front of the fallback provider. Half right. Reading the indexer
shows routing already gates it: `indexOne` checks ownership BEFORE calling `readFile`, so today an
unclaimed file is never read. But `readEvent` in the watcher hashes EVERY changed file as UTF-8 with
no routing check whatsoever. So the guard has two homes, not one, and the second is a condition that
exists today rather than one the fallback introduces.

**Phase boundaries are honest but must say so.** After Phase 2 a markdown provider emits doc facts
that Phase 3's store cannot yet hold, so they are dropped. That is deliberate and matches how the
comment train kept its provider phase additive, but a reader of this plan should not have to
reconstruct that. It is now stated at each boundary.

## Phase 2 - The markdown provider

The reference implementation. Built by hand, not fanned out, because everything after it copies it.

**Boundary honesty:** after this phase the provider emits doc facts that the store cannot yet hold,
so core drops them. That is deliberate, and it is the same additive shape the comment train used so
that no commit ships a release with a visibly broken tier. It does mean this phase is not
independently shippable, and the plan says so rather than leaving it to be rediscovered.

**The parser decision is made here, in writing, before code.** `docs/parsing.md` rule 1 says check
for a library first, and the audit was right that "about fifty lines" was an assertion rather than a
decision. Markdown is not a line format. Before writing anything, evaluate a maintained parser that
gives byte offsets for headings and content, and adopt it unless it fails the shipping constraint,
which is node running a committed bundle with no install step and no native bindings. If a library
is rejected, the plan records WHY, and the hand-written version ships an explicit grammar subset
whose unsupported constructs are REPORTED as diagnostics rather than silently misparsed. Eight
hand-written lexers have already cost this project real bugs, and four of them were this exact class.

- Heading detection must survive the whole trap list, not just fences: indented code blocks at four
  spaces, tilde fences, closing fences that must match the opener's character and length, setext
  headings underlined with `=` or `-`, a `#` inside an HTML comment, headings nested in blockquotes
  or list items, and CRLF. Each gets a fixture. The comment train shipped a CRLF defect in C, so
  CRLF is not optional here.
- Headings become declarations with the parent heading as container, giving `outline_module` a table
  of contents for free.
- Prose under each heading becomes doc facts, one per region, fence regions marked.
- **Frontmatter cannot be deferred to Phase 5, and the audit caught the circularity.** The markdown
  provider owns `.md`, and `parseFile` receives a whole module, so the YAML provider never sees it.
  Either the markdown provider carries a minimal frontmatter reader, or v1 declares frontmatter out
  of scope and reports it as unindexed. Decide before writing, do not discover mid-phase.

## Phase 3 - Core

- A `docs` table joining `FACT_TABLES`, with the full replace and forget lifecycle.
- Attachment is trivial by construction: prose belongs to the heading above it. No resolver, no
  forms, no placement. That is the whole reason this is a separate tier from comments. The audit
  probed the edges and they are all the same answer: text before the first heading, a document with
  no headings, and a heading with no prose all resolve to a null anchor or an empty set, never to a
  guess. Prose after a subheading belongs to the subheading, full stop, because position decides.
- **A heading path helper, which is new work the first draft missed.** A docs result renders
  `CLAUDE.md > Principles > No band-aids`, which means walking containers upward. Phase 1 adds
  `containerId` to `SymbolSummary` to make it possible; this is where the walk itself lives, owned
  in one place so the renderer never rebuilds it.
- Search over normalized doc text, following the literals and comments contract: text XOR regex,
  bounded scan declaring `scanIncomplete`, a real `COUNT` so a page cannot disagree with its total.
- Overview counts grouped by kind, so document sections are reported apart from callable symbols
  rather than silently inflating one number.

## Phase 4 - Surface

- `search_docs`: returns a heading PATH plus the prose, which is the answer shape that made this a
  separate tool rather than a reuse of `find_comments`.
- Results say when a match sits inside a fence.
- `describe_symbol` on a heading shows its prose and its children.
- Tool descriptions carry the coverage honesty line, as the comment tier's do.

## Phase 5 - The remaining formats, one Luna each

Fan out per format, each with its own conformance fixtures.

- **JSON family** (`.json`, `.jsonl`, `.ndjson`, `.json5`): a key is a `property` declaration, its
  value a literal. Needs no new machinery, which Question 4 established. JSONL is a sequence of
  independent roots and needs per-record identity. JSON has no comments, so `comments: false` is
  the honest declaration; JSON5 does have them.
- **YAML** (`.yml`, `.yaml`): keys as declarations, values as literals, and REAL comments through
  the existing comment tier. Aliases and multi-document files need fixtures.
- **XML** (`.xml`): elements as declarations, attributes as properties, real comments.
- **HTML** (`.html`): a document, not data. Headings are headings; it is error-tolerant by spec, so
  a malformed file must degrade rather than fail.
- **The binary guard**, which must land BEFORE the fallback, and which has TWO homes rather than
  one. Routing already gates the indexer: `indexOne` checks ownership before calling `readFile`, so
  an unclaimed file is not read today. But `readEvent` in the watcher hashes EVERY changed file as
  UTF-8 with no routing check at all, which is a condition that exists now rather than one the
  fallback creates. One module owns the check, both sites route through it, and a residue test
  fails the build if a third read site appears.
- **The plain-text fallback**, last, claiming extensions nothing else does. Changes what "unclaimed"
  means in every coverage report, so the overview wording moves with it.

Use a library per `docs/parsing.md` rule 1 rather than hand-writing. Eight hand-written lexers have
already cost this project real bugs, and the fenced-string class was one of them. Weigh each
dependency against shipped artifact size, currently 9.9 MB.

## Phase 6 - Verification

- Gate, then conformance across every provider, not only the new ones. A corpus case is shared.
- The blind corpus is the real test: index a documentation set nobody here has read and ask it
  questions. `search_docs` for `band-aid` against this repo must return
  `CLAUDE.md > Principles`, which is the founding use case and currently returns nothing.
- Drive the built server, since a green gate is not evidence.

## Phase 7 - Release

Folds into the `2.0.0` train. The CHANGELOG gains the docs tier, the new `heading` kind, and the
fallback's effect on what "unclaimed" reports.

## Deferred, recorded so they are not re-litigated

- **Markdown links as reference edges.** A link to `#releasing` that RESOLVES is a real edge and
  falls out of headings being declarations. Deferred, not rejected.
- **The resolve-only doc-to-code bridge.** Descoped with the hedged hint in Question 2b.
- **A provider family field.** Rejected in Question 4, with the door left open.
