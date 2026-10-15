# formats

Shared readers for data formats used by providers. Import a reader through its subpath export; there
is no package root export.

Current exports are `./yaml`, `./json`, `./xml`, `./html`, `./text`, and `./compile-commands`.
Markdown frontmatter and YAML files use the same YAML reader.

Reader context is data. Never branch on a language in `formats/`; the residue test enforces this.
Source ranges must refer to the original file, including any supplied offset and coordinate map.

Choose parsers by `docs/parsing.md`.
