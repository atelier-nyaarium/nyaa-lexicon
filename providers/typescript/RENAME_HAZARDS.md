# TypeScript rename hazards

The TypeScript provider implements `renameEdits` with checker bindings and AST-based rewrites. This
table records its current policy. `Implemented` means the listed rewrite is supported. `Partial`
means only the stated subset is supported. `Unsupported` means edits are refused for that form.

The language service identifies bound references and checker declarations. The AST selects safe edit
spans for each syntactic form.

| Construct | Status | Edit policy | Checker evidence and syntax rule |
| --- | --- | --- | --- |
| `import { foo as bar }` | Implemented | Different replacement for the imported name. Plain replacement for the local name. | The import specifier has separate `propertyName` (`foo`) and `name` (`bar`) nodes. Renaming the imported `foo` changes only the specifier and leaves uses of local `bar` unchanged. Renaming `bar` changes the local binding and its references. |
| `export { foo } from "./m"` at a stop (`keep`) | Implemented | Replace with `export { newName as foo } from "./m"`. | The same token names the source and exported name. The alias keeps the barrel's exported name stable. |
| `import { foo } from "./m"` at a local re-export stop (`keep`) | Implemented | Replace with `import { newName as foo } from "./m"`. | The local binding, its uses, and `export { foo }` keep their names. Only the imported source name changes. |
| `newName as foo` renamed back to `foo` | Implemented | Remove the redundant alias and keep any `type` modifier. | The source name and alias then match, so the specifier can use one name. |
| A kept site outside an import or export source name | Unsupported | Refuse with `NotImplemented`. | Only a specifier source name can add an alias while preserving the old name. |
| `export { foo as default }` | Partial | Rename local `foo`; refuse renaming the fixed `default` export slot. | The local `propertyName` and exported `name` are distinct. `default` is not a renameable local identifier. |
| `export * as ns` | Partial | Rename `ns`; refuse renaming the wildcard's underlying members through this span. | `ns` is a distinct namespace export name. The wildcard does not select one symbol to rename. |
| Object shorthand `{ foo }` | Implemented | Expand to `{ foo: newName }` when `foo` is the value reference and the property key must stay stable. | One written name serves as both value and key. The AST supplies the expanded property span. |
| Destructuring shorthand `const { foo } = value` | Implemented | Expand to `{ foo: newName }` when renaming the local binding. | The binding is the local value symbol; the implicit property key stays `foo`. |
| String property access `value["foo"]` | Unsupported | Refuse by default. | A string key is not a bound identifier reference, and the checker does not prove that every such access names the same property contract. |
| JSX element names `<Foo />` and `</Foo>` | Partial | Replace only when casing keeps the same JSX meaning; refuse casing changes. | The AST identifies opening and closing tags, intrinsic names, and member tags. A casing change can turn a component into an intrinsic element. |
| Declaration merging | Partial | Rename every declaration and reference when the merged symbol is one closed unit; otherwise refuse. | `symbol.declarations` and `findReferences` expose declarations and references. The AST locates every declaration name span. |
| Same spelling in the type and value namespaces | Implemented | Rename references bound to the selected symbol; collision checks use each site's type or value meaning. | Checker bindings distinguish type and value uses that share text. |
| A value and a type merged under one name, with one meaning renamed | Partial | Rename the selected meaning; refuse when one specifier binds both meanings. | A namespace member, type position, or type-only edge selects one meaning. A shared specifier cannot change one token without dropping the other meaning. |
| The new name already bound or exported | Partial | Allow an alias of the renamed symbol or a disjoint meaning declared in the same scope; refuse other collisions. | The checker resolves aliases and meanings. Scope resolution detects captures, and export checks account for declarations in the same module. |
| Private class fields `#name` versus public `name` | Implemented | Rename `#name` as `#newName`; leave public `name` untouched. | Private identifiers are distinct from public identifiers, and the AST supplies the hash-bearing span. |
| Module augmentation and ambient declarations | Unsupported | Refuse by default. | These declarations can describe external APIs or merge with symbols outside the workspace. |
| Named default declarations `export default function foo()` | Partial | Rename `foo`; refuse anonymous default declarations. | The local name is distinct from the fixed `default` marker. An anonymous default has no declaration span to rename. |
| Overloaded declarations | Partial | Rename every overload signature, implementation declaration, and reference when the symbol is closed; otherwise refuse. | The checker exposes the overload declarations as one symbol, and the AST locates each name span. |

The core planner gathers rename sites from indexed bindings and proved routes, then reports unresolved
coverage as blockers or warnings. The TypeScript provider receives those sites and applies
syntax-specific edits or refusals; it does not establish that the site list is complete.
