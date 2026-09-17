# The Kotlin provider

Where each concept lives, and the rules that hold it. Kotlin's grammar and its repairs are in
`docs/parsing.md`. This file is the provider's own structure.

## The pipeline

`parse.ts` owns the order.

1. `repairs.ts` settles a tree, repairing by error until the least damaged reading wins.
2. `declarations.ts` walks it and answers what the file declares.
3. `environment.ts` turns those declarations into the scopes a use is read against.
4. `references.ts` walks it again and emits the uses. Literals and comments come off the same walk.

Steps 2 to 4 are three walks over one tree. An outline parse stops after step 2, since it answers
no uses, and builds no environment.

`binding.ts` runs later, per query, resolving a use against `packageIndex.ts` in Kotlin's lookup
order. `main.ts` decides when.

## A node carries syntax, never a derived fact

`SyntaxNode` declares exactly what tree-sitter reports, and nothing writes a property onto it. A
fact written onto a shared node is a channel the type system cannot see, and the tree is shared with
the repairs, which reparent and reposition nodes. The declaration walk hands its facts on as a
value instead.

`ScopeEnvironment` in `environment.ts` is that value. It holds:

- the declaration a node spells, and whether that declaration owns the uses inside it;
- the identifiers that name a declaration, which are not uses;
- the import directive a source name spells;
- the names of types the file declares;
- the scope each node opens, its parent already linked.

**Every map is keyed by node identity, never by range.** A wrapper and its identifier can span the
same characters: the `variable_declaration` of a `val x = 1` and its `x` are one range, as are a
lambda parameter's `variable_declaration` and identifier. A range key merges a declaration with its
own name.

It is built once per full parse, before the use walk starts, and read-only after. Every scope rule
lives in it: which nodes open a frame, which receiver a frame carries, where a local becomes
visible, and which frames end a constructor parameter's reach. `references.ts` asks and emits;
`binding.ts` walks the frames it was handed.

`__tests__/node-facts-residue.test.ts` holds the interface to what tree-sitter reports, and refuses
the widening casts that would let a fact back onto the tree. `tsc` refuses the write itself, so the
residue's job is to keep the interface from growing a field under a new spelling.

## Files

| File | Owns |
| --- | --- |
| `tree.ts` | The parse into plain nodes, the line table, and node helpers. |
| `repairs.ts` | The repair order, and every reread of a masked copy. |
| `parse.ts` | The pipeline, and the outline cut. |
| `declarations.ts` | Which Kotlin nodes declare what, and the scope handed to their children. |
| `declarationSink.ts` | The one minter of symbol ids, and every fact a declaration answers with. |
| `declarationShape.ts` | Context, visibility, modifiers, and the signature spans. |
| `headers.ts` | The package header and the import directives. |
| `typePaths.ts` | A written type's segments, and a class's supertypes. |
| `literals.ts` | Decoding a literal to its value and its Kotlin type. |
| `metrics.ts` | Nesting and branch counts inside a body. |
| `environment.ts` | The scopes, receivers and declarations a use is read against. |
| `references.ts` | Uses, literals and comments. |
| `binding.ts` | Kotlin's lookup order over the package index. |
| `packageIndex.ts` | Cross-file lookup, accessibility, and import resolution. |
| `diagnostics.ts` | What damage refuses a file and what merely warns. |
| `render.ts` | Signature text from a span of nodes. |
| `main.ts` | The provider surface and the module lifecycle. |
