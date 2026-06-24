# Dashboard

Bring infra up first, prepare the demo data, then start the dashboard. The
scripts handle the database connection details.

## 1. Bring Infra Up

```bash
./scripts/infra-up.sh
```

This creates or repairs the AWS pieces: VPC, subnets, route table, security
group, and RDS Postgres. It is safe to rerun. It prints each step and an ETA.

Expected infra timing:

- Existing healthy infra: usually under 2 minutes
- New RDS instance: usually 5-10 minutes

## 2. Prepare Demo Data

```bash
npm install
./scripts/prepare-demo-data.sh
```

`prepare-demo-data.sh`:

- Applies the Prisma schema and dashboard SQL migrations
- Seeds the full demo data when the orders table is empty
- Rebuilds the dashboard read models for fast list and chart results
- Prints an ETA, elapsed time, and table-count summary for each major step

## 3. Start Dashboard On 3004

```bash
npm run dev
```

`npm run dev` starts the combined dashboard backend and UI at
http://localhost:3004.

This equivalent helper also loads the connection details first:

```bash
./scripts/start-dashboard.sh
```

## 4. Start Quick Order On 3005

Quick Order is a separate repo pushed to `bganguly/nextjs-websocket`.

```bash
cd ../wt-quickorder
npm install
BACKEND_URL=http://localhost:3004 npm run dev
```

Open http://localhost:3005.

Creating an order in Quick Order should move the new row to the top of the
dashboard list and refresh the aggregates through SSE.

## 5. Verify Automatically With Playwright

```bash
npm run lint
npm run build
```

With the dashboard running:

```bash
BASE_URL=http://localhost:3004 BACKEND_URL=http://localhost:3004 npx playwright test
```

## 6. Important: Tear Down Infra

```bash
./scripts/infra-down.sh
```

This destroys the AWS resources and removes `.env.rds`.
