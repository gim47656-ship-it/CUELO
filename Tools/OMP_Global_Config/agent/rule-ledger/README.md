# Rule Ledger

`rule-ledger` tracks dated rule decisions, incidents, and provenance across agent instructions. `check.mjs` is a read-only checker using Node.js built-ins only. It reads `../AGENTS.md`, `../RULES.md`, and `../rules/*.md` relative to the script directory (not `cwd`) and validates them against `ledger.json` (a JSON array).

## Usage

```sh
node check.mjs [--strict] [--json]
```

- **Default (`node check.mjs`)**: Prints a summary and any `due`, `unledgered`, `stale`, or `unresolved` entries; exits `0` even when findings exist.
- **`--strict`**: Exits `1` only if `unledgered` or `stale` entries are found.
- **`--json`**: Outputs a machine-readable report containing `today`, `counts` (`sources`, `totalDecisions`, `ledger`, `due`, `unledgered`, `stale`, `unresolved`), and full `due`, `unledgered`, `stale`, and `unresolved` entry arrays.
- **Invalid input** (unknown flags, invalid dates, malformed or duplicate ledger entries): Exits `2`.

## Record Schema

Each entry in `ledger.json` contains:

- **`id`**: `SHA256(file + "\n" + normalize(quote))` using NFC and whitespace normalization.
- **`file`**: Path relative to the agent root.
- **`line` / `endLine`**: Human locator only; not part of record identity.
- **`quote`**: Bounded verbatim, whitespace-normalized excerpt (<=230 characters).
- **`decisionDate`**: Source date (`YYYY-MM-DD`).
- **`entryType`**: `decision` (explicit user attribution, including `사용자 명시` instructions and `사용자가` correction verbs), `incident` (dated audit/failure in the date's bounded sentence context), or `other` (conservative date provenance), classified using sentence, table-cell and neighboring-date bounded local attribution.
- **`kind`**: `mechanical` when the local sentence or enforcement table's evidence cell (not the whole block) names enforcing extensions, tools, patches, or plugins (recorded in `enforcement` with `name` and `source` citation), or `prose` otherwise (including when explicit document-only caveats are present). This is conservative lexical metadata, not an independent enforcement audit (partial or advisory enforcement is possible).
- **`motivatingFailure`**: Explicit concrete `doc/history/...` path in the same context, or `미상`.
- **`modelAtDecision`**: Explicit `modelAtDecision` / `당시 모델` marker when unique in the same block, or `미상` otherwise (a policy target model is not evidence).
- **`retestAfter`**: Defaults to UTC calendar `decisionDate` + 90 days.
- **`status`**: `active` initially; manually set to `retired` only after evidence.

## Extraction & Identity

Extraction is a deterministic, conservative superset:

- Scans each date-bearing provenance mention in Markdown paragraphs, list items, headings, and table rows, joining continuation lines.
- Full dates (`YYYY-MM-DD`) and shortened `MM-DD` resolve their year from earlier full dates in the same block, otherwise an explicit `doc/history` record-path year (when unique), then a unique full provenance year in the same source file; unresolved or conflicting missing years are surfaced in `unresolved` (and `counts.unresolved`) without inventing a ledger date. Same-day user attribution (`같은 날`) still requires a preceding dated mention in the same block.
- Omits frontmatter, fenced code examples, paths/URLs, and explicit external version dates ending in `판` (or `version`/`release`).
- Does not assume semantic certainty about all dates, and current candidates must not be presented as proven obsolete.
- Deduplicates by `file + quote`. Whitespace or line-number changes preserve identity; editing a quote produces a new `id` and marks the removed quote as `stale` (`stale` means an entry `id` is no longer extracted from active source blocks—code examples, frontmatter, and changed quote context no longer count as live rules).

## Updating the Ledger

Import `extractDecisions` and `readSources` from `check.mjs` to generate candidate entries. Review candidates and merge new `id`s into `ledger.json` while preserving existing `status` and `retestAfter` metadata. Do not blindly overwrite `ledger.json`.

## Retirement & Re-testing

- **Never retire automatically** based on `retestAfter`.
- Locate the actual motivating failure; if unknown, document it first.
- Replay the motivating scenario through the existing regression runner with and without the rule on the same model version and inputs, recording the outcome, failures, model, and evidence.
- Retire only with approval and a comparison showing no lost required behavior, while preserving mechanical protections.
- Update `status` and evidence manually (do not modify source files automatically).
- For re-tests that retain a rule, update `retestAfter` and provenance manually; `check.mjs` never rewrites `ledger.json`.

## Tests

```sh
node --test check.test.mjs
```
