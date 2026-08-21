# Provider protocol

A language provider is a separate process speaking this protocol over stdio, so each one is written
in whatever language has the best analyzer for its target. Providers live in
`providers/<language>/` and depend on this contract alone.

## The one rule

**Uncertainty lives in the value, never in the interface.** Every provider implements every method.
There are no optional capabilities. A provider with no inference answers `typeOf` with
`Unknown { reason: NotImplemented }`, so a provider covering nothing and one covering everything
are identical in shape and completely different in content. That is what lets the core stay free of
any branch on language, which a residue test enforces.

## Methods

```
initialize(root)             -> ProviderInfo { id, language, extensions[], protocolVersion, tiers }
discoverProject(root)        -> ProjectModel { files[], resolutionRules, externalRoots[] }
parseFile(module, hash, text)-> FileFacts { declarations[], references[], imports[], literals[], comments[], docs[] }
resolveImport(from, spec)    -> ImportResolution
bind(reference)              -> Binding
typeOf(target)               -> TypeInfo
renameEdits(request)         -> RenameEditsResponse
moveEdits(request)           -> MoveEditsResponse
shutdown()
```

`parseFile` is one call returning everything from one parse. There is no `describe`: narrative is
the core's job, and a provider writing prose means the boundary leaked. `discoverProject` is the
underestimated one, since config discovery and specifier resolution rules are the largest
per-language cost.

## The values carry the contract

`Binding` is `Bound`, `Ambiguous` or `Unbound`. Ambiguous is a first-class answer, not an error and
not a guess.

`TypeInfo` is `Known`, `Inferred` or `Unknown`. `display` is a string, because a structured type
tree is a TypeScript-shaped idea that other languages cannot fill.

`reason` is a closed enum, and an Unknown without one fails conformance. "The language cannot know
this" and "nobody has written it yet" must never collapse into the same sentence.

## Declaring what you cover

A tier boolean may not be an unqualified claim over a vocabulary. Declaring the `references` tier
REQUIRES listing the roles extracted, refused by the schema rather than by convention, and emitting
a role outside that list fails conformance. So the declaration cannot over-claim or under-claim.

The tiers are a planning hint and a coverage report. Nothing consults them before making a call.

`syntaxDiagnostics` is the one tier that is not about coverage. It says parseFile reports a syntax
error as an error diagnostic, which is what lets a caller validate candidate text before writing
it. A lenient extractor recovers from anything and returns nothing, so silence from a provider that
never declared the tier means unchecked rather than clean. Absent is therefore different from
false, and conformance fails a provider that declares it and then stays quiet on invalid text.

## Comments are spans, never attachments

A provider reports each comment as a `CommentSpan`: its range and its verbatim text, markers
included. It reports nothing about which symbol the comment belongs to.

That division is deliberate. Which declaration a comment documents is position math over ranges the
core already stores, so each provider implementing it would be another chance to disagree about one
rule. The core groups runs, decides the form (leading, trailing, inline, standalone), picks the
anchor, and normalizes the text for search.

Report what the language calls a comment, including interpreter lines, and let the core decide what
is prose. Filtering in the lexer hides the span from the only layer that can judge it. The
conformance cases for this tier assert the EXACT set, so a marker inside a string literal reported
as a comment fails rather than passing unnoticed.

### Emit from the tokenizer you already have

Never add a second pass that scans for markers. A separate scanner holds its own opinion about
where strings begin and end, and the moment it disagrees with the real lexer you report prose that
is not there. Every provider here emits comments from the same token list that produces literals.

This is the tier's one recurring defect, and it is worth knowing why before writing a ninth
language. A comment is defined by what is NOT a string, so every hole in your string grammar
becomes a false comment. It has bitten four providers: a string ending at the first quote inside an
interpolation, an empty block comment read as a doc opener and running to end of file, a string
ending at a backslash-newline that the language splices, and interpolation holes never tracked at
all. Nothing the provider reports about itself can catch this, so the corpus is the only guard:
before trusting a new lexer, plant a marker inside every string form the language has.

### Rules the cases enforce

- A CRLF carriage return ends the line and is not comment text. A LONE carriage return terminates
  nothing and IS comment text.
- Where the language splices a backslash-newline, it splices inside comments AND inside strings.
  One spliced line comment is one span, not two.
- An interpolation hole is code. Markers inside a string nested in a hole are text, and comments
  written in a hole are comments.
- An unterminated block comment runs to end of file as a single span, with a diagnostic.
- Every span's range must slice its own text back out of the source. The suite checks this for
  every span reported, not only expected ones.
- At `outline` or `surface` depth, send `comments: []` like the `literals: []` beside it. Absent
  means the tier is false, which is a different and stronger claim than "did not extract here".

## Documents are headings and regions

Only a provider whose files are DOCUMENTS declares the `docs` tier. Every code provider declares it
false, and that is the honest answer rather than a gap: a language has no sections.

A heading is a DECLARATION of kind `heading`, with the heading above it as its container. So an
outline of a document is its table of contents, and everything built on declarations works without
knowing a document from a class. Its range covers the whole SECTION, ending at the next heading of
the same or a shallower level, so reading a heading's source returns the section rather than the
title line.

**Only a heading at the document's top level is structure.** One inside a blockquote or a list item
is quoted or embedded material, so it stays prose. The same argument that makes a fence's contents
text makes a quoted outline text: a document quoting another document would otherwise grow sections
it does not have.

The prose is separate, one `DocRegion` per contiguous stretch:

- **Per REGION, never per section.** A section is normally prose, then a fence, then more prose. One
  fact per section could not say which part was fenced.
- `fenced` marks a region from a fenced code block, so a result can say where it was found. A
  fence's contents are TEXT: never parse them as the language the fence names. It is literal, so an
  indented code block is a region with `fenced` false. That block is code and it is not fenced, and
  widening the flag to cover both would make it say something its name does not.
- `anchorId` is the heading's symbolId, never its name, because two headings share a name. Absent
  means the region sits under no heading, which covers prose before the first one and a file with
  none.
- Regions PARTITION the file: disjoint, in document order. Overlapping regions index the same bytes
  twice, so one search returns the same prose as two facts.
- A range slices its own text back out, with fence delimiter lines excluded from both.

**A repeated heading needs an occurrence.** `## Notes` twice under one parent would otherwise be one
symbol, so the second carries a disambiguator: `Parent/Notes(2)/`. That id moves if a sibling is
inserted above it, which is a known and accepted weakness, recorded in `plans/docs-tier.md`. Emit a
diagnostic when you disambiguate, so a reader learns it there rather than when knowledge stops
resolving.

## Positions

Ranges are UTF-16 code units, pinned in the schema and proven by a shared conformance case whose
fixture puts one astral character to the left of a name, so bytes, codepoints and code units give
three different columns and only one passes.

The reverse direction matters more than the forward one: a range that reads correctly and slices
incorrectly corrupts a file on rename rather than merely misreporting it.

## Rename

A write is proposed before it is performed. The core decides WHICH occurrences belong to a symbol,
since provenance is language-neutral, and the provider decides WHAT TEXT each becomes, since that
is pure syntax.

Three per-site outcomes, so an occurrence that must change and cannot is never confused with one
that correctly needs no change. A single blocked site writes nothing at all.

`ownerCalls` carries the calls to the declaration that owns the symbol being renamed, per file. A
named argument spells a parameter at a site written as the function's name, so no search for the
old name would ever find it.

## Move

Same split as rename, one request per module involved. `protocol/src/move.ts` holds the schemas.

The core sends a DEPENDENCY INVENTORY: every name the moved body uses, each with what the index
proved about where it comes from. `DependencyOrigin` distinguishes a name declared inside the moved
closure, one left behind in the source module, one from another workspace module, one resolving
outside the workspace, and one the index could not place. There is deliberately no `builtin`
member, because deciding whether a name needs an import at all is language knowledge and a core
that classified builtins would be branching on language.

An inventory is complete by contract. A provider never reads an absent entry as "no import needed",
which is the failure that would relocate a declaration and leave its dependencies dangling.

Rendering the new specifier belongs to the provider, inside `moveEdits`, since tsconfig paths,
package export maps and alias schemes are things only it knows. It answers with the edit, or
refuses that site with `NoImportPath` or `AmbiguousImportPath`.

A target that does not exist yet arrives with `exists: false` and empty text. The provider parses
the supplied text and answers as usual; the file is created by applying the edits.

`MoveBlockedReason` and `MoveRefusal` are separate enums from rename's despite five shared
spellings, so neither contract needs the other's agreement to gain a member.

## Transport

`vscode-jsonrpc` over stdio. It solves the partial-read problem a pipe creates and gives request
correlation, which framing alone does not. A hand-written NDJSON reader was written, audited and
deleted after shipping two bugs in exactly the area this library has had a decade of use in.

## Conformance

`protocol/` carries a fixture corpus and a runner:

```
node dist/conformance.js <command to start your provider>
```

It runs without the core and without a daemon, so a provider team is never blocked on us. A
provider passes when every tier it DECLARES passes; an undeclared tier skips rather than fails, so
read the skip list as carefully as the failures. Passing tier N IS being done with tier N: the
suite says when a provider is finished, not the team writing it.

The suite asserts the shape of Unknowns too. Without that, a provider can return reasonless
Unknowns everywhere and pass.

## Versioning

Negotiated at initialize and additive-only within a major, so an older provider keeps working
against a newer core. A major mismatch is refused rather than attempted.
