// Format readers shared by the providers that meet them.
//
// Import the reader you use, not this barrel: `@nyaa-lexicon/formats/yaml` and `.../json` are
// subpaths for that reason. Through here a consumer bundles every format's dependencies, which is
// how the YAML provider once carried jsonc-parser and died on node over a package it never calls.

export { type JsonContext, type JsonFacts, readJson } from "./json.js";
export { readYaml, readYamlComments, type YamlContext, type YamlFacts } from "./yaml.js";
