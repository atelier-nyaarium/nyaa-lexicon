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

Nine, each in its own process behind a documented protocol.

| Provider   | Files                                                 |
| ---------- | ----------------------------------------------------- |
| TypeScript | `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` |
| Python     | `.py`                                                 |
| Rust       | `.rs`                                                 |
| Kotlin     | `.kt`                                                 |
| C#         | `.cs`                                                 |
| C++        | `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.hxx`               |
| C          | `.c` `.h`                                             |
| GDScript   | `.gd`                                                 |
| Markdown   | `.md` `.mdc` `.markdown`                              |

A provider declares which tiers it covers; anything it cannot answer comes back as Unknown with a
reason, never as a guess or a gap.

Markdown is the one that is not a language. Its headings are declarations, so a document outlines
like a class, and its prose is a fact class of its own. `docs/provider-protocol.md` says how under
"Documents are headings and regions".

## What it answers

**Structure.** `describe_symbol`, `outline_module`, `search_symbols`, `overview`, `most_referenced`.

**Direction.** `find_references`, `resolve_import`, `find_imports`.
Reverse lookup is an indexed read, not a search.

**Types.** `type_of`, declared or inferred, with the basis stated.

**Text as a fact class.** `find_literals` indexes every string, number and boolean by its decoded
value, so a name inside a quoted string is findable and numbers compare as numbers.

**Prose as a fact class.** `find_comments` searches what was written ABOUT the code: doctrine,
rationale, warnings. Each hit names the symbol the comment is attached to, a run of wrapped line
comments is one fact rather than several, and search runs over normalized text so a sentence broken
across a line break is still one sentence. Indexed files only, so ripgrep still wins an exhaustive
byte audit.

**History.** `file_history`, `co_changed_with`, `symbol_history`. What changes alongside a file is
the strongest signal no reference edge carries.

**Refactoring.** `symbol_source` reads one symbol's exact text by id. Everything that writes runs
inside a transaction: `refactor_start`, then `refactor_replace`, `refactor_insert`,
`refactor_rename`, `refactor_move` and `refactor_track`, ending in `refactor_commit` or
`refactor_revert`, with `refactor_undo` for the newest step and `refactor_status` for what is open.
Text that does not parse never reaches disk, a single blocked site writes nothing at all, and what a
change broke is reported rather than assumed away.

**Knowledge.** `record_answer` stores prose about a symbol, but only prose that cites the facts it
was drawn from. `symbol_facts` hands out those ids, `recall_answer` reads what is stored along with
its health, `knowledge_gaps` lists what is missing or stale, and `invalidate_answer` and
`reaffirm_answer` move an answer between doubted and current. See
[docs/knowledge-layer.md](docs/knowledge-layer.md) for why it refuses what it refuses.

**Housekeeping.** `list_project_stores`, `stop_project_daemon` and `delete_project_store` manage the
indexes this machine holds, across every project.

## Project selection

`register_project` records a codebase once. `bind_project` and `unbind_project` control which of
them the current MCP session queries, and `list_projects` shows each binding name beside its full
root.

Read tools accept a `queries` array. Each item uses that tool's normal fields, and one MCP call can
run several items. The outer `projects` selector applies to every item. Omit it when one project is
bound, pass names for a subset, or pass `[]` for every bound project. Every `refactor_` tool, plus
`record_answer`, `invalidate_answer`, and `reaffirm_answer`, accepts one optional `project` instead
and never fans out.

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
