# Dashboard Workspace

This repository uses Git worktrees for the main dashboard pieces. To demo the
full flow, run the services from sibling directories under `grouped-projects`.

## Pieces

| Piece | Directory | Branch / repo | Port | Purpose |
| --- | --- | --- | --- | --- |
| Backend API | `../wt-backend` | `feature/service-layer` | `3004` | Orders, aggregates, SSE stream |
| Dashboard UI | `../wt-frontend` | `feature/frontend-ui` | `3003` | Search table, chart, filters, live feed |
| Test suite | `../wt-testing` | `feature/testing-setup` | n/a | Playwright coverage/perf checks |
| Quick order | `../wt-quickorder` | standalone `main` repo | `3005` | Create an order and trigger dashboard reload |

Current demo commits:

- `wt-backend`: `5629796 list+charts paint acceptable`
- `wt-frontend`: `54668a2 list+charts paint acceptable`
- `wt-testing`: `64ffae3 list+charts paint acceptable`
- `wt-quickorder`: `60e4d47 list+charts paint acceptable`

## Run

From separate terminals:

```bash
cd ../wt-backend
npm run dev
```

```bash
cd ../wt-frontend
npm run dev
```

```bash
cd ../wt-quickorder
npm run dev
```

Open:

- Dashboard: http://localhost:3003
- Quick order: http://localhost:3005

`wt-frontend` and `wt-quickorder` proxy `/api/*` to the backend at
`http://localhost:3004` by default. Override with `BACKEND_URL` if needed.

## Verify

```bash
cd ../wt-backend && npm run lint
cd ../wt-frontend && npm run lint
cd ../wt-quickorder && npm run lint
```

Playwright:

```bash
cd ../wt-testing
BASE_URL=http://localhost:3003 BACKEND_URL=http://localhost:3004 npx playwright test
```

