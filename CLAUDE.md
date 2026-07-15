# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js/Express web app for daily monitoring of multiple Oracle databases (e.g. AWR/health checks: instance status, tablespace usage, long sessions, RMAN backups, alert logs, etc.). It maintains a registry of target DBMS connections and a library of reusable SQL "monitoring tasks," and lets a user run any task against any registered DB from the browser.

## Running the app

```
npm install
node server.js
```

There is no build step, bundler, or test suite (`npm test` is a placeholder that exits with an error). There is no linter configured. Verify changes by running the server and exercising the affected page/API in a browser.

The server binds to a hardcoded host/port in `server.js` (`172.28.117.30:3000`), not `localhost` — when running locally, either edit that constant or hit the app via that specific address.

## Architecture

**Two-database model** — this is the key thing to understand before touching `models/dbmsModel.js` or `services/dbmsService.js`:
1. A **metadata/control DB** (`config/database.js`, env vars `NODE_ORACLEDB_*`) stores the app's own tables: `system.monitoring_dbms_list` (registered target databases + credentials) and `system.monitoring_tasks` (reusable SQL checks, keyed by id, with a CLOB `sql_text`). This connection uses a pooled connection (`initializeDB()` in `db.js`).
2. **Target DBs** — the actual databases being monitored — are connected to on demand, per request, using credentials looked up from `monitoring_dbms_list` (`getDbmsInfo`) and a fresh single connection (`connectDB()` in `db.js`, not pooled).

So `dbmsService.getMonResult(dbmsid)` works like this: look up the target DB's connection info from the metadata DB → load all active monitoring tasks (`SYSTEM.MONITORING_TASKS` where `is_active = 'Y'`) → for each task, open a connection to the target DB and run its `sql_text` → collect columns/rows per task. There's a special-case skip: tasks whose SQL references `ogg_discard_log` are skipped for DBs whose memo field contains `'VAN'`.

**Layering** (classic Express MVC-ish, no framework beyond that):
- `server.js` — Express app setup, Oracle Instant Client thick-mode init, static file serving of `public/`, mounts `routers/dbmsRouters.js` at both `/main` and `/api`.
- `routers/dbmsRouters.js` — route → controller mapping only.
- `controllers/dbmsController.js` — HTTP request/response handling, input validation, calls services. No SQL or business logic here.
- `services/dbmsService.js` — business logic layer (e.g. the two-DB orchestration in `getMonResult` described above). Calls models.
- `models/dbmsModel.js` — all Oracle DB access (`oracledb` calls, `connection.execute`, connection pool/lifecycle). `executeQuery()` is the shared helper that runs a query and converts CLOB columns to strings via `models/clobUtils.js`.
- `queries/` — a plain object of named SQL strings (`queries/dailyChecks.js`, re-exported via `queries/index.js`). These are Oracle dictionary/AWR-style diagnostic queries (`v$session`, `dba_tablespaces`, `v$rman_status`, etc.), independent of the `monitoring_tasks` DB table — some may overlap conceptually with tasks stored in the DB but this file is a static reference set, not the live source of task SQL.
- `public/` — plain HTML + vanilla JS pages (no frontend framework/bundler), one HTML file per screen (`index.html`, `addDbms.html`, `modifyDbms.html`, `addScript.html`, `modifyScript.html`, `dailyMonitoring.html`, `monitoringScript.html`, `showMonitor.html`) each paired with inline or sibling `.js` for `fetch()` calls to the `/api` routes.

**Oracle client**: uses `oracledb` in thick mode, initialized against the bundled `instantclient_19_25/` directory (relative path `./instantclient_19_25`, so the process must be started from the repo root). Both `server.js` and `db.js` call `initOracleClient` independently.

**Database credentials**: `config/database.js` reads `NODE_ORACLEDB_USER` / `NODE_ORACLEDB_PASSWORD` / `NODE_ORACLEDB_CONNECTIONSTRING` / `NODE_ORACLEDB_EXTERNALAUTH` env vars, falling back to hardcoded defaults checked into the file. Per-target-DB credentials (for monitored databases, as opposed to the metadata DB) are stored in plaintext in the `system.monitoring_dbms_list` table and returned directly to callers as positional array elements (`dbconfig[0]`..`dbconfig[5]` = username, password, ip, port, sid, memo) — be careful with ordering if touching `getDbmsInfo`/`getMonResult` in `models/dbmsModel.js`.

## Notable repo state

- `node_modules/` and `instantclient_19_25/` (Oracle Instant Client binaries) are committed directly to git — there is no `.gitignore`. Don't try to "clean up" by deleting/ignoring them without checking with the user first.
- The repo root also contains ad hoc SQL scripts (`TABLE_DBMS_LIST.sql` — DDL for `monitoring_dbms_list`/`monitoring_tasks`/`monitoring_thresholds`, `STATS_JOB.sql`, `monitoring_queries_insert.sql`, parfile-generation scripts) and unrelated report/export artifacts (xlsx, pptx, pdf, docx, zip/7z) that are not part of the application runtime.
- Code comments and log messages are primarily in Korean; several `console.log`/`console.error` calls print full request payloads (including passwords in `addDbms`/`modifyDbms` flows) — be mindful of this when reasoning about logs, and avoid adding more sensitive data to log output.
