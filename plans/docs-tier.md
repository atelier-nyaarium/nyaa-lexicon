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
reference implementation; the remaining formats fan out one Luna each, the shape that worked for the
comment tier.

## Phase 0 - Choose every parser, once

Added by the second audit lap, because the first left two decisions deferred inside later phases and
a deferred decision is one that gets made hastily mid-implementation.

Parser choice is CROSS-CUTTING, not per-phase. Markdown needs a YAML reader for frontmatter, and
Phase 5 needs one for `.yml`. Deciding those separately is how a codebase ends up with two YAML
readers that disagree, which is the single-owner defect this project hunts. So every format's parser
is chosen here, before any provider is written.

**The shipping constraint decides more than preference.** Providers are BUNDLED: `providerBundles`
inlines everything so a host needs no `node_modules`. That means a dependency must be pure
JavaScript with no native bindings, and its weight is permanent for every consumer. Precedent exists
for paying real weight when it is right: the TypeScript provider bundle is 4 MB because it inlines
the compiler.

**Markdown gets a CommonMark-compliant library, not a hand-written scanner.** The whole Phase 2 trap
list (setext headings, tilde fences, fence length and character matching, indented code blocks, `#`
inside HTML comments, headings nested in blockquotes and lists) is precisely what CommonMark
compliance already solves. Hand-writing it means re-deriving CommonMark badly, and `docs/parsing.md`
rule 1 says check for a library first. The requirement is source POSITIONS on every node, since a
declaration needs a range and a doc region needs its own. Evaluate the pure-JS options that expose
them and pin one.

That reverses the first draft's "about fifty lines", which was an assertion rather than a decision.
`toolsTreeMd` is fifty lines and has a real bug for exactly this reason.

- Record for each format: the library, why it was chosen, its weight, and what it does NOT cover.
- Anything with native bindings is disqualified by the bundle, not by taste.
- `/update-packages` governs the installs: the maturity rule applies and versions are pinned.
- If a format ends up hand-written after all, the plan records WHY, and that parser ships an explicit
  grammar subset whose unsupported constructs are REPORTED as diagnostics rather than misparsed.

**Frontmatter is settled here too.** The markdown provider owns `.md` and `parseFile` receives whole
modules, so the YAML provider never sees frontmatter and it cannot be deferred. With the YAML
library already chosen in this phase, the markdown provider uses that same one.

**My stated reason for sharing it was wrong, and the second lap caught it.** I argued single
ownership as though sharing saved bytes. It does not: `providerBundles` bundles each provider
SEPARATELY, so a library imported by two providers is inlined twice on disk. The real invariant is
one semantic INTERPRETATION of YAML, not one copy of it, and that is still worth having, because two
readers disagreeing about what a YAML scalar means is exactly the drift the rule exists to stop.

**Paper evaluation is not enough, and this phase must produce spikes.** Confirming that a parser
reports usable source positions for headings, fences, frontmatter delimiters and multi-document
YAML cannot be done from a README. Each candidate gets a small spike with acceptance criteria, and
the fixtures that would invalidate a choice live HERE, not in Phase 2 and Phase 5 where they arrive
too late to change the decision.

**The bundle will not catch a bad dependency.** `scripts/build.ts` runs `bun build --target node`
with no external list, no dependency-graph scan and no native-file inspection, and its only gate is
a nonzero exit. A package with a native addon can bundle and then fail at provider startup, which
`core/src/providers.ts` records and skips, leaving documentation indexing silently at zero coverage.
A provider startup smoke check belongs in this phase.

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

The parser and the frontmatter reader are both chosen in Phase 0, so this phase writes an adapter
over a CommonMark parser rather than a scanner.

- The trap list is the CONFORMANCE list, not an implementation checklist: indented code blocks at
  four spaces, tilde fences, closing fences matching the opener's character and length, setext
  headings underlined with `=` or `-`, a `#` inside an HTML comment, headings nested in blockquotes
  or list items, and CRLF. A compliant parser handles all of them; the fixtures exist to prove it
  does, and to fail loudly if the parser is ever swapped. The comment train shipped a CRLF defect in
  C, so CRLF is not optional here.
- Headings become declarations with the parent heading as container, giving `outline_module` a table
  of contents for free.
- Prose under each heading becomes doc facts, one per region, fence regions marked.
- Frontmatter emits `property` declarations through the YAML reader chosen in Phase 0. This is the
  mixed-content case that killed the family field, so it gets a fixture on day one.

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

**The second audit lap found that "needs no new machinery" was wrong, and four protocol gaps sit
under this phase.** Every one was verified against the code, not taken on assertion. None of them
is unsolvable; all of them are unsolved, and they are protocol-level, which means they cost a major
if discovered after this train ships.

1. **Routing cannot express the fallback at all.** `ProviderClaims` in `core/src/routing.ts` carries
   only `extensions` and an optional `filenames`. There is no catch-all, no negative list, and no
   precedence. "Claims extensions nothing else does" is not expressible: routing can only report a
   file as unclaimed, never hand it to a last-resort owner. This needs a NEW routing primitive with
   explicit precedence, and it is the single largest unlisted item in the plan.
2. **An array element cannot be a declaration.** `DeclarationSchema.name` is `z.string().min(1)`,
   required and nonempty. JSON and YAML array elements have no name. Choose and write it down:
   omit elements, mint synthetic `[0]` names that churn whenever anything is inserted, or extend
   the schema. All three have costs; none is free.
3. **YAML scalars exceed `LiteralSchema`,** which is exactly `string | number | boolean`. YAML also
   has null, timestamps, binary and tagged values. Say which are omitted, which are normalized, and
   which produce a diagnostic, rather than discovering it in the fixture.
4. **XML and HTML have no identity story.** `SymbolKindSchema` has no `element` or `attribute`
   member, and repeated sibling elements collide for the same reason duplicate headings do: only a
   `method` descriptor may carry a disambiguator. "Elements as declarations" and "headings are
   headings" are both placeholders, not designs. HTML additionally needs a rule for anonymous
   elements, attributes, text nodes, script and style content, and malformed recovery.

- **JSON family** (`.json`, `.jsonl`, `.ndjson`, `.json5`): a key is a `property` declaration, its
  value a literal. JSONL is a sequence of independent roots and needs per-record identity. JSON has
  no comments, so `comments: false` is the honest declaration; JSON5 does have them. Blocked on
  gap 2 above.
- **YAML** (`.yml`, `.yaml`): keys as declarations, values as literals, and REAL comments through
  the existing comment tier. Aliases, anchors and multi-document files need fixtures. Blocked on
  gaps 2 and 3.
- **XML** (`.xml`): blocked on gap 4 until the identity story exists.
- **HTML** (`.html`): a document, not data. Blocked on gap 4.
- **The binary guard**, which must land BEFORE the fallback, and which has TWO homes rather than
  one. Routing already gates the indexer: `indexOne` checks ownership before calling `readFile`, so
  an unclaimed file is not read today. But `readEvent` in the watcher hashes EVERY changed file as
  UTF-8 with no routing check at all, which is a condition that exists now rather than one the
  fallback creates. One module owns the check, both sites route through it, and a residue test
  fails the build if a third read site appears.
- **The plain-text fallback**, last, claiming extensions nothing else does. Changes what "unclaimed"
  means in every coverage report, so the overview wording moves with it.

Every parser here was already chosen in Phase 0, so each slice is an adapter over a decided library
rather than a fresh judgement call. The YAML reader is the same one the markdown provider uses for
frontmatter: one owner, no second opinion.

## Phase 6 - Verification

- Gate, then conformance across every provider, not only the new ones. A corpus case is shared.
- The blind corpus is the real test: index a documentation set nobody here has read and ask it
  questions.
- **The acceptance test, stated precisely enough to be falsifiable.** `search_docs` for the text
  `band-aid` against this repo returns exactly one hit whose heading path is `CLAUDE.md > Principles`
  and whose prose contains `No band-aids`. The path stops at `Principles` because `No band-aids` is
  a BOLDED LIST ITEM, not a heading; the only headings in that file are `##` level. An audit lap
  asserted a `> No band-aids` segment and was wrong, which is precisely why the expectation is
  written out rather than described. Matching is substring over normalized text, the same contract
  the comment tier uses, so the hyphen and the plural both have to behave.
- Drive the built server, since a green gate is not evidence.

## Phase 7 - Release

Folds into the `2.0.0` train. The CHANGELOG gains the docs tier, the new `heading` kind, and the
fallback's effect on what "unclaimed" reports.

## Question 5 - What ships inside 2.0.0, now that Phase 5 is known to be blocked?

Q: The whole set was chosen before the audit found four protocol gaps. Does it still hold?
A: pending.

The gaps are not evenly spread, which is what makes a middle option real rather than a compromise:

| Format | Blocked on | Weight of the decision |
| --- | --- | --- |
| JSON, JSONL, NDJSON, JSON5 | array elements have no name | ONE closed decision |
| YAML | array elements, plus scalar kinds beyond string/number/boolean | TWO closed decisions |
| XML | no symbol kind, no identity for repeated siblings | real design |
| HTML | the same, plus a whole element-selection policy | real design |
| plain-text fallback | routing cannot express a catch-all at all | a new routing primitive |

JSON and YAML are the two that reuse machinery which already exists: a key is a `property` or
`field`, its value is a literal. XML, HTML and the fallback each need something invented.

### The open scope question, raised by the second audit lap

**Two angles independently concluded this plan is three trains in one coat,** and recommended
splitting after Phase 4. That is a scope decision belonging to the owner, who already chose the
whole set once. It is raised again ONLY because the audit produced evidence that did not exist when
that choice was made, not to relitigate it.

**What is new since the whole-set decision:** four protocol-level gaps under Phase 5, all verified
against code. Routing cannot express a fallback at all. An array element cannot be a declaration.
YAML scalars exceed the literal kinds. XML and HTML have no identity story and no symbol kind. Each
needs a design, and all four are protocol shaped, which means getting them wrong costs a major.

**What a split would look like:**

- `2.0.0` ships Phases 0 through 4 plus verification: the heading kind, regional doc facts, the
  markdown provider, `search_docs`, heading paths. That delivers the founding use case, which is
  that searching this repo for `band-aid` currently returns nothing.
- A later major ships the JSON dialects, YAML, XML, HTML, the routing primitive, the binary guard
  and the fallback, with their four design questions answered rather than rushed.

**What the split costs:** users rebuild their index twice, because the second train bumps
`SCHEMA_VERSION` again. That is the same cost the owner already weighed when choosing to fold docs
into `2.0.0` rather than shipping a `3.0.0`, and the answer may well be the same.

**What NOT splitting costs:** four unsolved protocol designs land in the same release as a new tier,
a new symbol kind, a new fact class, a new store table and a routing primitive that does not yet
exist. The comment tier was ONE fact class over six phases and found nine defects.

**Was the original agreement yes-manning?** Partly. The concern was raised once, the owner decided,
and proceeding was correct. What was NOT done is checking whether Phase 5 was buildable before
writing it down as four bullet points, and it was not: three of those four bullets are blocked on
protocol gaps. Agreeing to a scope is fine; describing unsolved work as though it were understood is
not, and that part is on me.

## Deferred, recorded so they are not re-litigated

- **Markdown links as reference edges.** A link to `#releasing` that RESOLVES is a real edge and
  falls out of headings being declarations. Deferred, not rejected.
- **The resolve-only doc-to-code bridge.** Descoped with the hedged hint in Question 2b.
- **A provider family field.** Rejected in Question 4, with the door left open.
