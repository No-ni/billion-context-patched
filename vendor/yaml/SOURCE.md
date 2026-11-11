# YAML runtime

Node runtime files from `yaml` 2.9.1, under the ISC license in
`LICENSE`. This is the same parser version bundled with the audited DSH NEXT
settings service on 2026-11-11. Source project: https://github.com/eemeli/yaml.

Only `package.json`, `LICENSE`, and the JavaScript files in `dist/` are needed
here. Bundling them keeps the standalone installer and plugin runtime on one
parser without an extra install step or a separate plugin dependency.

One trailing space in `dist/doc/Document.js` was removed to pass this repository's
whitespace check. All other imported files are byte-for-byte unchanged; this is
the only local change and does not change parser behavior.
