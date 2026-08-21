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
- **Frontmatter is handled for EVERY markdown extension, never just `.mdc`.** Plain `.md` carries it
  constantly, and treating it as an `.mdc` quirk would mean the phantom-heading misparse survives in
  the common case. The extension is enabled for the provider, not per file type.

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

## Phase 5 - Structured data: the JSON family and YAML, one Luna each

Fan out per format, each with its own conformance fixtures.

Scoped to the JSON family and YAML by Question 5. Both are adapters over machinery that already
exists: a key is a declaration, its value is a literal.

**Two decisions come first, both closed, both settled before any provider is written.** The second
audit lap verified them against the code, and "needs no new machinery" was wrong until they are
answered.

1. **An array element cannot be a declaration as things stand.** `DeclarationSchema.name` is
   `z.string().min(1)`, required and nonempty, and JSON and YAML array elements have no name. Pick
   one and write down why: omit elements entirely, mint synthetic `[0]` names that churn whenever
   anything is inserted above them, or relax the schema. None is free.
2. **YAML scalars exceed `LiteralSchema`,** which is exactly `string | number | boolean`. YAML also
   has null, timestamps, binary and tagged values. Say which are omitted, which are normalized and
   which produce a diagnostic, rather than meeting it in a fixture.

- **JSON family** (`.json`, `.jsonl`, `.ndjson`, `.json5`): a key is a `property` declaration, its
  value a literal. JSONL is a sequence of independent roots and needs per-record identity. JSON has
  no comments, so `comments: false` is the honest declaration; JSON5 does have them.
- **YAML** (`.yml`, `.yaml`): keys as declarations, values as literals, and REAL comments through
  the existing comment tier. Aliases, anchors and multi-document files each get a fixture.

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

Recorded, not fixed. Felt building Phase 0.

**The test suite reports 16 confident failures when the machine is busy, and says nothing about
load.** Every one was a 20-second timeout, spread across daemon, store, service, transaction and
TypeScript-provider tests, and the same 16 failed twice running, which reads exactly like a real
regression. One of them passes in 27ms when run alone. The cause was load average 25 from my own
workflows plus long-lived MCP servers; `--maxWorkers=2` turns all 1590 green. Nothing in the output
hints at contention, so the honest diagnosis costs a full re-run at reduced concurrency and the
dishonest one is "I broke something". A per-test timeout scaled to worker count, or a note printed
when the run detects saturation, would turn ten minutes of hunting into a glance.

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
