# Dashboard

This repo now contains the merged dashboard stack on `main`: backend API routes,
the dashboard UI, and the Playwright/perf test setup.

## Run the dashboard

```bash
npm install
npm run dev
```

Open http://localhost:3004.

The dashboard serves the UI and API from the same Next app. If you deliberately
run the API somewhere else, set `BACKEND_URL` and the app will proxy `/api/*` to
that backend.

## Run quick order

Quick order is a separate repo pushed to `bganguly/nextjs-websocket`.

```bash
cd ../wt-quickorder
npm install
npm run dev
```

Open http://localhost:3005.

## Verify

```bash
npm run lint
npx playwright test
```

Playwright uses `BASE_URL=http://localhost:3004` by default.

## Merged dashboard branches

- `feature/service-layer`
- `feature/frontend-ui`
- `feature/testing-setup`

The old worktree branches are still useful as history, but a developer can demo
the full dashboard functionality from this repo's `main`.
