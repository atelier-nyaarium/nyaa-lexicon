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

Readers in `formats/`, one per syntax, over a library chosen by `docs/parsing.md` rule 1 after a
spike for source positions and the ESM bundle rule: `saxes` for XML and `parse5` for HTML are the
candidates. Elements and attributes as declarations per Question 1; conformance cases shared with
every provider. A new dependency is put before the owner before it is added.

## Phase 3 - Plain-text fallback

Blocked on a routing primitive: `ProviderClaims` cannot express a lowest-precedence catch-all, and
the read path has no binary guard. Its own questionaire, since claiming every unclaimed extension
changes what a workspace exposes.
