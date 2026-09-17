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

Two notifications travel the other way without an answer:

```
forgetModule(module)         the index no longer holds this module
moduleAdmission(module, contentHash, outcome)
                             what the index did with the parse you just answered
```

The core sends `forgetModule` to every running provider whenever it lets a module go: the file was
deleted, grew past the size limit, turned binary, or left the scope. It rides each provider's
request queue, so it lands after any parse already asked. A provider that keeps workspace state of
its own (a declaration index, a parse cache) drops the module and does not read it back until a
`parseFile` names it again. A provider that holds nothing ignores it, and `handlersFor` wires it only
when the provider object has a `forgetModule` method. Unlike a method it is optional, which is what
lets an older provider keep working.

## What the index admitted

**Answering a parse is not the same as having it stored.** The core decides afterwards, and once it
has asked for a parse any failure but its own outage refuses it: a thrown request, an `error`
diagnostic, an id the store cannot read, or a store fault under the commit. In each case the file's
PREVIOUS facts stand and none of the answer is in the index. A provider that fills a declaration index, a package
index or a parse cache from its own answer then holds facts the core does not, and a cross-file
binding drawn from them names a symbol the store has never had.

`moduleAdmission` closes that. It carries the module, the `contentHash` the core parsed, and an
outcome that is `admitted` or `refused` with the sentence the index recorded against the file. It is
published after the index has written its decision, never before, so what it says is what the store
already holds. It is whole-file, because admission is: the store refuses on the first id it cannot
read and writes nothing, so there is no surviving subset to name.

It is NOT `forgetModule`. A forget says the index holds nothing for the module. A refusal says the
index holds the module's earlier facts and took none of these. A provider that answers a refusal by
dropping the module disagrees with the core in the other direction.

**`AdmissionLedger` from `@nyaa-lexicon/protocol` owns this bookkeeping.** Five calls:

- `staged(module, contentHash, replaced)` in `parseFile`, BEFORE the cache write, where `replaced`
  is whatever that module held. Stage only on the parse road: staging inside a helper your disk fill
  also calls stamps a pending entry nothing ever settles.
- `settle(verdict)` in `moduleAdmission`. It answers what the module must hold, or null when what
  you have stands.
- `forgotten(module)` in `forgetModule`, beside dropping the module from every cache.
- `fillable(module)` at the top of every read off disk, after the cache hit. Without it a module the
  index does not hold comes straight back through a read of its own bytes, and the correction undoes
  itself.
- `reset()` in `initialize`. A tombstone and an outstanding parse both name a module of the
  workspace being left, and neither means anything in the next one.

**Verdicts for one module arrive in the order you staged them.** The core serializes a module's
parses and publishes each one's verdict on the queue that parse rode, so the ledger settles the
OLDEST outstanding parse and ignores a verdict that is not for it. That is what lets a second parse
land before the first verdict does without either being lost.

**A provider answering either notification answers both.** A forget and a refusal are the two halves
of one lifecycle, and a provider correcting for one still disagrees with the index on the other. A
residue holds it.

A provider predating the seam ignores the notification and is unchanged; `handlersFor` wires one
only when the provider object declares the method.

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

A `Literal`'s `value` is DECODED, which means the same across languages rather than the source's
spelling. A string carries its characters with the quotes and escapes gone. A boolean is `true` or
`false` whatever the file writes, so Python's `True` and YAML's `TRUE` both arrive lowercase; a
number keeps its written form in `value` and its arithmetic value in `number`, because `1e3` and
`1000` are one number and two literals. Report the spelling and a caller has to know which language
wrote a literal before it can search for one, which returns a short answer rather than an empty one.

A `Reference`'s `fromId` names the declaration a use is WRITTEN in, and a header use a provider
emits belongs to the declaration whose header it sits in rather than to the scope around it.
Binding is a separate question and still resolves in the enclosing scope, so Python's
`def g(value=value)` binds the module's `value` while belonging to `g`. C# emits no reference for an
attribute at all, because its parser discards every identifier inside an attribute list.

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

`shebangs` claims a file with no extension whose first line names one of the listed interpreters,
as `shebangInterpreter` names them: `bash` for `#!/bin/bash`, `#!/usr/bin/env bash` and
`#!/usr/bin/env -S bash -e` alike. It ranks with a filename claim, so two providers claiming one
interpreter contest the file, and an extension decides before any shebang is read. The core and the
walk each read the opening bytes of an extensionless file for its first line, and only when some
provider claims a shebang.

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
container, a doc anchor, and a binding target read from inside that same declaration, so a read of
the second definition's own member lands there rather than on the first's. Three things keep that
narrow. The target must be a descriptor path the re-minting strictly holds, so a function-scoped
`local` ordinal, which carries no path, never moves. The rebased id must be one this settlement
minted, so an id a provider minted itself is left as a provider that knew to bind it. And a target
naming the re-minted declaration itself stays, since the bare id still declares it and which
reopening a name means is semantic and the provider's to say. A provider that knows its scopes may
mint occurrences itself; one that does not still cannot hand the store two rows under one id, which
the core refuses as a parse failure.

A declaration's `contains` says what the declarations inside it are: `members`, or `locals` of a
body that runs. Absent reads from the kind, where `function`, `method`, `constructor` and
`operator` (the protocol's `RUNNING_KINDS`) hold locals and every other kind holds members. Core
cannot tell a data value from a function value by kind, so a provider sets `locals` on a value
whose body runs and declares something: TypeScript marks an arrow or function-expression constant
or property, and a getter or setter. A data format sets nothing, so a nested key is a member of the
key above it. A parameter, or a declaration with `local` visibility, is local wherever it sits. The
field is part of the declaration's fact id only when set, so an unmarked declaration keeps its id.

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
shebangs, configExtensions, excludedDirectories })` is the project model of a workspace with no build system
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

A binding case may name `bindsToModule` as well as `bindsTo`. The runner parses only the subject
file, so a case holding several files proves a use binds into a file the provider never parsed.

### Lifecycle cases

Two cases drive a SCRIPT rather than one parse, because the rule is about what a verdict does
BETWEEN two parses. Both are gated on the `binding` tier and on a fixture in the language, and both
prove the provider binds across files at all before asserting anything, so neither can pass while
observing nothing.

- `refused-facts-are-not-held`: the index forgets the target and then refuses the parse that
  follows, so it holds nothing for it. The use must not bind into it, and must bind again once a
  later parse is admitted. The refused parse is the target's own text, so it DECLARES the name:
  refusing text that dropped the name would let a provider holding the refused facts pass, since the
  use would be unbound either way.
- `a-refusal-keeps-what-was-admitted`: the index still holds the target's earlier facts, so the use
  must still bind. A provider that replaced them with the refused parse loses it.

A fixture in a language is the claim that the provider binds across files. A language with no
fixture skips, and adding one is the corpus's work rather than the provider's. The first case does
not distinguish a provider that restored what the parse displaced from one that re-read the same
bytes off disk, because for that module both agree with the index.

A reference expectation matches same-named rows: only rows of its `role` when it states one, and
never an import or export row when it does not. `at` narrows it to rows whose range starts there
(zero-based `line`, optional `character`). Every matching row must satisfy it, so rows that disagree
fail even at one position, and a failure reports the first row in source order. A position is one
fixture's syntax, so only a case with a single fixture states one.

## Binding across files

Binding into another file is each provider's claim, not a protocol guarantee. A provider that makes
it reads the other file on demand rather than depending on scan order, since the runner and the
core may parse only the using file. The C# provider binds members of a partial type and names a
`using` directive imports across files, and leaves a same-namespace name declared in another file
unbound. The Kotlin provider binds across the whole workspace through a package index.

### Kotlin lookup

A bare name is looked up in tiers, and the first tier holding a candidate whose kind fits the role
decides. Several candidates answer `ambiguous`, sorted.

1. **Locals and parameters**, innermost scope first. A `val` is visible after its declaration; a
   lambda, `for`, `catch` or destructured variable, a parameter and a type parameter throughout its
   scope. A primary constructor's parameters reach property initializers, `init` blocks, supertype
   arguments and `by` delegates, never a member body. An arrowless lambda binds `it` and an accessor
   binds `field`; both answer unbound rather than reaching a package name.
2. **Implicit receivers**, innermost first: the class's own members, its companion's, then each
   supertype depth the index can resolve, across files and cycle-guarded. Past a nested (not
   `inner`) class, an outer class offers only nested classifiers, enum entries and companion
   members. An extension function or property adds its receiver
   type's members. A receiver the index cannot resolve is skipped, not a stop.
3. **Explicit imports and aliases.** An import that resolves to nothing stops here.
4. **The package**, this file's own top-level declarations included. Kotlin's overload resolution
   ranks explicit imports above the same package, which holds the file itself; classifiers follow
   the same order.
5. **Star imports**, pooled, admitted where the import is written: a protected member stays out
   even inside a subclass.

An extension declaration is a candidate for a bare name only where an implicit receiver whose type
has the extension's receiver name is in scope. Calling a local value or a property stops the walk as
unbound instead of reaching a same-named function further out. A read prefers a value to a function
of the same name.

A name after a dot binds by what stands left of it:

- **A type** (`Type.member`, `import pkg.Type.member`, `import pkg.Type.*`): nested classifiers,
  enum entries, and object and companion members, never instance members. `Type::member` reaches
  instance members.
- **`this`, `this@Label`, `super`**: the class and its supertypes; `super` skips the class.
- **A qualifier chain spelling an indexed package** (`p.Base` in a supertype list): through the
  package.
- **An expression of unknown type** (`other.name`): unbound, never a same-file guess.

Qualifiers resolve iteratively, so a long chain cannot exhaust the stack. A read and a write on one
token (`x += 1`) bind independently. A `private` top-level declaration binds only in its own file;
`internal` binds workspace-wide.

### Kotlin stated limits

What no syntax tree can answer, so a use stays unbound or binds by the tiers above:

- **Receiver lambdas** (`with`, `apply`, `run`, `buildString`, Compose scopes): the receiver type is
  written in the called function's declaration, usually outside the workspace, not at the call. A
  bare name inside falls to the later tiers, so `with(b) { limit }` binds a package `limit`, and
  `this` binds the enclosing class.
- **A receiver outside the workspace** (a supertype such as `ViewModel()`, an extension on an
  external type): its members are not indexed. A name it provides falls to the later tiers.
- **Value receivers** (`b.limit` with `b: Box`): the type of an expression needs inference, which
  this provider does not do.
- **Overloads**: choosing one needs argument types, so a call naming several answers `ambiguous`.
- **Gradle modules**: `internal` binds across the workspace because module boundaries live in build
  scripts, not in the source.

What the provider simplifies, which only differs from the compiler in rare or non-compiling code:

- **A local class's member** loses to a same-named local of the enclosing function, since every
  local tier ranks above every receiver. Kotlin interleaves the two by scope level.
- **A typealias** is not followed as a qualifier or a receiver type.
- **An import naming no indexed declaration** stops the lookup rather than falling through.
- **Shadowing only non-compiling code sees**: an outer class's type parameter stays visible in a
  nested class, and a class's own members are visible in its supertype arguments.

### The index lifecycle

The index must hold what the core holds, or a binding names a symbol the store does not have:

- **Built from outline parses** of the discovered files the index lacks, on the first lookup. A
  file is read through `readSourceFile`, the same size bound and binary guard the core reads with,
  so a file the core refuses to read is never indexed.
- **Only admitted facts.** A parse carrying an `error` diagnostic, which the core refuses, leaves
  the module's last admitted declarations in place, whether it came through `parseFile` or from
  disk.
- **Forgotten on `forgetModule`,** and kept out of any later fill until `parseFile` names it again.
- **A file that could not be read is retried** on each later lookup. A missing one is not.
- **A rediscovery reads every module again.** One whose text is now refused or unreadable keeps
  what was admitted; one whose file is gone, too large or binary leaves.
- **`typeOf` takes a declared type's symbol from the binding** of the type as written, so it never
  names a declaration the binding would not.

One gap remains. The core forgets a file it cannot read, so a file made readable again with no
watcher event stays out of the index until it is parsed again.

Every provider holding cross-file state follows these rules now, through `AdmissionLedger` and the
verdict the core publishes; "What the index admitted" above has the whole of it.

## Versioning

Negotiated at initialize and additive-only within a major, so an older provider keeps working
against a newer core. A major mismatch is refused rather than attempted.
