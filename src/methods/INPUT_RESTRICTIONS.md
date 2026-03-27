# Record API Input Restrictions

This document describes the current input validation policy for record upload and fetch APIs.

It reflects the field-specific validators used by:
- `postRecord`
- `bulkPostRecords`
- `getRecords`

## Design Goal

Validation is intentionally looser for user-facing text while preserving key grammar safety for lexicographic query logic.

Reserved delimiters that must remain blocked in key-segment fields:
- `/` (path segment separator)
- `!` (tag/anchor delimiter)
- `*` (private-access marker wrapper)
- `#` (internal separators in some packed values)
- `􏿿` (high sentinel used for lexical range bounds)

Control characters are blocked for all validated string fields.

## Field Matrix

| Field | Max Length | Empty Allowed | Blocked Characters | Notes |
|---|---:|---:|---|---|
| `table.name` | 128 | No | `/ ! * #` + control chars + `􏿿` | Used as key segment in composite keys. |
| `tags[]` item | 64 | No | `/ ! * #` + control chars + `􏿿` | Used in tag anchor key patterns. |
| `tag` (getRecords filter) | 64 | No | `/ ! * #` + control chars + `􏿿` | Same constraints as upload tags. |
| `index.name` (custom) | 128 | No | `/ ! * #` + control chars + `􏿿` | Also cannot start with `$` (reserved namespace). |
| `index.name` (reserved) | N/A | N/A | N/A | Allowed values: `$uploaded`, `$updated`, `$referenced_count`, `$user_id`. |
| `index.value` (string) | 256 | Yes | control chars + `􏿿` | Much looser: punctuation such as `%`, `/`, `!`, `*`, `#` is allowed for string values. |
| `source.referencing_index_restrictions[].name` | 128 | No | `/ ! * #` + control chars + `􏿿` | Uses same rules as custom `index.name`. |
| `source.referencing_index_restrictions[].value` (string) | 256 | Yes | control chars + `􏿿` | Uses same rules as string `index.value`. |
| `source.referencing_index_restrictions[].range` (string) | 256 | Yes | control chars + `􏿿` | Uses same rules as string `index.value`. |

## Important Behavior Notes

1. `index.value` is stored through typed encoding (`!S%`, `!N%`, `!B%`, etc.) for lexical ordering.
2. `index.name` is concatenated with typed values, so delimiter safety on `index.name` remains strict.
3. Reserved `$...` index names are handled by query logic and are intentionally restricted to known values.
4. This policy does not change `record_id` format checks or UUID checks.

## Examples

### Allowed examples

- `table.name`: `Summer Promo: 2026 (v2)`
- `tags[]`: `marketing+seo`, `Q2 Launch`
- `index.name` (custom): `campaign.phase`, `user segment`
- `index.value` (string): `A/B test #1 % rollout / blue!green`

### Rejected examples

- `table.name`: `news/sports` (contains `/`)
- `tags[]`: `vip!*` (contains `!` and `*`)
- `index.name` (custom): `$custom` (reserved `$` prefix)
- Any validated string containing control characters
- Any validated string containing sentinel `􏿿`