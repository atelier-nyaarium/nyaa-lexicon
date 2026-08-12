# nyaa-lexicon

Symbol-level code understanding, served from one core: an MCP server for agents and an LSP server
for editors. Point it at a symbol and ask what it is. It answers with structure, direction (who
defines it, who uses it), types, and honest uncertainty.

An agent already has grep and read for free, so a tool earns its call only by doing something they
cannot: resolving an import through a chain of re-exports, listing every real use of a symbol
rather than every line containing its name, typing something nobody annotated, or rendering a
400-line class as its public surface.

## Install

```
claude plugin marketplace add atelier-nyaarium/claude-marketplace
claude plugin install lexicon@atelier-nyaarium
```

Requires Node 22.5 or newer. The plugin ships a prebuilt bundle, so there is no install step and no
toolchain to set up.

## Languages

TypeScript and JavaScript, Python, and GDScript, each in its own process behind a documented
protocol. A provider declares which tiers it covers; anything it cannot answer comes back as
Unknown with a reason, never as a guess or a gap.

## What it answers

**Structure.** `describe_symbol`, `outline_module`, `search_symbols`, `overview`, `most_referenced`.

**Direction.** `find_references`, `resolve_import`, `find_imports`.
Reverse lookup is an indexed read, not a search.

**Types.** `type_of`, declared or inferred, with the basis stated.

**Text as a fact class.** `find_literals` indexes every string, number and boolean by its decoded
value, so a name inside a quoted string is findable and numbers compare as numbers.

**History.** `file_history`, `co_changed_with`, `symbol_history`. What changes alongside a file is
the strongest signal no reference edge carries.

**Rename.** `prepare_rename` proposes, `rename_symbol` performs, and a single blocked site writes
nothing at all.

**Knowledge.** `record_answer` and its siblings store prose about a symbol, but only prose that
cites the facts it was drawn from. See [docs/knowledge-layer.md](docs/knowledge-layer.md).

**Housekeeping.** `list_project_stores` and `delete_project_store` manage the indexes this machine
holds, across every project.

## Project selection

Register codebases once, then bind the ones used by the current MCP session. `list_projects` shows
each binding name beside its full root.

Read tools accept a `queries` array. Each item uses that tool's normal fields, and one MCP call can
run several items. The outer `projects` selector applies to every item. Omit it when one project is
bound, pass names for a subset, or pass `[]` for every bound project. `rename_symbol`,
`record_answer`, `invalidate_answer`, and `reaffirm_answer` accept one optional `project` instead
and never fan out.

Binding names are session-local. Same-named roots use `app-1`, `app-2`, and so on. A plugin reload
compacts the names, so call `list_projects` again and match the full root.

## How it runs

One daemon per workspace, shared by every session that finds it. Clients hold a connection while
they work, so the daemon knows how many it has; the last one leaving starts a countdown, and the
index is a file on disk, so a restart re-uses everything unchanged.

## Documentation

- [docs/architecture.md](docs/architecture.md) - how the pieces fit
- [docs/provider-protocol.md](docs/provider-protocol.md) - adding a language
- [docs/knowledge-layer.md](docs/knowledge-layer.md) - answers and the citation rule
- [docs/parsing.md](docs/parsing.md) - the law every hand-written parser here follows
