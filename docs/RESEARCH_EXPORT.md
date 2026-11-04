# Research history export

A read-only HTTP API for copying OpenSEO's stored research history into a warehouse (BigQuery, Snowflake, a data lake). It returns stored rows only and never calls a data provider, so it costs no credits.

## Authentication

| Deployment mode                     | Key                                                                                                                                                                         | Header                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `password`, `hosted`                | An API key from Settings (`oseo_...`). It reads the organization it was created in.                                                                                         | `x-api-key: oseo_...` or `Authorization: Bearer oseo_...` |
| `local_noauth`, `cloudflare_access` | `OPENSEO_EXPORT_KEY`, a random value of 32 or more characters set in the deployment's environment. It reads the deployment's one workspace. Unset, the export is off (404). | `x-api-key` only                                          |

In `local_noauth` and `cloudflare_access` the export always needs the key, even though the app itself has no sign-in. Send it as `x-api-key`, because a reverse proxy's basic auth or Cloudflare Access may use the `Authorization` header.

Docker standalone: put `OPENSEO_EXPORT_KEY` in `.env` and restart. Cloudflare self-host: put it in `.env.selfhost` and redeploy.

## Endpoints

All are `GET`.

- `/api/export/projects`: the organization's projects (`id`, `name`, `domain`, `created_at`, `archived_at`), as NDJSON.
- `/api/export/{table}?projectId=&since=&limit=`: one page of a table for one project, as NDJSON.
- `/api/export/deletions?projectId=&since=&limit=`: one page of the project's deletes from those tables, as NDJSON (see [Deletes](#deletes)).
- `/api/export/research_archive_entries/{id}/payload?projectId=`: the full JSON result of one archived lookup.

Tables:

| Table                       | One row per                                                    | Key    |
| --------------------------- | -------------------------------------------------------------- | ------ |
| `domain_snapshots`          | domain, market and day                                         | `id`   |
| `domain_backlink_snapshots` | domain, subdomain scope and day                                | `id`   |
| `keyword_metric_snapshots`  | keyword, market and day                                        | `id`   |
| `gsc_daily_totals`          | Search Console day                                             | `date` |
| `gsc_daily_rows`            | Search Console query or page and day                           | `id`   |
| `research_archive_entries`  | archived lookup (metadata; `payload_path` links the full JSON) | `id`   |

## Pages and cursors

Each line of a page is one row, with the table's column names. Rows come oldest write first, ordered by `written_at` and then the table's key.

- `limit` is 1 to 5000 (default 1000).
- The `X-Next-Cursor` response header is the position after the page's last row. Pass it back as `since` to read on. On an empty page it repeats the `since` you sent, so it can always be stored.
- `X-Has-More: true` means another page is ready now.
- Omit `since` to start from the beginning.

`written_at` is when OpenSEO last wrote the row. It is not `captured_at` or `fetched_at`, which keep the provider's fetch time even when the row was written later from a cached result. A day that is captured again replaces its row and gives it a new `written_at`, so the row comes back in a later page. Keep the copy with the latest `written_at` for each natural key (for example project, keyword, market and `captured_on`).

A row appears in the export five minutes after it is written, so a write still in progress can never land behind a cursor you already hold.

## Deletes

OpenSEO deletes exported rows in these cases, and lists each delete in `/api/export/deletions` so a warehouse copy can follow:

| When                                                          | Tables and scope                                                                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Search Console is disconnected, or its Google account removed | `gsc_daily_totals` and `gsc_daily_rows` with `{"all": true}`; `research_archive_entries` (URL inspections) with `{"ids": [...]}` |
| GA4 is disconnected, or its Google account removed            | `research_archive_entries` (GA4 landing-page reports) with `{"ids": [...]}`                                                      |
| Archive retention (entries older than 13 months)              | `research_archive_entries` with `{"ids": [...]}`                                                                                 |
| Snapshot retention (snapshots older than 13 months)           | `domain_snapshots`, `domain_backlink_snapshots`, `keyword_metric_snapshots` with `{"before": "YYYY-MM-DD"}`                      |

Each line has `id`, `project_id`, `table_name`, `scope` and `written_at`, the time of the delete. `scope` says which of the project's rows in `table_name` went:

- `{"all": true}`: every row.
- `{"before": "YYYY-MM-DD"}`: rows whose `captured_on` is before that day.
- `{"ids": [...]}`: rows with those keys. A large delete is split over several lines.

Apply a delete only to rows whose `written_at` is at or before the delete's `written_at`: rows written later (for example after Search Console is connected again) are newer data and stay. Deletes page exactly like the tables: oldest first, `X-Next-Cursor` passed back as `since`, five minutes after the delete. They are kept, so a consumer that falls behind still sees every one.

A deleted project is not listed here: it drops out of `/api/export/projects`, and its rows and deletes go with it. Treat a project that disappears from that list as erased and delete everything you hold for it.
