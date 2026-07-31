# Record API Input Restrictions

This document describes the input validation and wire-encoding policy for record upload and fetch APIs.

It reflects the field-specific validators in `param_restrictions.ts`, used by `postRecord`,
`bulkPostRecords`, `getRecords`, `deleteRecords`, `getTables`, `getTags` and `getIndexes`.

## Design Goal

User-facing text is never rejected for containing punctuation. Key grammar safety is preserved by
ESCAPING on the wire instead, so lexicographic query logic keeps working while the caller gets back
exactly the string they wrote.

## Key-segment escaping

Records are stored under composite DynamoDB keys whose segments are joined by reserved delimiters:

| char | role |
|---|---|
| `/` | path segment separator |
| `!` | tag/anchor delimiter |
| `*` | private-access marker wrapper |
| `#` | internal separator in some packed values (e.g. `<ip>#<unique_id>`) |

The backend REJECTS these characters outright in a key segment (`validate_key_segment` in
`infra/layer/database_interface/python/database_interface.py`). The SDK therefore percent-escapes
them before sending, and unescapes on read:

| char | escaped as |
|---|---|
| `%` | `%25` (escaped FIRST) |
| `/` | `%2F` |
| `!` | `%21` |
| `*` | `%2A` |
| `#` | `%23` |

`%` is escaped first, and escaping is UNCONDITIONAL. Both matter. A decoder cannot tell an escape it
produced from one the caller typed, so if the encoder only ran when a raw delimiter happened to be
present, a tag written as `a%2Fb` would be stored verbatim and read back as `a/b`. Escaping always,
`%` first, is the only form the decode can invert unambiguously.

`􏿿` (`U+10FFFF`, the high sentinel used for lexical range bounds) and control characters are not
escapable and remain hard-rejected in every validated string field.

## Field Matrix

| Field | Max Length | Empty Allowed | Escaped on the wire | Notes |
|---|---:|---:|---|---|
| `table.name` | 256 | No | Yes | Key segment. Limit is measured AFTER escaping. |
| `tags[]` item | 256 | No | Yes | Key segment in tag anchor keys. Limit measured after escaping. |
| `tag` (getRecords filter) | 256 | No | Yes | Same constraints as upload tags. |
| `index.name` (custom) | 256 | No | Yes | Cannot start with `$` (reserved namespace). |
| `index.name` (reserved) | N/A | N/A | N/A | Allowed: `$uploaded`, `$updated`, `$referenced_count`, `$user_id`. |
| `index.value` (string) | 256 | Yes | **No** | Raw both directions. See below. |
| `table` / `tag` / `index` (getTables, getTags, getIndexes filters) | 256 | Yes | Yes | Escaped so the filter matches the stored form. Empty is allowed because empty-plus-condition is the "list everything" idiom. |
| `source.referencing_index_restrictions[].name` | 256 | No | Yes | Same rules as custom `index.name`. |
| `source.referencing_index_restrictions[].value` / `.range` (string) | 256 | Yes | No | Same rules as string `index.value`. |

All lengths are 256, matching the platform (`validate_key_segment`, `max_len=256`). For escaped
fields the limit applies to the ESCAPED string, because that is what the server measures. A 200-char
tag made entirely of `/` expands to 600 characters and is refused, with a message that says so.

## The one case where index.value IS escaped

A "nest" query is one whose `index.name` ends in a period, addressing the children of a compound
index. There `index.value` (and `index.range`) is not a value at all: the backend concatenates it
onto the parent name to rebuild a child index NAME segment. Names are escaped, so these are escaped
too. The same applies to `order.value` on `getIndexes` when `order.by` is `index_name`.

Everywhere else a string `index.value` is raw, as below.

## Why index.value is otherwise the exception

`index.value` is stored RAW in both directions and must stay that way:

1. The platform explicitly permits `/ ! * #` in an index value (`validate_index_string_value` passes
   no `forbidden_chars`), so there is nothing to escape around.
2. Index values are compared lexicographically for `gt` / `gte` / `lt` / `lte` / `range` queries.
   `%2F` sorts nowhere near `/`, so escaping values would silently change the result of every range
   query, including the `>=` "starts with" and `<=` "ends with" forms.

A raw `!` inside a value is already safe: the read path splits the `idx` key on `!`, takes only the
first segment as the index name, and rejoins the remainder as the value.

## Important Behavior Notes

1. `index.value` is stored through typed encoding (`!S%`, `!N%`, `!B%`, etc.) for lexical ordering.
2. `index.name` is concatenated with typed values, so delimiter safety on `index.name` stays strict.
3. Reserved `$...` index names are handled by query logic and are restricted to the known values.
4. This policy does not change `record_id` format checks or UUID checks.
5. Escaping is entirely client-side. The server never escapes and never unescapes, so any non-SDK
   writer must apply the same encoding or its values will read back wrong.
6. Binary FILENAMES are not part of this scheme at all. Nothing percent-encodes them: `uploadFiles`
   sends the key as `<form key>/<file name>` verbatim, and the storage pipeline stores that raw. So
   nothing may percent-DECODE them either, on pain of `decodeURIComponent` throwing `URIError` on a
   name holding a bare `%` and the file vanishing from `record.bin`. `remove_bin` must likewise send
   the url exactly as stored, or the delete matches nothing.
7. The rule that catches all of these: a field is escaped on the way out if and only if it is
   unescaped on the way back. A field that is never escaped must never be decoded. Every historical
   bug here was one half of that pair existing without the other.

## Examples

### Allowed, and round-trip unchanged

- `table.name`: `news/sports`, `Summer Promo: 2026 (v2)`, `100%25off`
- `tags[]`: `vip!*`, `marketing+seo`, `품명 / 수량`, `50% off`
- `index.name` (custom): `campaign.phase`, `user segment`
- `index.value` (string): `A/B test #1 % rollout / blue!green`

`news/sports` travels as `news%2Fsports` and comes back as `news/sports`. A tag typed as the literal
text `a%2Fb` travels as `a%252Fb` and comes back as `a%2Fb`, distinct from a real slash.

### Rejected

- `index.name` (custom): `$custom` (reserved `$` prefix)
- Any validated string containing control characters
- Any validated string containing sentinel `􏿿`
- Any escaped field whose ESCAPED length exceeds 256
