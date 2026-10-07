# Vendored MCP server.json schema

`server.schema.json` is a byte-for-byte copy of the official MCP Registry
schema for `server.json`, vendored so the tests validate `../server.json`
without a network fetch.

| | |
|---|---|
| Source | https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json |
| Published by | [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry) (`docs/reference/server-json/CHANGELOG.md`: 2025-12-11 is the current released version) |
| Fetched | 2026-10-06 |
| SHA-256 (LF line endings, as served) | `3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0` |

Do not edit or reformat it. `src/server-json.test.ts` checks the hash, so a
change here fails the suite until the hash is updated with it.

To move to a newer schema: download the new version, replace this file, update
the URL, date and hash above and in `src/server-json.test.ts`, and set
`$schema` in `../server.json` to the new `$id`.
