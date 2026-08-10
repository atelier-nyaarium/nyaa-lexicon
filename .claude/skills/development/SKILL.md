---
name: development
description: How to build, test, and verify changes in nyaa-lexicon. Load before editing anything here.
---

# Developing nyaa-lexicon

The gate, the runtimes, the release ritual and the rules that already cost something all live in
`CLAUDE.md`, which is loaded for this project anyway. Read its Development, Verifying a change, and
Rules sections rather than a second copy here, because two copies of a command list drift and the
drift is silent.

What this skill adds is the order to work in.

## Before editing

Know which side of the runtime split you are on. Anything reachable from an entrypoint or the
daemon must run on node, because that is what ships. Anything touching the store cannot run under
`bun run` at all.

## While editing

One tree, one owner. Providers own their own `providers/<language>/` subtree and nothing else; a
change needed elsewhere gets reported rather than made, since agents share a working tree.

## Before claiming it works

Run the gate, then prove it against something real. A green gate says the code compiles and the
tests you already wrote still pass. It does not say the behavior is right, and this repository has
shipped defects through a clean gate more than once.

Say "attempting" until you have watched it work.
