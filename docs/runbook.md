# Runbook (placeholder)

Operational notes accumulate here as phases land (DESIGN.md §11 docs/).

## Phase 0 (scaffold)

- Local CI gate: `npm run ci` (or `make ci`) — typecheck → lint → test.
- Tests are offline; nothing in `npm test` reaches the network.
- Container: `docker compose -f docker/compose.yml up --build` →
  `GET :3000/healthz`.
- Data dir: `/app/data` (volume `app-data`). First-run bootstrap
  (module + catalog sync on empty data dir) arrives with Phase 2 (D20).
- SIGTERM drains with a 5 s bound (placeholder server; §4 formalizes
  30 s for the full engine).

## Planned sections

- Sync pins (bump = PR + module diff report, D9)
- Backup/restore (`sqlite3 .backup` + copy; §9)
- Live smoke suite operation (nightly, opt-in; §13.2)
- Browser profile (§5.11)
