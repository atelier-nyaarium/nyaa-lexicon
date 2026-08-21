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

## Phase 0 - Choose every parser, once ✅

Added by the second audit lap, because the first left two decisions deferred inside later phases and
a deferred decision is one that gets made hastily mid-implementation.

Parser choice is CROSS-CUTTING, not per-phase. Markdown needs a YAML reader for frontmatter, and
Phase 5 needs one for `.yml`. Deciding those separately is how a codebase ends up with two YAML
readers that disagree, which is the single-owner defect this project hunts. So every format's parser
is chosen here, before any provider is written.

Three parsers, after Question 5 scoped the train: **markdown**, the **JSON family** including JSON5,
and **YAML**. XML and HTML are deferred, so their parsers are not chosen here and should not be
speculatively picked; the next train chooses them against whatever the ecosystem looks like then.

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

### Phase 0 results

The owner added a bar while this ran: a library must be widely used, not something with ten stars,
and anything that fails the popularity bar OR the feature test defers to a hand-written parser in
house style rather than being adopted anyway.

Weekly downloads, checked rather than assumed: `yaml` 162M, `jsonc-parser` 51M, `mdast-util-from-markdown`
45M, `markdown-it` 24M. All clear the bar comfortably. Publish dates are Feb 2026, Jun 2024 and Feb
2026, so the seven-day maturity rule is satisfied with room. `bun audit` on the resolved lockfile
reported no vulnerabilities before anything was installed, and `bunfig.toml` now sets
`minimumReleaseAge = 604800` so the rule is enforced by the tool rather than by memory.

Weights, minified, as a provider actually bundles them: markdown **120 KB** including the frontmatter
extensions, YAML **116 KB**, JSON **8 KB**. Against a committed `dist/` of 9.9 MB that is
inconsequential, and the first measurement understated markdown by excluding the extensions it turns
out to need.

**Markdown: `mdast-util-from-markdown` 2.0.3, plus `micromark-extension-frontmatter` 2.0.0 and
`mdast-util-frontmatter` 2.0.1.** Spiked against the entire trap list and it passes every case: a
`##` inside a backtick fence is not a heading, nor inside a tilde fence, nor in an indented code
block, nor inside an HTML comment. Setext headings ARE recognised. Every heading's range slices its
own text back out.

That is the whole Phase 2 trap list closed by a dependency, and it is the strongest argument against
the fifty-line scanner the first draft proposed.

**The frontmatter extensions are not optional, and the spike is why we know.** Without them, mdast
does not merely ignore frontmatter: it MISPARSES it into a phantom heading, because `---` under text
is a setext underline. A document with frontmatter would have grown a heading containing its own
metadata. With them, frontmatter is its own node with a range, no phantom heading appears, and its
text feeds the same `yaml` reader that Phase 5 uses, which is the single-interpretation invariant
demonstrated rather than asserted.

**One Phase 0 claim was overstated and the alignment audit caught it.** I wrote that the `fenced`
flag "falls out of the parse". It does not, quite. An mdast `code` node does not say whether it was
fenced or indented, since both are `type: "code"` and `lang` is null for an indented block and for a
fence with no info string. Distinguishing them is a one-character look at the node's first byte,
which is trivial but IS detection.

**And a real Phase 2 decision hides under it:** a `code` node's `position` spans the fence INCLUDING
its delimiter lines, while its `value` is the content WITHOUT them. The plan requires a region's
range to slice its own text back out, and those two do not agree. Phase 2 must choose: narrow the
range to the content, or accept delimiters inside the searchable text. Better found now than in a
fixture.

**One policy question the spike surfaced:** a heading inside a blockquote IS reported as a heading.
Quoted material is not the document's own structure, so Phase 2 decides whether to keep or drop it.
Cheap to decide, invisible until someone quotes a document.

**YAML: `yaml` 2.9.0, zero dependencies.** Keys carry ranges that slice back, multi-document files
parse, and the JS values come through typed.

**Gap 3 is narrower than the audit feared.** The audit warned about null, timestamps, binary and
tags overflowing `LiteralSchema`. Spiked: a timestamp arrives as a plain STRING, because YAML 1.2
does not auto-resolve timestamps, so only `null` genuinely has nowhere to go. That is one small
decision rather than four.

**Two real gaps the spike found instead:** anchors, aliases and collections report no scalar value,
so they need their own handling; and `commentBefore` was empty where expected, so YAML comment
extraction needs its access path worked out in Phase 5 rather than assumed.

**JSON: `jsonc-parser` 3.3.1, zero dependencies.** Keys carry offsets, nesting works, and it refuses
a trailing comma and an unquoted key.

**But it is a JSONC parser, and it accepted `// a comment` with zero errors.** For `.json` that is
too lenient: we would silently report facts for a file no strict JSON reader would accept. Phase 5
either configures it strictly or declares that this provider reads JSONC semantics and says so.
Found by spiking rather than by reading the README, which is why the plan demanded spikes.

**Gap 2 confirmed directly:** the spike reports "array with 2 unnamed elements". Array elements have
no name, and a declaration requires one.

**The provider startup smoke check is built, and it found a bug in itself.** `scripts/build.ts` now
starts every bundled provider after bundling and fails the build if one cannot start. The first
version used `process.execPath`, which under `bun run` is BUN, so it was verifying the wrong runtime
entirely: node is what consumers run and node is what it must test. Proven failable in both
directions by planting a top-level throw in a provider's source, watching the build fail with
`Error: planted startup failure`, then restoring and watching all eight report clean.

It also needed its error message capped. A minified bundle's stack frame echoes a source line
thousands of columns wide, so the check reports node's own message line rather than the bundle.

**Known and accepted, carried into later phases:**

- The parsers are root `devDependencies` today because no provider package exists to own them yet.
  Phase 2 and Phase 5 move each to its provider's own manifest, where a runtime dependency belongs.
- `jsonc-parser` exposes `disallowComments`, so strict `.json` IS configurable, but the spike did
  not exercise it. Phase 5 proves it rather than trusting the type signature.
- The spikes live in gitignored `temp/spikes` and print observations rather than assert. They served
  their purpose, which was to invalidate choices before code depended on them; the durable versions
  are the conformance fixtures in Phases 2 and 5.
- The dependency footprint grew from 5 root packages to 9, and the lockfile from 187 to 233. That is
  a real change in this project's character and is stated here rather than buried in a lockfile.
  Most of the markdown tree has ONE maintaining ecosystem behind it, which is concentration worth
  knowing about even though pinning, the age gate and a committed bundle all blunt it.
- `minimumReleaseAge` gates FUTURE resolution. It does not re-validate what the lockfile already
  holds, so "enforced by the tool rather than by memory" is true of the next install and not of this
  one. This one was checked by hand.
- The smoke check's reach is startup, deliberately. A provider that imports cleanly and then fails
  on its first `parseFile` passes it, because that is what conformance asks and conformance already
  runs all eight. Two other limits worth naming: it spawns a bare `node` from PATH without asserting
  the version matches the `engines` floor, and it treats any stderr output as failure, which would
  turn a future dependency's deprecation warning into a broken build.
- Rebuilding after the dependency change churns the three core bundles by about 146 bytes each, but
  the diff is a minifier identifier rename (`$0` became `$U`) from a shifted module graph, not a
  behaviour change. Reverted rather than committed, since Phase 0 changed no shipped behaviour.

**JSON5: DEFERRED, and it fails on features rather than popularity.** `json5` has 192M weekly
downloads, so the bar is not the problem: its `parse` mirrors `JSON.parse` and yields NO position
data at all, and a declaration without a range is not a declaration. Per the owner's rule, that
means either a hand-written parser in house style or dropping the extension. Recommend dropping
`.json5` from this train and recording why, since a hand-written JSON5 parser buys one extension at
the cost of the exact defect class this project just spent a release closing.

## Phase 1 - Protocol ✅

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
- **`anchorId` is the heading's SYMBOL ID and is absent for module-level prose.** A name would not
  do: two headings share one, which is the whole reason the disambiguator exists. Absent covers
  prose before the first heading and a file with none, the same shape a module-level comment has.
  It is optional rather than explicitly null, matching how every other absence here is spelled.
- A `docs` tier boolean on `ProviderTiers`, REQUIRED. **This is an ATOMIC edit, not an additive
  one:** `InitializeResponseSchema` validates the tier set, so all eight providers plus the
  reference provider plus 3 test fixtures move in the SAME commit or every provider fails to start.
  The count was right and the SCOPE was not: `dist/` moves with them. Provider discovery spawns the
  BUNDLE, so the committed bundle failed validation until it was rebuilt, and the live-provider test
  reported it as a symbol that simply was not there. The real rule is that a required tier is atomic
  across source, fixtures and the shipped artifact together.
- A doc fact id kind, and `factById` gains its branch. Verified rather than assumed: planting a fake
  member in `FactKind` fails the type check at that switch today.
- Conformance cases pin the contract before any provider exists, and two tests guard against them
  quietly becoming unrunnable if their fixtures are ever dropped.
- **Duplicate sibling headings: SETTLED, and the tradeoff is recorded rather than hidden.** The
  grammar now lets `namespace`, `type` and `meta` carry a disambiguator, so the second `## Notes`
  under one parent is `Parent/Notes(2)/`. `term` is excluded because its `.` suffix IS the method
  form, and empty parens stay method-only so one symbol keeps exactly one spelling.
- **`SymbolSummary` gains `containerId`.** A docs search returns a heading PATH, which means walking
  ancestors, and today only `outline` re-adds the container through an intersection type. Without
  this the path cannot be built at all.
- Four conformance cases: a heading tree with nesting, prose attribution including prose before any
  heading, a fence that yields no heading and is marked fenced within a section that mixes prose and
  fence and prose, and a document with no headings. **Searchability is NOT among them,** because
  search arrives in Phase 4 and conformance asks a provider what it extracted, never what a tool can
  find. The first draft listed it here, which was a claim this phase cannot make.

### What the Phase 1 audit changed, and what it did not

**A blocker found and fixed during the run: the anchor was a NAME.** `DocRegion` carried
`anchorHeading` as a heading's name, which two headings share, so prose under either was
indistinguishable and the whole disambiguator argument stopped at the heading. It is now `anchorId`,
a symbolId, matching how a stored comment carries `anchorId` rather than a name. The conformance
checker resolves that id back to a name through the declarations, exactly as the container check
already does, because a case must never know an id. A test now pins two same-named headings apart.

**A guard added: the docs cases could have run nowhere forever.** No provider claims the tier yet,
so all four skip. That is correct today and would be a silent lie if the fixtures were ever deleted,
which is the painpoint this repo already recorded for corpus tests. Two tests now assert that every
tier has cases and that the docs cases keep a language that could run them, proven failable by
retargeting a fixture and watching it go red.

**The red team tightened the contract twice more, before any provider could build against a loose
one:**

- **Regions must PARTITION the document.** Two regions could overlap or nest and both pass, since
  each sliced its own text correctly. A store indexing those would hold the same bytes as two facts,
  so one search returns the same prose twice. They must now be disjoint and ascending, which also
  turns a reordered set into one clear failure instead of two confusing content mismatches.
- **An anchor must resolve, to a heading, in this file.** `anchorId` was an arbitrary string, and an
  anchor naming nothing was silently read as module-level prose, which is a different claim from the
  one the provider made. Anchoring to a function now fails too.

Both proven failable by neutering each guard and watching its tests go red.

**Deliberately not changed, with reasons:**

- **`docFactId` excludes the anchor,** matching `commentFactId` and its stated reason that a
  re-attached comment is not new prose. The counter-argument is real: retitle a heading and the
  prose under it keeps its id while its section changed. Consistency with comments wins, because one
  rule for "what makes a prose fact" beats two, and the prose itself genuinely did not change.
- **No fence INFO STRING.** `fenced` is a boolean, so a result can say "in a code block" but not "in
  a bash block". A real gap, deferred rather than hidden, and it costs a schema field to add later.
- **The range contract is pinned by fixture, not by the checker.** `checkDocRanges` proves a range
  slices its own text back; nothing independently proves the delimiters were excluded. A provider
  including delimiters in BOTH range and text would pass. The conformance fixtures are what state
  the intent.
- **`anchorId` is optional rather than nullable.** The plan said nullable; the schema omits instead,
  which is how every other absence in this contract is spelled. The plan's wording is the thing that
  was imprecise.
- **The runner's `factExpectations` list is still hand-enumerated,** so a new expectation kind still
  costs an edit there. That is the comment train's recorded painpoint recurring, and it recurred
  exactly as predicted: `docs` had to be added by hand or the four cases would have run while
  asserting nothing.
- **A provider can claim a tier and deliver nothing.** Declaring `docs: true` while emitting no
  regions validates cleanly, because the fact field is optional and its absence means the tier is
  false. Real, and NOT introduced here: every tier works this way, so `comments: true` with no
  comments has always been expressible. Fixing it for one tier alone would be the inconsistency.
  Belongs on the board as a cross-tier question about what a tier claim is worth.
- **A non-canonical percent-encoding in a module path parses.** `parseSymbolId` canonicalises the
  decoded value but does not require the encoded field to match what the composer would emit, so two
  spellings reach one symbol. Pre-existing, unrelated to this train, worth its own look.

### Bug Classes

**A hand-maintained map keyed by a growing enum, with a default. Three instances, three mechanisms,
one release.**

1. `IndexStore.factById` fell through to the literals table for any unhandled fact kind, so a comment
   id queried the wrong table and its refusal named the wrong cause. Patched by an exhaustive switch.
2. `renderFacts` in the MCP renderer iterated a hand-written list of fact kinds, so comment facts had
   ids that no surface ever printed. Patched by keying the headings record on `FactKind`.
3. `SYMBOL_KIND` in the LSP adapter read `SYMBOL_KIND[kind] ?? 13`, so a new symbol kind rendered
   silently as a Variable. Patched by keying the record on `SymbolKind`.

Each patch is the same shape: replace the default with exhaustiveness so the compiler refuses. That
worked, and adding the `doc` fact kind proved it by breaking the build in two of the three at once.

**A generic residue test was assessed and REJECTED, with numbers.** Forbidding `Record<string,` in
files touching a protocol enum flags 38 occurrences in source against 3 real instances. Forbidding
an indexed map followed by `??` flags 46. A rule with a 90 percent false positive rate is deleted by
the next person who trips over it, and the type system is already the stronger guard at all three
sites: adding the `doc` fact kind broke the build at two of them. So the class is closed by
exhaustive typing, not by a grep, and the residual exposure is a FUTURE map nobody types that way.

**The fourth instance was different, and it was the one worth building.** The runner's
`factExpectations` was a hand-written array that had to grow whenever the case schema gained an
expectation. Omitting an entry did not fail the build; it made those cases run while asserting
nothing, which has happened here to six cases at once. Its comment even claimed to be "DERIVED,
never hand-listed", which was false, so a reader would have believed the class was already shut.

Two changes closed both directions of it:

- **The parse predicate is now derived by EXCLUSION.** A case parses when it states anything that is
  not metadata, so an unclassified field costs one extra parse instead of skipping every assertion.
  The failure direction is now wasteful rather than silent.
- **A test asserts every expectation the schema accepts is actually READ.** That was the other end,
  and the inversion alone did not cover it: a field the schema accepts and no checker looks at still
  passes while asserting nothing. The table must cover the schema exactly, so a new field fails here
  until someone decides who reads it. Proven by planting a field and watching it go red, and it
  immediately corrected a wrong assumption of mine by showing `typeOf` is answered by its own
  provider call rather than by `checkFacts`.

### The known weakness in section identity, argued and accepted

A Codex review roasted the disambiguator decision, its central claim checked out, and the decision
stands anyway. Both halves are recorded because a tradeoff nobody wrote down gets rediscovered as a
bug.

**The flaw is real and worse than first framed.** A method's disambiguator is arity, which moves
only when the signature moves. A section's is occurrence ORDER, which moves when anything is
inserted above it. And `migrateKnowledge` is called from exactly two places, the refactor rename and
move paths, so an ordinary edit does not migrate: reorder a document and an answer recorded about a
shifted section does not go stale, it goes MISSING, keyed to an id the index no longer emits.

**The proposed alternative was refused for a measurable reason.** It was to require author-written
anchors like `{#notes-install}` and refuse to index duplicates without them. No existing `CLAUDE.md`,
README or `docs/` folder carries anchors, so for a tool whose purpose is indexing documentation that
ALREADY EXISTS that makes real sections invisible in every repository, today, with no retroactive
fix available to an author. It trades a rare fragility for a universal blind spot.

**And the blast radius is narrow.** A disambiguator appears only on duplicate SIBLINGS, so nearly
every heading has a fully stable id with no occurrence in it. Damage needs three things at once: a
duplicate-named section, knowledge recorded about that exact section, and a later reorder among
those specific duplicates.

**The principle applied:** a fragile id beats no id. With one, a section is searchable, outlineable,
readable and citable. Without one, it does not exist.

**Accepted debt, in writing:** one field now carries two meanings of differing durability. That is a
smell, named in `Descriptor.disambiguator` rather than glossed. That the `term` exclusion was found
by a failing test rather than by design is evidence the suffix space was built for method overloads,
not for a general descriptor-plus-disambiguator idea.

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

## Phase 2 - The markdown provider ✅

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
- **Frontmatter is handled for EVERY markdown extension, never just `.mdc`.** Plain `.md` carries it
  constantly, and treating it as an `.mdc` quirk would mean the phantom-heading misparse survives in
  the common case. The extension is enabled for the provider, not per file type.
- **A duplicate sibling heading emits a DIAGNOSTIC when it is disambiguated.** Its id then carries an
  occurrence, which moves if anything is inserted above it, and a reader deserves to see that where
  it happens rather than discovering it when recorded knowledge stops resolving. Naming it at the
  point of duplication is what keeps the accepted debt honest rather than hidden.

### Phase 2 results

The whole trap list passes, and every case in it is a conformance fixture rather than a claim: setext
headings, tilde fences, a longer fence holding a shorter one, indented code, a hash inside an HTML
comment, quoted and listed headings, CRLF, frontmatter, repeated siblings, and a byte order mark.
The corpus grew from 33 cases to 44: ten on the `docs` tier and one on `comments` that every code
provider runs. Markdown also gained a fixture on the existing parse-error case. All green from the
shipped bundle, alongside all eight existing providers at zero failures.

**Proved end to end rather than by gate.** The built artifact indexes this repository, claims
`.md .mdc .markdown`, drops the unclaimed count to one file, and answers `Principles` as a `heading`
in `CLAUDE.md`. `Development` reports one member, which is `Releasing`, so heading nesting survives
into core exactly as the table-of-contents promise said it would.

**Two decisions Phase 0 left for this phase, both settled.**

- **A fence's range narrows to its CONTENT.** Phase 1 pinned the schema wording, so the delimiters
  are excluded from both range and text. mdast could not supply this: a code node's `position` spans
  the delimiters while its `value` omits them, and neither is what a region needs.
- **A heading inside a blockquote or a list item stays PROSE.** Quoted material is not the document's
  own structure, and the same argument that makes a fence content makes a quoted section content. A
  document quoting another document's outline would otherwise grow sections it does not have.

**Decisions this phase had to make on its own:**

- **Line arithmetic, never mdast's line and column.** A range is built from node OFFSETS through
  `coordinatesOf`, which is the only thing counting UTF-16 code units. The residue test proved this
  matters: it caught a hand-written `value.split("\n").length` and the fix routes the value's line
  count through the owner too, so one definition of a line now serves the file and the fence content
  alike.
- **A heading's range covers its whole SECTION,** ending at the next heading of the same or a
  shallower level. That is what makes `symbol_source` on a heading return the section, which
  Question 1b promised and nothing else would deliver.
- **A heading's name is its RENDERED text and its selection range is the SOURCE span.** They differ
  whenever a heading carries inline markup, and both answers are the right one for their job: a
  search matches `parseFile` inside `` The `parseFile` call ``, while an editor highlights the
  backticks with it.
- **An indented code block is a region with `fenced: false`.** It is code and it is not fenced, and
  the field is named for what it says. A reader wanting "this match is in a code block" is served
  for fences only, which is a real gap recorded below rather than papered over by widening the flag.
- **A heading with no text reports a DIAGNOSTIC and no declaration.** A declaration requires a name
  and there is none, so prose after it anchors to nothing rather than to the section above, which
  would be the stronger lie.
- **Frontmatter keys are `term` descriptors, chained through nested maps.** A heading is a
  `namespace` and a key is a `term`, so a section and a key of the same name never collide.
  Sequence entries are omitted, which is exactly the Phase 5 question arriving early and being
  deferred rather than guessed.

**Two checker gaps this phase found and closed.**

`describeIdParts` dropped the disambiguator, so two same-named headings read identically to a case
and the grammar extension Phase 1 built was unassertable in conformance. It now appends `(n)`,
proven failable by neutering the numbering and watching the case go red.

**And a case could not state a NEGATIVE.** `checkFacts` treats extra declarations as fine, so every
"this yields no heading" case was asserting only that the ONE real heading was present. A phantom
heading passed. `declarationNames` states the exact list in order, matching the exactness `comments`
and `docs` already have, and the Phase 1 coverage guard fired the moment the field was added and
before a checker read it. Proven failable by removing the frontmatter extension: the case now names
the phantom, reporting a heading called `title: Rules meta: owner: nyaa` rather than only that the
keys went missing.

**`syntaxDiagnostics` was declared false and the tier-honesty angle was right to refuse it.** A
document's prose cannot fail to parse, but its frontmatter can, and the provider already reported
that as an error diagnostic. Declaring the tier true is the accurate claim, since for any input this
provider reports a syntax error when the input has one. The shared parse-error case now carries a
markdown fixture, so the claim is checked rather than stated.

**The boundary is wider than the plan said, and the alignment audit found the extra half.** The
plan promised only that core would drop doc facts, which is true and verified: `indexer` passes
declarations, references, imports, literals and comments to `replaceFile`, and there is no docs
table for them to land in. What the plan did not say is that claiming markdown ALSO changes a number
already on screen. Overview reports one aggregate `Symbols` count over every row in the symbols
table, so headings and frontmatter keys now sit inside it with nothing saying so. That is the
reporting drift Phase 7 warns about, arriving five phases early because the provider ships first.
Phase 3's kind-grouped counts close it, and until they land the number means more than it says.

### What the red team broke

Seven angles, roughly 44,000 inputs actually EXECUTED rather than reasoned about. Three defects
reproduced by hand before anything was changed, and all three are now regression tests proven
failable by planting.

**A byte order mark corrupted every range in the file.** mdast strips a leading BOM before parsing,
so its offsets came back one code unit short and a range addressed the character before the one it
meant: a heading's selection sliced a space instead of its name, and with CRLF a region reported
`"\nab"` where the file said `abc`, with a range that would not slice at all. This is the worst class
of defect this project has, since it is silently wrong rather than absent, and BOM-prefixed markdown
is ordinary on Windows. The BOM is now stripped explicitly and every mdast offset is shifted by its
width, so the shift is a known quantity rather than a parser detail we depend on.

**A YAML key with no name was declared as `null`.** `: 1` and an explicit `?` key both produce a
zero-width key, and `String(null)` invented the name `null` for something the document never named.
A zero-width key is now skipped. A document that literally writes `null:` still reports it, because
the guard is the width rather than the value.

**My own checker change had a false-pass.** `declarationNames` compared two lists by joining them
with NUL, which a declaration name can itself contain, so `["a\0b"]` and `["a", "b"]` matched. It
compares element-wise now: there is no separator a name cannot hold.

**And a measured quadratic in the shared coordinate owner, which is the one that outlives this
phase.** `positionAt` walked the line index backward from the end, on the stated premise that a
caller converts positions near the edit it just found. That is true of an edit and false of a PARSE,
which converts one position per declaration across the whole file. Measured: a 32000-heading document
spent 2.6 seconds inside `positionAt` against 1.2ms to BUILD the index it was searching, quadrupling
on every doubling. A binary search replaces it, the document parses in half the time, and what
remains is mdast's own cost rather than ours. Every provider was paying this, so the fix is not
markdown's.

### Bug Classes

**The text a parser SAW is not the text the coordinates index.** One mechanism, the seam between a
parser's offsets and `coordinatesOf`, and this phase touched it three times: a hand-written line
count that the residue test caught, a fence range that could not come from mdast's own span, and the
BOM shift that corrupted every range in a file. The third is the dangerous shape, because a
desynchronized offset reads as CONTENT rather than as an error: the region said `"\nab"` and meant
`abc`, and nothing anywhere could tell.

Any parser that normalizes its input desynchronizes the same way, and stripping a BOM is only the
commonest reason. Line-ending normalization and indentation stripping are the others.

**Closed by fixture rather than by care.** Two conformance cases now carry a BOM: one on `comments`
for the eight code providers, one on `docs` for markdown. The suite already checks EVERY reported
span's range against the source, so a provider parsing stripped text while the core indexes the file
fails there rather than in someone's search result. All nine pass today, and the markdown case was
proven failable by removing the shift: it reports `expected "body", got "\nbod"`, which names the
corruption in one line.

That is the guard a ninth language inherits for free, and it is the reason this class is recorded
as closed rather than as fixed.

**What survived.** Fence pathology found nothing across 5,418 inputs: unclosed fences, indented
fences, mismatched delimiter lengths, fences in lists and blockquotes, CRLF, first-byte fences.
Scale found nothing: 50,000 headings, a 10MB file, a 5MB paragraph, 5,000 levels of nesting, no stack
overflow. The disjointness and slice-back invariants held on every input that was not BOM-prefixed.

**Known and accepted, carried forward:**

- **A declaration's `name` can differ from the last descriptor of its own `symbolId`.** `quoteName`
  normalizes to NFC, deliberately, so a heading written in NFD keeps a decomposed name beside a
  composed id. That is true of all nine providers rather than of markdown, since the normalization
  lives in the shared grammar, and the invariant is either enforced everywhere or nowhere. On the
  board, not patched here.
- **`literals` is false, so frontmatter VALUES are not searchable yet.** The keys are declarations;
  the values wait for the YAML scalar decision that Phase 5 owns. Deciding it here would have made
  markdown the second YAML interpretation, which is the drift Phase 0 chose the shared reader to
  prevent. Phase 5 must apply its answer to frontmatter as well as to `.yml`, and the mapper needs a
  home both providers can reach.
- **No fence INFO STRING,** so a result can say "in a code block" but not "in a bash block". Deferred
  from Phase 1 and unchanged here.
- **An indented code block is indistinguishable from prose in a result.** The `fenced` flag is
  literal by design. Widening it to `code` would be a protocol rename, and the owner's ruling was
  that a fence marker is all it needs.
- **Only YAML frontmatter is enabled.** TOML frontmatter would need a TOML reader nobody chose, and
  a `+++` block currently reads as ordinary prose rather than as metadata.
- **`parseFile` THROWS on a module path that escapes the workspace or is absolute.** Verified against
  the C and Python providers: all nine behave identically, `onRequest` turns it into a protocol
  error, and core never sends such a path. So this is a cross-provider question about whether an
  unrepresentable module is a bad request or a diagnostic, and it belongs on the board rather than
  being patched into one provider out of nine.
- **Every provider carries its own `modulePath` helper,** turning an absolute path into a
  workspace-relative one and re-deciding the escape check that `normalizeModulePath` already owns.
  Markdown joined an existing pattern rather than starting one, so this is nine copies of half an
  invariant. The owner has no absolute-to-relative entry point, which is the gap that produced them.
  A shared `workspaceModule(root, absolute)` plus a residue test is its own committable unit and is
  on the board, because folding a nine-provider refactor into a markdown commit would hide both.

## Phase 3 - Core ✅

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

### Phase 3 results

**The founding question answers itself now.** Against this repository the index holds 191 headings
and 647 doc regions, 7 of them fenced. `band-aid` returns `CLAUDE.md > nyaa-lexicon > Principles`
with the rule itself, and `build patch` returns
`CLAUDE.md > nyaa-lexicon > Development > Releasing` marked as being in a code block. That second
one is the exact term Question 2b measured as unfindable, so the fence decision is now checkable
rather than argued.

**A module rename, because the owner's name had stopped being true.** `commentText.ts` owned comment
normalization and would have owned doc normalization too, under a name that says only half of it. It
is `proseText.ts`, owning how prose becomes searchable for both fact classes, and both route through
one `collapse` so a phrase wrapped across lines is one phrase in either.

**The overview split is HEADINGS only, and the rest is honestly unseparable.** A document's
frontmatter keys are `property`, which is what a class field is, so no kind filter can tell them
apart. The note beside the count says headings and says nothing about keys, because that is the part
the kind can carry. Question 4 concluded the classification "sits on each symbol" via `SymbolKind`,
and this is where that turns out to be true of sections and not of keys.

**`replaceFile` takes a ninth positional parameter rather than an object.** With 118 call sites, all
but one in tests, and every parameter a distinct type, a swap cannot compile and the refactor would
be churn.

### Bug Classes

**An `anchorId` is trusted to describe what the reader assumes it describes.** One mechanism, the
walk in `headingPath` and the render around it, patched three times in this phase for one class:

1. The anchor could name a NON-HEADING, so a function appeared inside a heading path. Patched by
   checking `kind` during the walk.
2. The chain could CROSS MODULES, so a foreign heading appeared above a local one. Patched by
   stopping at a module change.
3. The anchor's own module can differ from the REGION's, so a hit in `guide.md` renders as
   `guide.md > Foreign` where `Foreign` is declared in `other.md`.

Each patch guarded the reader, and the third instance proved that is the wrong end. `DocRegion`
declares `anchorId` as any non-empty string, and every consumer downstream re-decided what that
string was allowed to be, so the next consumer inherited the same obligation and the same chance of
forgetting it.

**Closed at the boundary.** `replaceFile` already holds the file's declarations beside its regions,
which is the one place where "is this anchor a heading in this file" is answerable with no second
query. It now REFUSES a region anchored anywhere else, before the transaction opens, so the file's
previous facts survive the refusal. All three instances become impossible to persist, and the test
that used to plant instance one can no longer be written through the store at all, which is what
inexpressible means.

**Refused rather than nulled, and the alternatives were argued.** Null already means the region sits
under no heading, so reusing it for "the provider named something we could not verify" would hide a
contract violation behind a legitimate answer. Dropping the region loses prose that is perfectly
searchable for a reason the reader never sees. A third value carrying an Unknown reason was weighed
and rejected: this is a provider contract violation, which conformance already checks, rather than
an inherently unknowable relationship.

The reader guards stay. A `containerId` is still unvalidated on write, so the chain can leave the
headings even when the anchor cannot, and the walk has to stop somewhere.

**The first version of the refusal had the class inside it, twice.** It asked only whether the id
appeared among the declarations with kind heading, which a red team broke two ways: a declaration
carrying a FOREIGN symbolId vouched for an anchor in another module, and a duplicate id declared
once as a heading and once as something else passed the check while the store's own
`INSERT OR REPLACE` kept the other one. Both are the same mistake the class describes, made while
fixing it: validating a naive reading of the input rather than what the ids MEAN and what will
actually be stored. It now requires the id's own module to be this file's, and resolves duplicates
last-write-wins the way the insert does.

The one remaining bypass is `journal(db)`, which hands out the raw database on purpose for the
refactor journal. Every store invariant is reachable that way, so it is not this one's problem.

**The class is wider than documents, and the numbers say so.** Core stores five provider-originated
symbol ids without a validating owner: `reference.fromId`, a binding's `targetId`,
`declaration.containerId`, `literal.containerId`, and this anchor. Only the anchor is now checked. A
residue test over the store's ingress statements would flag exactly those 5 with 0 false positives,
while a broader field-name sweep over `core/src` flags 9 including 4 legitimate downstream reads, so
the narrow form is the one that could hold. On the board as a core-wide invariant rather than folded
in here, because the other four need a policy each: what a cross-module `targetId` legitimately
means is a different question from what a foreign anchor means.

### What the red team broke, and what it found underneath

Six angles, 464 inputs executed. Two defects were the docs tier's own, and three belonged to a
surface that shipped a release ago.

**A fence holding only whitespace stored a region no search could reach.** It normalizes to nothing,
so it sat in the table, counted, displayed, and permanently unfindable. Reachable from ordinary
markdown, since a fence of blank lines is a fence with a value. The provider drops it now: prose with
no searchable content is not prose.

**A heading path could mix two files.** `containerId` is any string, so a container in another module
put a foreign heading in a path claiming to describe this one. It stops at a module change, the same
way it already stopped at a non-heading. The markdown provider never emits either; the guard is core
refusing to launder one that arrives.

**The three that were not ours, and the important part is that they SHIPPED.** Every one reproduces
against `find_comments`, live since 1.x, and the docs tier inherited them by mirroring the contract
correctly:

- A backtracking regex HANGS the process. `/(a+)+b/` against sixty letter `a` never returns, and the
  daemon is single-queued behind it. This is reachable by an agent typing a plausible pattern.
- A NUL in the search term matches EVERYTHING, because SQLite truncates the bound pattern at it.
- A hundred-thousand-character term throws SQLite's own `pattern too complex`.

They live in `likePattern` and `compileSearchRegex`, shared by symbols, comments, literals and
documents, so one fix covers four tiers and a partial fix would leave them disagreeing. On the board
as its own unit rather than patched into a feature commit.

**Three findings were rejected, each against the code rather than on tone.** An answer citing a
neighbour's prose is ACCEPTED by design, since `knowledge-layer.md` says answers compound and the
refusal is only for citing nothing about the subject; both repros also cited the subject's own
declaration. `findDocs` throwing on an invalid regex, or on a text and a regex together, is
`findComments`'s stated contract rather than a defect. And two regions sharing a fact id needs two
regions at ONE range, which the partition invariant forbids and which `commentFactId` shares by the
same deliberate design.

**A heading's prose is CITABLE, which it was not when the table first landed.** `factById` resolved
a doc id immediately, but `factsFor` never offered one, so the citation check refused the only
evidence an answer about a section could have. Comments were already in that set and documents were
not, which made the gap a copy-paste omission rather than a decision. This is the same ruling the
comment train settled: an answer is never ABOUT prose, and prose is still evidence.

**A heading with no prose is indistinguishable from a heading that does not exist.** Both answer an
empty list. That is `commentsFor`'s shape too, so it is a cross-tier convention rather than
something this table introduced, and correcting one of the two would be the inconsistency. Recorded
rather than patched.

**A heading path contains HEADINGS, enforced rather than assumed.** An `anchorId` is any non-empty
string on the wire, and the walk reads declarations, so a provider naming a function would have put
a function inside something called a heading path. It stops at the first non-heading, which keeps the
real headings above it and answers an empty path rather than a wrong one. The markdown provider
never emits such an anchor; the guard is core refusing to launder one that arrives.

## Phase 4 - Surface ✅

- `search_docs`: returns a heading PATH plus the prose, which is the answer shape that made this a
  separate tool rather than a reuse of `find_comments`.
- Results say when a match sits inside a fence.
- `describe_symbol` on a heading shows its prose and its children.
- Tool descriptions carry the coverage honesty line, as the comment tier's do.

### Phase 4 results

**The founding use case is now reachable by an agent.** Driven through the built server over stdio,
`search_docs` for `band-aid` answers `CLAUDE.md > nyaa-lexicon > Principles` with the rule itself,
and `build patch` answers `CLAUDE.md > nyaa-lexicon > Development > Releasing` marked
`[in a code block]`. That second one is the term Question 2b measured as unfindable, so the fence
decision is checkable rather than argued.

**A layer was missing and only the live probe found it.** The tool registered, the unit tests passed
with an in-process backend, and the real server answered `unknown method: findDocs`. An MCP tool
reaches core through the DAEMON's own method table, which nothing in the unit path exercises. This is
the fourth time this project's own rule has paid: a green gate is not evidence.

**Closed as a class rather than as a bug.** A residue test now derives every method the daemon-backed
backend asks for from `main.ts`, derives every case from `dispatch.ts`, and fails when the first set
is not inside the second. Derived from both files rather than listed, because a hand-kept list of
method names is the same defect one layer up. Measured before writing it: 34 methods asked, 0 false
positives. Proven by deleting the `findDocs` case and watching it name that method.

**A heading answered code questions with zero.** `describe_symbol` reported `Used in 0 places`, `No
supertypes or subtypes in the index` and `Uses: 0 distinct symbols`, which reads as a check that ran
and found nothing rather than a question that does not apply to a section. It now says so in one
line and prints none of the three.

**The description was missing the coverage line this phase promised.** It said documents only and
stopped there, where the comment tier says INDEXED files only and points at ripgrep for an
exhaustive audit. The same sentence is there now, because an agent deciding whether to trust an
empty result is exactly who that line is for.

**A heading prints no signature block.** `renderDescribe` wrapped every symbol in a `ts` fence, which
for a heading meant a code fence around a section title, reading as code that does not exist. A
heading now shows its prose instead, which is what a document has where code has a body.

**A heading describes as a section, and `outline_module` was right all along.** Through the built
server, `describe_symbol` on `Development` in `CLAUDE.md` answers with no signature block, nine
prose regions with the three fenced ones marked, `Releasing` under Members, and one line saying the
code questions do not apply. `outline_module` on the same file answers the file's table of contents,
nested, which Question 1b predicted would fall out of headings being declarations with a container
and needing no new code. It did.

**Attacked from outside, through the real server.** Twelve hostile calls: no arguments, a text and a
regex together, an invalid regex, a regex with no slashes, a limit of 0 and -1 and 99999, a module
that does not exist, a module that is a directory, a term of only whitespace, a fenced slice, and a
percent sign. Every one answers usefully. Bad limits are refused by the schema naming the field and
the bound; a bad query is refused with the reason rather than an empty page reading as "nothing
matched"; a module that is not there answers cleanly. `100%` returns nothing, which is the escaping
holding through the whole stack: unescaped it would have matched everything.

**Deliberately not built:** the LSP adapter gains nothing here. It answers an editor, which has its
own document search and its own outline, and the heading declarations it already receives feed both.

## Phase 5 - The structured-data providers ✅

Fan out per format, each with its own conformance fixtures.

Scoped to the JSON family and YAML by Question 5. Both are adapters over machinery that already
exists: a key is a declaration, its value is a literal.

**Two decisions came first, and both are now answered.**

**1. An array element is NOT a declaration. Its value is still a literal.** `DeclarationSchema.name`
is required and nonempty, and an element has no name.

The three options were omit, mint a synthetic `[0]`, or relax the schema. Omit wins, and the reason
is that the question turned out to be smaller than it looked: a LITERAL has no name. So the value of
every array element is indexed either way, and `Literal.containerId` carries the key it sits under,
so `tags: [alpha, beta]` still answers a search for `alpha` and still says it belongs to `tags`.

What omitting costs is the ability to address `tags[0]` as a symbol, and nothing asks that. What
minting would have cost is an id that moves whenever anything is inserted above it, which is the
weakness already accepted for duplicate headings and not worth taking twice.

This also dissolves the provenance field the architecture pass proposed for this decision. That field
existed to make a MINTED name honest; nothing is minted. GDScript's synthesized script class still
wants it, so it stays on the board as GDScript's question rather than this phase's.

**2. YAML values beyond string, number and boolean are OMITTED as literals, and their keys are still
declarations.** `LiteralSchema` is exactly those three kinds, and Phase 0's spike already narrowed
the field: YAML 1.2 does not auto-resolve timestamps, so one arrives as a plain string and needs no
decision at all.

That leaves `null`, binary, and a collection or alias where a scalar was expected. Each omits the
LITERAL and keeps the KEY, which says the honest thing: this key exists, and its value is not one
this index can hold. No diagnostic, because a null in YAML is legal and common, and a warning per
null would drown the ones that matter.

An alias's value is omitted for a second reason on top: the anchor it points at is already indexed,
so emitting it again would report one literal twice under two keys.

**3. The YAML mapper is EXTRACTED, not copied.** Added by the Phase 2 architecture pass, and the
reasoning is under "What the Phase 2 architecture pass decided for this phase" above. It lives in a
new `formats/` workspace package that both the markdown provider and the YAML provider depend on.
One package rather than one per format, because the alternative is a manifest, a tsconfig and two
workspace entries per reader, and the whole JSON reader is 8 KB inlined.

- **JSON family** (`.json`, `.jsonl`, `.ndjson`, `.json5`): a key is a `property` declaration, its
  value a literal. JSONL is a sequence of independent roots and needs per-record identity. JSON has
  no comments, so `comments: false` is the honest declaration; JSON5 does have them.
- **YAML** (`.yml`, `.yaml`): keys as declarations, values as literals, and REAL comments through
  the existing comment tier. Aliases, anchors and multi-document files each get a fixture.

Every parser here was already chosen in Phase 0, so each slice is an adapter over a decided library
rather than a fresh judgement call. The YAML reader is the same one the markdown provider uses for
frontmatter: one owner, no second opinion.

### What the Phase 2 architecture pass decided for this phase

Four angles over the shipped reference implementation, asking what copying it twice would cost.

**The YAML mapper is EXTRACTED, never copied.** `frontmatterDeclarations` in the markdown provider
already walks a YAML map into declarations: keys, names, descriptors, container chaining, ranges and
the sequence-omission policy. Writing the YAML provider by copying it would produce the second
interpretation Phase 0 chose the shared reader to prevent, and the plan's own requirement that the
scalar decision reach frontmatter as well as `.yml` would then have two homes.

It cannot live in `providers/markdown/`, since a provider importing another provider's internals is
not a boundary. It cannot live in `protocol/`, which owns the wire contract and the grammars rather
than parser machinery. So it is a new WORKSPACE PACKAGE that both providers depend on. Bundling
inlines it twice on disk, which is fine and expected: the invariant being bought is one semantic
truth, not one copy.

The package takes provider context as DATA, never as a language to branch on: the language slug, the
module, the source span the YAML occupies, and the coordinate map. That keeps the never-branch rule
intact at the only place it could plausibly be bent.

**JSON and YAML declare `docs: false`, and that is honest rather than a gap.** JSON has no prose at
all, and a YAML comment is a comment, which is the comments tier. So the docs tier stays a document
tier, and nothing has to invent a heading path for a file with no headings. The region model needs
no change to absorb this phase.

**Decision 1 has a principled answer that did not exist when it was written.** The open question is
what an array element becomes when `DeclarationSchema.name` is required and an element has no name.
The architecture pass found that GDScript ALREADY faces this and answers it silently: a script with
no `class_name` gets a file-level class named from the module basename, with a `selectionRange`
fabricated at character 0, and nothing on the wire says the name was invented. `selectionRange` is
documented as the span of the name, so that fact claims a span that does not exist.

That misalignment misled one of this session's own audit agents into reporting it as a defect, which
is evidence that a consumer cannot tell either.

So the primitive Decision 1 wants is DECLARATION PROVENANCE: a closed field saying whether a name
came from the source or was synthesized, with `selectionRange` absent when there is no source name.
With it, minting `[0]` for an array element is honest rather than a lie, and GDScript's implicit
class stops being one. Without it, Phase 5 either omits array elements entirely or repeats the same
silent invention in two more formats. Decide it here, apply it to GDScript in the same change, since
a provenance field that one of ten providers ignores is worse than none.

### Phase 5 results

**Shipped:** a `formats/` workspace package holding the one reading of YAML and of the JSON family,
two providers over it, and the markdown provider's frontmatter path rewired to the same reader. The
gate is green at 1714 tests, all eleven providers pass conformance, and `grade.js` answers 8 of 8
against switchboard's 1032 files.

**Both open decisions landed as the plan predicted.** The ordinal for a sequence element lives in the
DESCRIPTOR chain and never becomes a declaration, so nothing is minted and the provenance field stays
GDScript's question rather than this phase's.

**Two deviations from the written plan, both deliberate.**

`comments` is TRUE for the JSON provider rather than false. The plan said JSON has no comments, which
is right for `.json` and wrong for `.jsonc`, and the tier is per provider rather than per extension.
A strict `.json` file reports none, which is the tier working rather than an over-claim, and a
comment in one is now a syntax error proven by a conformance case rather than a promise.

`.json5` is NOT claimed. `jsonc-parser` reads comments and trailing commas, not unquoted keys, single
quotes or hex numbers, so claiming the extension would report facts for files it half-understands.
Not claiming it leaves those files unclaimed, which is the honest answer and is visible.

**The build's smoke gate caught a shipping failure the whole test suite could not.** `jsonc-parser`
declares a UMD `main` and an ESM `module`, and `bun build --target node` takes `main`. Bun inlines
the UMD file without resolving its inner requires, so the bundle is clean and dies on node with
`Cannot find module './impl/format'`. Everything under `bun run` was green throughout.

**That closed as a class, and the class was wider than the bug.** The smoke gate runs providers only,
and it is startup-only by design, so a lazily-evaluated UMD module dies at first parse rather than at
launch. The markdown provider was in exactly that state and passed the smoke. `dist/` now gets a
static check: no bundle may carry a UMD wrapper, because a wrapper surviving IS the bundler having
failed to resolve that dependency. It covers all 17 bundles including the six entrypoints a consumer
runs directly, which had no startup check of any kind. Proven failable by planting the bare import.

**Two audit passes, and the second one earned its keep.** The first found four real defects in code
that had already passed the gate and conformance: YAML never descended into a sequence, a
sequence-valued key spanned only its own name, a multi-document file lost every document after the
first AND reported itself broken, and an unterminated block comment overran its record. Tracing the
first of those exposed a fifth the audit had not named: a sequence of mappings minted ONE symbol id
for every sibling's key, and the store's `INSERT OR REPLACE` silently kept the last.

The second pass then found what the fixes broke: a root-level array or sequence produced nothing at
all, because the guard that skipped literals with no container had been placed around the whole
traversal. A `.json` file whose root is an array is common, and the failure mode is the one this
project exists to stop: in scope, parses clean, reports no facts.

**Every one of those is now a conformance case**, in both languages where both can say it, so the
next reader of this corpus inherits the traps rather than rediscovering them.

### Bug Classes

- **A bundle that cannot run on the shipping runtime.** Closed by a static check over every bundle
  in `dist/`, not just the providers, and not depending on the failure happening at startup.
- **A sibling in a sequence overwriting its siblings.** Closed by carrying the element's ordinal into
  the descriptors of the keys below it, in both readers, pinned by a conformance case asserting
  distinct descriptor chains rather than distinct names.
- **A file in scope that reports nothing.** Closed for the root-collection case by a conformance case
  in both languages. The general form is not closed: nothing yet fails a build when a provider claims
  a file and returns zero facts for it.
- **Two readings of one format.** Closed structurally: frontmatter and `.yml` are the same function,
  so a decision about scalars cannot land in one and miss the other.

## Phase 6 - Verification

- Gate, then conformance across every provider, not only the new ones. A corpus case is shared.
- The blind corpus is the real test: index a documentation set nobody here has read and ask it
  questions.
- **The acceptance test, restated against a measurement rather than a guess.** `search_docs` for the
  text `band-aid` against this repo returns exactly one hit IN `CLAUDE.md`, and its heading path is
  `CLAUDE.md > nyaa-lexicon > Principles` with prose containing `No band-aids`. Matching is substring
  over normalized text, the same contract the comment tier uses, so the hyphen and the plural both
  have to behave.

  The first draft of this test was wrong twice, and Phase 3 measured both. It said "exactly one hit",
  which is false: ten come back, because the plan files in this repository discuss band-aids at
  length, and a test that forbids that would be a test against this repo's own contents rather than
  against the tool. And it said the path was `CLAUDE.md > Principles`, omitting `nyaa-lexicon`,
  which is that file's `#` heading and the container of every `##` under it. `No band-aids` really is
  a bolded LIST ITEM rather than a heading, so the path does stop where the draft said it stopped;
  it just starts a level higher than the draft knew.
- Drive the built server, since a green gate is not evidence.

## Phase 7 - Release

Folds into the `2.0.0` train. The CHANGELOG gains the docs tier, the new `heading` kind, and the
formats now claimed, which changes what "unclaimed" reports even without the fallback: markdown,
JSON and YAML files that were previously invisible become indexed, so a coverage number moves for
reasons a reader deserves to have explained.

## Question 5 - What ships inside 2.0.0, now that Phase 5 is known to be blocked?

Q: The whole set was chosen before the audit found four protocol gaps. Does it still hold?
A: B. Markdown, the JSON family and YAML ship in `2.0.0`. XML, HTML and the plain-text fallback are
deferred to a later major.

> B it is

**Why B, and it was the recommendation:** it draws the line exactly where the work changes
character. Markdown, JSON and YAML are adapters over machinery that already exists, so they are all
the same KIND of work. XML, HTML and the fallback each need a new concept invented in the protocol,
and inventing three of those alongside a new tier, a new symbol kind, a new fact class and a new
store table is how a release finds nine defects.

It also fails gracefully: if JSON or YAML turns out worse than it looks, either drops out without
touching anything markdown needs.

Accepted cost: this is not the whole set the owner originally asked for, and the deferred half will
cost a second index rebuild whenever it lands.

**Correction to the framing I used when asking:** I said B needed three closed decisions. It needs
TWO. Array elements with no name, which JSON and YAML share, and YAML scalar kinds beyond string,
number and boolean. The count did not change which option was right.

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

Felt building Phase 1.

**A comment claimed the opposite of what its code did, and it was load-bearing.** The runner's parse
predicate carried "DERIVED, never hand-listed. Every expectation a case can state about parsed facts
is named once here, so adding a new kind cannot half-register", above a hand-listed array. A reader
checking whether that class was closed would have read the comment, believed it, and moved on. It
was written after the six-cases-assert-nothing incident, describing the fix that was intended rather
than the one that shipped, which is the exact misalignment class this project hunts, in a comment
written BY the process that hunts it.

**Adding one enum member sends you on a scavenger hunt with no map.** `heading` on `SymbolKind` and
`doc` on `FactKind` each broke a different set of files, and the only way to learn which was to run
the gate, fix one, and run it again. The compiler is a good guide once you are typed exhaustively,
but nothing tells you up front where a kind is consumed, and the answer differed for the two enums.
A generated "who reads this enum" list would turn three gate rounds into one read.

**The LSP adapter could not name a protocol type without a dependency it should not have.** Typing
`SYMBOL_KIND` needed `SymbolKind`, which lives in `protocol`, which `adapters/lsp` deliberately does
not depend on: it talks only to `core`. So the fix was a re-export through `core`, which is right,
but the failure was a bare "cannot find module" that reads like a missing install rather than an
architectural boundary being enforced. Two minutes of confusion for a boundary that is working.

**`bun run lint` fails on formatting far more often than on anything real, and it did again.** Three
separate times this phase the gate went red purely because a multi-line object I wrote was not
biome-formatted, each costing a lint, a `lint:fix`, and another lint. This is already recorded from
the comment train and it has not improved: the half of the gate that fails most is the half a script
fixes automatically.

**A stale `tsbuildinfo` can make a planted violation look unproven.** Verifying the LSP exhaustive
map, my first two plants reported zero errors and I briefly believed the gate had an incremental
hole. Running the real `bun run lint` caught it correctly both times after. Direct `bunx tsc --build`
invocations interleaved with file restores were what produced the false green, and I nearly reported
a gate defect that does not exist.

## Deferred to a later major by Question 5

These left `2.0.0` because each needs a concept INVENTED rather than a decision made. They are
recorded in full so the next train starts from evidence rather than from scratch.

- **XML** (`.xml`). `SymbolKindSchema` has no `element` or `attribute` member, and repeated sibling
  elements collide for the same reason duplicate headings do: only a `method` descriptor may carry a
  disambiguator. Namespace-qualified names need a canonical form. "Elements as declarations" was a
  placeholder, not a design.
- **HTML** (`.html`). Everything XML needs, plus an element-selection policy: whether only `h1`
  through `h6` become headings or every element is a candidate, what an anonymous `div` is called,
  and what happens to attributes, text nodes, script and style content, and malformed recovery.
- **The plain-text fallback**, and the routing primitive it requires. `ProviderClaims` in
  `core/src/routing.ts` carries only `extensions` and an optional `filenames`. There is no
  catch-all, no negative list and no precedence, so "claims extensions nothing else does" is not
  expressible today: routing can report a file unclaimed but cannot hand it to a last-resort owner.
  This is the single largest deferred item, and it also changes what "unclaimed" means in every
  coverage report, so the overview wording moves with it.
- **The binary guard**, which deferred with the fallback that needed it. Worth knowing separately:
  `readEvent` in `core/src/watcher.ts` hashes EVERY changed file as UTF-8 with no routing check at
  all. That is a live condition TODAY, not one the fallback would create, so it belongs on the board
  independently of this plan rather than waiting for a train that may be months away.

## Painpoints

Recorded, not fixed. Felt building Phase 5.

**A green gate says nothing about whether the artifact runs.** Lint, 1714 tests and eleven
conformance runs were all green while the shipped YAML and JSON providers could not start on node.
Everything in the loop runs under bun, and bun resolves what node refuses. The build's smoke gate is
the only thing in the project that meets the shipping runtime, which makes it the most valuable check
here and the one furthest from the edit loop: it runs at build, not at `bun run test`.

**A guard placed one line too high turned a fix into a worse bug.** Literals with no container were
skipped by a condition that also wrapped the traversal, so fixing sequence traversal simultaneously
made every root-level array report nothing. The gate stayed green, conformance stayed green, and the
existing corpus cases could not see it because every data fixture written so far was rooted in a
mapping. A corpus that only ever asks about the shape you thought of is a corpus that agrees with
you.

**The second audit pass found the regression the first pass caused.** The first pass found four real
defects; fixing them introduced a fifth that the second pass caught. One pass would have shipped it.
The cycle's claim that re-audits catch what fix attempts reopen was not theoretical here.

Felt building Phase 4.

**Adding one MCP tool means editing seven places, and missing the seventh is silent.** The zod input,
the description constant, the handler, the `ToolBackend` interface, the tool registration, BOTH
wirings in `main.ts`, and a case in `core/src/dispatch.ts`. Six of those are typed, so the compiler
names them. The seventh, the daemon method table, is a string switch on the other side of a wire, so
forgetting it compiles, passes every unit test, and answers `unknown method` only when someone drives
the built binary. A residue test closes it now, but the shape is still a checklist rather than a
registration, which is the extensibility test the architecture skill asks and this fails.

**Only three of the eight audit agents could reach a daemon.** The sandbox denies `listen`, so a
Luna told to "drive the built server and attack it" reports EPERM and no findings, which reads as
clean. The distinction between "attacked it and it held" and "could not attack it" lives only in a
verdict string nobody diffs. Every live-surface angle this session had to be run by hand afterwards.

Felt building Phase 3.

**A store probe cannot run under bun, so every store experiment is a three-step build.** Bun has no
`node:sqlite`, which `CLAUDE.md` states plainly, but the consequence in practice is that answering
"what does the store do with this input" means writing a file, bundling it with `bun build --target
node`, running it under node, and deleting it. Worse, the bundle has to live in `dist/` rather than a
scratch directory, because `lexiconRoot` locates the repository from the running file's own path and
refuses anything outside it. So a throwaway probe is written into a TRACKED directory and has to be
remembered out again. Every audit agent this phase hit the same wall and solved it the same way.

**`git checkout <file>` is a live grenade in a repo where one file holds a phase.** Undoing a planted
test violation with it wiped every uncommitted Phase 3 change in `core/src/store.ts`: the table, the
schema bump, the read methods. Nothing else was lost and the compiler named the gap precisely, but
the recovery cost more than the plant was worth. A targeted revert of the planted line was available
and was not used.

**A guard written to close a class contained the class, twice.** The anchor refusal checked whether
an id appeared among the declarations with kind heading, which is a naive reading of the input rather
than a check of what the ids MEAN and what the insert will actually keep. A red team walked past it
with a foreign symbolId and with a duplicate declaration. The lesson is specific: when a store
invariant validates a write, it has to model the write, and `INSERT OR REPLACE` is part of the write.

**Nothing said the store had a second door.** `journal(db)` hands out the raw database for the
refactor journal, so any invariant `replaceFile` enforces is reachable around it. That is a
legitimate design and it is documented nowhere near the invariants it bypasses.

Felt building Phase 2.

**Writing a control-character ESCAPE into source is the hard part, not writing the character.** This
repo forbids a raw NUL, BOM or zero-width byte, and rightly so. But the editing tools turn
`"\uFEFF"` into a literal BOM and `.join("\u0000")` into a literal NUL, silently, so the natural way
to satisfy the rule is the way that breaks it. Both happened this phase and both were caught, one by
the source-bytes residue test and one by reading the file back. The workaround is to write a
throwaway node script that does the substitution with `String.fromCharCode`, which is three steps for
a one-character edit and is not obvious to anyone who has not hit it. `sed` is denied and a heredoc
is blocked, so there is no shorter path. What is missing is anywhere that says how to write the
escape in the first place.

And the guard had a hole exactly where it hurt: `BANNED_CODES` in the source-bytes residue test held
the three zero-width characters but NOT U+FEFF, so a byte order mark written into a tracked file
passed. It bit twice in one phase, once in a source file and once in the paragraph above describing
the problem. U+FEFF is in the set now, proven by planting one and watching the test name the file and
the line.

**A scratch probe cannot import a provider's dependencies.** Bun's isolated install layout means
`/tmp/probe.ts` importing `providers/markdown/src/parser.ts` fails on `Cannot find package
'mdast-util-from-markdown'`, because the dependency is linked into the provider's own
`node_modules` and nothing else. The workaround is to copy the probe INTO `providers/<language>/src/`
and delete it afterwards. That is friction on exactly the activity `CLAUDE.md` demands most, which is
driving real code against real input rather than trusting the gate.

**Nothing in a declaration says its name was invented.** A cross-provider probe asserting the obvious
invariant, that `selectionRange` slices back to `name`, reported GDScript as broken. It is not:
GDScript synthesizes a file-level class from the module basename with a fabricated range, which is
correct behaviour and is invisible on the wire. One of this session's audit agents fell into the same
trap independently. So any check over declarations carries an unstated exception, and the only way to
learn it is to read the provider that has it.

**The gate's formatting half kept failing, again.** Recorded from the comment train and from Phase 1,
and it happened four more times here: `bun run lint` went red purely because a multi-line object was
not biome-formatted, each costing a lint, a `lint:fix`, and another lint. The half of the gate that
fails most is the half a script fixes automatically.

**What WORKED, recorded because it is the counter-example.** Adding `declarationNames` to the case
schema failed the Phase 1 coverage guard immediately, naming the exact field and the exact missing
entry. That is the scavenger hunt from Phase 1 turned into one clear failure, by a guard built one
phase earlier for that reason.

Felt building Phase 0.

**The test suite reports 16 confident failures when the machine is busy, and says nothing about
load.** Every one was a 20-second timeout, spread across daemon, store, service, transaction and
TypeScript-provider tests, and the same 16 failed twice running, which reads exactly like a real
regression. One of them passes in 27ms when run alone. The cause was load average 25 from my own
workflows plus long-lived MCP servers; `--maxWorkers=2` turns all 1590 green. Nothing in the output
hints at contention, so the honest diagnosis costs a full re-run at reduced concurrency and the
dishonest one is "I broke something". A per-test timeout scaled to worker count, or a note printed
when the run detects saturation, would turn ten minutes of hunting into a glance.

**The conformance runner's initialize timeout is load-sensitive too, and it lies the same way.** A
Luna audit running beside five siblings reported `initialize timed out after 10000ms` from the
bundled markdown provider and wrote it up as a real failure. At load 0.06 the same command passes
three times running. So the vitest painpoint below is not a vitest painpoint: it is every fixed
timeout in this repo, and the report says nothing about contention in either place. An audit that
runs commands while other audits run will keep producing this finding.

**The intentional bad-handshake fixture can fail the whole run, at random.** `bun run test` prints
`Cannot find module 'vscode-jsonrpc/node' from /tmp/lexicon-badshake-*/stale.ts` on every run, which
is by design, and it is already recorded as noise. What is new is that once, with everything green
at 1590 passed, the script still exited 1. Two immediate re-runs exited 0. So the fixture's child
can occasionally leak its status into the suite's, which in CI is a red build with a green report.

**`process.execPath` is a trap in a repo where bun builds and node ships.** The smoke check I wrote
used it and was silently verifying bun, the one runtime that does not matter here. This project
already knows the bun-versus-node distinction is load-bearing enough to warrant a CLAUDE.md rule,
and the same trap is presumably waiting in any other script that spawns "the current runtime".

**A build script whose only failure path assumes bun printed the error.** The catch in
`scripts/build.ts` swallowed my thrown error entirely, so a genuine smoke failure printed nothing
but "build failed" and cost several minutes of blind debugging. That was correct while the try block
only ran `bun build`; it stopped being correct the moment anything else lived in there, and nothing
made that visible.

**Rebuilding after a dependency change churns three bundles for no semantic reason.** Adding root
devDependencies shifted the module graph enough to change minifier name allocation, so
`dist/main.js`, `dist/daemon.js` and `dist/lsp.js` each moved about 146 bytes with the only
difference being `$0` renamed to `$U`. Git treats them as binary, so the diff is unreadable and the
churn cannot be judged without decompressing both sides by hand. Committed bundles plus a
non-deterministic-under-graph-change minifier means release commits carry noise nobody can review.

## Deferred, recorded so they are not re-litigated

- **Markdown links as reference edges.** A link to `#releasing` that RESOLVES is a real edge and
  falls out of headings being declarations. Deferred, not rejected.
- **The resolve-only doc-to-code bridge.** Descoped with the hedged hint in Question 2b.
- **A provider family field.** Rejected in Question 4, with the door left open.
