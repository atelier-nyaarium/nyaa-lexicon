# Questionaire

The second half of the structured-data request: XML, HTML, and a plain-text fallback. Markdown,
the JSON family and YAML shipped in 2.0.0 under `plans/docs-tier.md`.

## Question 1 - What names an XML or HTML node?

Q: Tag path only, tag path plus a promoted identity attribute, or identity only?
A: Tag path plus a promoted identity attribute, refined so the identity list is not load-bearing.

- Every attribute is a `property` declaration under its element, in the key-is-a-declaration model
  `readJson` and `readYaml` already use, holding its value as a literal bound to it. Nothing about
  visibility depends on the attribute's name, so a dialect that says `key` or `data-report-id` is
  searchable by name and by value with no list.
- Promotion decides only the element's own name and the stability of its id: `string.app_name`
  rather than `string[7]`, which shifts when a sibling is inserted above and invalidates recorded
  answers. Matched by local name with the namespace prefix ignored, so `android:name` counts.
  Nodes without identity keep a positional id, as a markdown `heading` does.
- No workspace setting for the list. If one is ever wanted, core owns it and passes it to the
  provider as data, the way `surfaceGlobs` travels; a provider never reads `lexicon.json`.
- `class="a b"` is one literal. Duplicate ids become occurrences, never merged. Visible HTML prose
  goes to the docs tier; attribute values and data-like text are literals; `script` and `style`
  bodies are opaque in the first cut. A namespaced name is quoted in the id and keeps its spelling.

> "B sounds good. but what if they call something `key`? or a name we don't expect? What if they
> want to search by `data-report-id`?"

## Question 2 - Which first, the general field-and-value query or the markup tier?

Q: Nothing today asks "a field named X whose value is Y". Attributes-as-declarations makes markup
one more case of it. Build the query first, or the tier first?
A: The query first.

Recommendation reason: dependency order, it helps every language already indexed, and the markup
tier then arrives with its motivating fixtures already answerable.

## Question 3 - The query's shape: `key` alone, or `key` plus a general `within`?

Q: `key` matches the immediate container's name. Is an ancestor scope worth its weight?
A: Both, with `within` made general: one scope resolver serving `search_symbols`,
`find_references`, `find_literals` and `find_comments`.

Recommendation reason: the gains are in code, not data files. A symbol id already carries its
container path and a namespace recurs in every file's ids, so containment scopes across modules
with no new column; every reference records the symbol it sits inside and every literal its
container, so one resolver scopes declarations, uses, values and comments alike. "Every method in
a namespace", "calls to X from inside Y" and "route strings under the routes layer" are not
askable today except by paging through everything.

> "If we do B, does it have use for codebase lexicon as well? Like finding a symbol within a symbol
> scope?" ... "Symbols within only API routes, or whatever"

## Question 1a - Should `key` join `id` and `name` as an identity attribute?

Q: React keys by `key`; does it belong in the promotion list?
A: Add it third, precedence `id`, `name`, `key`. React keys are JSX props owned by the TypeScript
provider and never reach this tier; the real case is `.NET` config XML (`<add key= value=>`) and
Java-style `<entry key=>`. It changes nothing about visibility, only which elements get stable ids.

# Plan

## Phase 1 - Scope and key filters

One scope resolver in core is the single owner of `within`: it accepts a symbol id from an earlier
result or a name, resolves a name to its exact-name declarations, reports an ambiguous name rather
than picking one (as routing reports a contested file), and matches candidates by descriptor
containment on their ids, so a namespace scopes across modules. `search_symbols` filters
declarations by their own id, `find_references` by the id of the symbol each use sits inside,
`find_literals` by the literal's container, `find_comments` by the symbol a comment attaches to.

`find_literals` also gains `key`, matched exactly against the immediate container declaration's
name, one join from a literal's container id to its declaration. Results carry the container's
name and kind rather than an opaque id.

The MCP schemas, the daemon methods and the LSP read model follow the read model. A residue test
holds that every scoped query routes through the one resolver. Not a protocol change; nothing
stored changes.

## Phase 2 - XML and HTML

### Parsers, by the three questions of `docs/parsing.md` rule 1

Spiked in a scratch project, nothing added to the repository yet.

- **XML: `@rgrove/parse-xml` 4.2.3** (published 2026-07-26, zero dependencies, ESM and CJS
  entries). `includeOffsets` puts `start` and `end` on every node: element, text, CDATA, comment,
  processing instruction. Attributes come as a map with no spans, so the reader slices the start
  tag by the element's offset and scans it with a small cursor. Entities are decoded. Malformed
  input throws an `XmlError` carrying line, column and offset. 6.1 MB in 174 ms. Bundled for node:
  37 KB, no UMD wrapper, runs.
- **HTML: `parse5` 8.0.1** (published 2026-04-19, one dependency, `entities` 8.0.0, both ESM with
  `exports` maps). `sourceCodeLocationInfo` puts start tag, end tag and per-attribute offsets on
  every element, marks an implied end tag by its absence, and locates text and comments. Script
  bodies arrive raw. Never throws: recovery is the HTML standard's. 5.8 MB in 446 ms. Bundled for
  node: 263 KB, no UMD wrapper, runs.
- `saxes` was rejected: last published 2021, CommonJS only, and positions only at event ends.

### Model

`formats/` gains `./xml` and `./html`, one reader each, taking context as data (language, module,
offset, coordinates, the identity list). `providers/xml` (language `xml`, content `data`) and
`providers/html` (language `html`, content `document`) wrap them the way `providers/json` wraps
`readJson`.

- **Element**: declaration kind `property`, descriptor `term`. Name: the value of the first
  identity attribute present, by local name in the order `id`, `name`, `key`, prefix ignored,
  empty values skipped; otherwise the tag as written, prefix kept. Selection range: the identity
  value inside its quotes when promoted, else the tag name in the start tag. Range: start tag to
  end tag, or to the element's end when the end tag is implied. Signature: the start tag text,
  capped at 160 characters. Container: the parent element. Same-named siblings are minted plain and
  the wire's `withOccurrences` numbers them; a reader never does. A promoted element is found by
  its identity, not its tag, which stays in the signature and the outline.
- **Attribute**: declaration kind `field`, descriptor `term`, name as written with its prefix,
  selection range the name, range name to value, container the element. Its value is a `string`
  literal held by the attribute, ranged over the quotes as the JSON reader ranges a string; an
  HTML value written bare is ranged as written. A value past 16 KB is not a literal, and an `info`
  note names the holder and the length.
- **Comment**: a comment span, markers included; core attaches it.
- **XML text and CDATA**, non-blank: a `string` literal held by the element, value decoded, ranged
  over the node. Mixed content yields one literal per text node. Processing instructions and the
  doctype yield nothing. A parse error yields one `error` diagnostic at its position and no facts.
- **HTML headings** `h1` to `h6`: an element row of kind `heading`, in the one element tree, named
  by its text with tags stripped, entities decoded and whitespace collapsed, the tag when empty.
  Its attributes hang beneath it. Prose anchors to the nearest preceding heading in document
  order, so `search_docs` on HTML names the heading a region sits under and no level path.
- **HTML prose**: one doc region per element that is not phrasing content and has visible text
  reachable without crossing another block: `text` is the raw inner slice, tags included, as
  markdown regions carry their markers; `plain` is that visible text, whitespace collapsed, which
  core normalizes for search. `fenced` inside `pre` or `code`. `script`, `style` and `template`
  yield nothing, and a bogus comment parse5 makes of `<![CDATA[` is not a comment.
- **Depth**: `markupTooDeep` in `depth.ts` counts tag nesting before either parser runs, skipping
  comments, CDATA, processing instructions and the raw text of `script` and `style`; past
  `MAX_NESTING` the file reports `TOO_DEEP`. The spike measured why: parse-xml overflows the stack
  at ten thousand levels under node, and parse5 survives a hundred thousand in thirty-five seconds.
- **Extensions**: XML `.xml .xsd .xsl .xslt .xhtml .svg .plist .xaml .resx .csproj .fsproj
  .vbproj .props .targets .nuspec .wsdl`; HTML `.html .htm`.
- **Tiers**: XML declarations, literals, comments, syntax diagnostics; HTML declarations, literals,
  comments, docs.

### Verification

Conformance fixtures for both languages on every shared case that fits a data or document format
(the astral, trailing newline, empty file, CRLF, BOM and marker cases), plus cases of their own:
identity promotion by each attribute and by precedence, a namespaced identity, an implied end tag,
a void element, duplicate ids as occurrences, a heading path across levels, a prose region inside
`pre`, and a parse error's position. Then an index of real corpora: the Android resources and
manifests in switchboard, the console HTML there, and an MSBuild project.

## Phase 3 - Plain-text fallback

Blocked on a routing primitive: `ProviderClaims` cannot express a lowest-precedence catch-all, and
the read path has no binary guard. Its own questionaire, since claiming every unclaimed extension
changes what a workspace exposes.
