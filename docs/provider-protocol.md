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

`content` says what the claimed files ARE: `code` declares behavior, `data` declares structure (a
JSON or YAML key is a `property` declaration, and a fixture has thousands), `document` is prose under
headings, `text` is prose with no structure at all. Absent means code. The core records it per file
from the provider that owned the read, and `overview` counts files and symbols per class, ranks the
largest code modules apart from the largest data files, and counts text files on a row of their own
without ranking them, since they hold no symbols. It is one declaration for everything the provider
claims: a code provider that also claims a data file, as GDScript does `project.godot`, reports it
as code, which is honest about who answers for it.

`sharedExtensions` claims an extension only when the workspace contains a file with one of its
`beside` extensions. The evidence is every file the scope admits, owned by a provider or not, read
before any ownership is decided; a file indexed outside a scan adds itself to it. It outranks a plain claim on that extension, while two holding shared claims
contest the file. A filename claim outranks both. Routing then considers a fallback claim.

In Git mode, tracked files remain in scope even under a default-excluded directory; directory exclusions
only limit files added by provider discovery. An ignored file never enters scope unless explicitly included.
Use `deny` for tracked secrets, such as `**/*.pem`, `**/id_rsa`, `**/id_ed25519` and `**/.env*`.

Indexing, the watcher and the provider probe read through the guarded source reader. Transaction snapshots
read bytes for byte-exact rollback and never send those bytes to a provider.

## What a diagnostic's severity does

`error` means the file could not be read: core stores nothing from that parse, keeps whatever an
earlier parse stored, records the file as failed with your message, and names it in every answer
until a later read succeeds. Reserve it for text you could not extract from.

`warning` and `info` are notes. Core keeps them beside the file's facts, replaces them on every
read, shows them under `outline_module` for that file, and counts the files that carry any in
`overview`. They never fail a file or count as a failure. Use them for what a reader should know
about how the file was read: a key you saw and could not index, a dialect the file deviates from.
Lexicon exists to learn a codebase, not to judge one, so a note states what was read and why,
never that the file is wrong.

A `module` that is absolute, escapes the workspace, or carries a control character is not a file
with a problem: it is a request no symbol id can name. `parseFile` answers it with a request error,
not a diagnostic, and the shared server refuses it before your code sees it. Core never sends one;
the conformance suite asks every provider for `../escaped` to prove the refusal.

## Names and ids

### Qualifier descriptors

A written qualifier is part of symbol identity. Each qualifier segment uses the descriptor kind of
a declaration with that name in the same parse. If the parse does not declare the segment, the
provider emits a `namespace` descriptor. This describes identity and does not classify the
language construct. The qualifier is appended to the enclosing declaration path, not substituted
for it.

A prototype and its definition in one parse are one declaration: the provider merges them by
name, qualifier path and signature (C++ reads the signature as parameter types with names and
default arguments dropped and integral spellings folded, then the cv and ref qualifiers, so
`f() const` and `f()` stay two), keeps the definition's ranges, and reports the prototype's name as
a `read` reference to the merged symbol. Overloads sharing a path carry a disambiguator, `f(1)`,
numbered by where each is reported: a merged definition counts at its body, so reordering the
definitions renumbers them and the header's order does not.

Providers emit occurrences through the shared server boundary. The required convention is applied
by `serve.ts` with `withOccurrences` for every provider.

A declaration's `name` is the source's spelling. The id normalizes that spelling to NFC, because
macOS stores filenames decomposed and Linux composed, and one symbol must mint one id. So `name`
and the id's last descriptor agree for composed source and differ for decomposed source. The id is
canonical and the name is what the file says; anything matching by name normalizes to NFC first.
Providers do not normalize names: a name that changed for unchanged source would move every fact
digest, which is a major.

A declaration's `selectionRange` is the span of its name, and nothing else: an editor highlights
it on reveal and a rename rewrites it. A name that is not in the source has no span, so the field
is absent rather than invented. GDScript names a script with no `class_name` after its file, and
that declaration carries no `selectionRange`; the core then anchors nothing to it by line, offers
no rename of it, and an editor falls back to the declaration's range.

One id names one declaration. A name path that a file declares twice, a merged interface or a
block-scoped sibling, is two declarations, and the wire settles that for every provider: the
second and later ones carry an occurrence, `Cart[2]#`, `y[3].`, `add(2)[2].`, `(x)[2]`, `[T][2]`,
counted in source order, while the first keeps its bare id so nothing that never repeated changes.
A macro invocation read as a function, or a template read twice, repeats a parameter name the same
way, which is why a parameter carries one too; a type parameter may not be named by digits alone,
since `[2]` after a descriptor is an occurrence. What sits inside a
re-minted declaration follows it by position: its members, a reference's owner, a literal's
container, a doc anchor. A binding target is semantic and is left as the provider bound it. A
provider that knows its scopes may mint occurrences itself; one that does not still cannot hand the
store two rows under one id, which the core refuses as a parse failure.

Every id a parse hands over is read once, at the boundary, for what its field says it means. A
declaration's id names the file being parsed. A `containerId`, a reference's `fromId` and a
literal's `containerId` name a declaration in the same parse, since enclosure is lexical. A
document's `anchorId` names a heading in the same parse. A bound reference's target may live in
any module, so it is checked for form alone. Every one of them must be spelled the one way
`composeSymbolId` spells it: an attempted `%2F` slash escape, or a name quoted that needed no
quoting, would read back as a second id for one symbol, which the citation model cannot survive.
One failure refuses the whole
file as a parse failure naming the id, and the file's previous facts stand. Compose ids with
`composeSymbolId` and these hold by construction.

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
is not there. Comments must come from the same lexical authority as the values: the same token list
where a provider has one, or the same library's own parser where the values come from a tree.

This is the tier's one recurring defect, and it is worth knowing why before writing another
language. A comment is defined by what is NOT a string, so every hole in your string grammar
becomes a false comment. The shapes to check for: a string ending at the first quote inside an
interpolation, an empty block comment read as a doc opener and running to end of file, a string
ending at a backslash-newline that the language splices, and interpolation holes never tracked at
all. Nothing the provider reports about itself can catch this, so the corpus is the only guard. Its
string-forms case, built from `protocol/src/conformance/stringForms.ts`, plants comment-shaped text
inside each string form its table names for a language, beside three real comments, and the exact-set check
fails on a marker reported or a real comment missed. A new lexer adds its language's forms there
before it is trusted, and every form a lexer once got wrong stays in the table.

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

The `docs` tier reports prose regions. A provider whose files are documents or plain text may declare it.
Document files add heading structure; plain-text files have no headings.

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
- `plain`, when present, is the region's visible text with the source's markup stripped, and it is
  what search normalizes; `text` stays verbatim so the range still slices it out. An HTML block
  carries its inner tags in `text` and its words in `plain`.
- Regions PARTITION the file: disjoint, in document order. Overlapping regions index the same bytes
  twice, so one search returns the same prose as two facts.
- A range slices its own text back out, with fence delimiter lines excluded from both.

**A repeated heading carries an occurrence.** `## Notes` twice under one parent would otherwise be
one symbol, so the second is `Parent/Notes[2]/`. That id moves if a sibling is inserted above it,
an accepted weakness of naming by position. The occurrence is applied by `withOccurrences` in
`serve.ts` for every provider; a provider emits the plain id and nothing else.

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

The wiring around a provider is library code from `@nyaa-lexicon/protocol`, linked into each
process rather than written again per language. `handlersFor(provider)` builds the method table
from a plain object with one method per protocol method, so a method added to the table fails to
compile in every provider until it is answered. `discoverByWalk(root, { extensions, filenames,
configExtensions, excludedDirectories })` is the project model of a workspace with no build system
to ask, and `walkWorkspace` the walk under it. `workspaceModule(root, absolute)` and
`workspaceFile(root, module)` are the two directions between a path on disk and a module, both
through `normalizeModulePath`, so a provider cannot spell a module one way in discovery and another
in an id. An entry point that walks, converts a path or wires handlers itself fails a residue test.
A provider with its own project model, as TypeScript has, uses the handler table and nothing else.

## Conformance

`protocol/` carries a fixture corpus and a runner:

```
bun dist/conformance.js <command to start your provider>
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
