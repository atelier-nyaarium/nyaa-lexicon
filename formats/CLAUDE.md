# formats

One reading of a data format, for every provider that meets the same one. Markdown frontmatter and a
`.yml` file are the same mapping in the same syntax, so `readYaml` answers both. A second reader
would be a second opinion, and the two would drift on the first edge case only one of them saw.

## Import the reader you read

There is no root export, only `./yaml`, `./json`, `./xml`, `./html` and `./text`. The bare package name does
not resolve, and that is deliberate: a barrel makes every consumer carry every format's parser, so a
provider dies at load over a package it never calls.

## Context is DATA, never a language to branch on

A reader takes the language slug, the module, the offset its text sits at, and the coordinate map. It
never compares that slug against anything. This is the one place outside `core/` where the
never-branch rule could plausibly be bent, so the same residue test sweeps here.

## An offset means the text is a slice

Frontmatter starts partway into a markdown file, and a JSONL record starts partway into its file.
Every range a reader produces addresses the FILE, so the offset is added on the way out and the
coordinate map belongs to the whole file, never to the slice.

## What a reader owes its caller

- A range that slices its own text back out of the file. The conformance suite checks every span.
- A diagnostic instead of a throw. A file's own shape is never the caller's error: `isTooDeep` in
  `depth.ts` is the single owner of recognizing a recursion limit, and every recursion site rethrows
  what it does not recognize rather than reporting a real bug as a depth problem.
- One declaration per symbol id. A repeated key, and a sequence sibling, both mint one path twice;
  the store's primary key would silently keep whichever arrived last.
- A reason when a key is dropped, worded by `dropped.ts` rather than by each reader, so the same
  situation cannot read two ways. Core keeps `warning` and `info` as notes on the file, shown by
  `outline_module`, so a reader's reason reaches the reader.
- Everything the text holds, whatever dialect the extension names. A comment in a `.json` is read
  and noted at `info`, never refused: the tool exists to learn a codebase, not to judge one, and a
  refused file is a file nobody can ask about.

Parser selection is `docs/parsing.md` rule 1.
