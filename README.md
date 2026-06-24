# Dashboard

Bring infra up first, then start the dashboard. The scripts handle the database
URL discovery so you do not have to copy/paste `DATABASE_URL`.

## 1. Bring Infra Up

```bash
./scripts/infra-up.sh
```

This creates or repairs the AWS pieces: VPC, subnets, route table, security
group, and RDS Postgres. It is safe to rerun. It prints each step and an ETA.

Expected infra timing:

- Existing healthy infra: usually under 2 minutes
- New RDS instance: usually 5-10 minutes
- Destroying RDS: usually 5-10 minutes

The full demo data and read models are expected to already exist in the RDS
database. Rebuilding millions of orders, token summaries, category facts, and
aggregate read models is a separate long-running data job, not part of normal
infra startup.

## 2. Start Dashboard On 3004

```bash
npm install
./scripts/start-dashboard.sh
```

`start-dashboard.sh`:

- Finds the database URL using `scripts/database-url.sh`
- Exports it for the process
- Applies the Prisma schema
- Starts the dashboard at http://localhost:3004

If you only want to print the database URL:

```bash
./scripts/database-url.sh
```

## 3. Start Quick Order On 3005

Quick Order is a separate repo pushed to `bganguly/nextjs-websocket`.

```bash
cd ../wt-quickorder
npm install
BACKEND_URL=http://localhost:3004 npm run dev
```

Open http://localhost:3005.

Creating an order in Quick Order should move the new row to the top of the
dashboard list and refresh the aggregates through SSE.

## Verify

```bash
npm run lint
npm run build
```

With the dashboard running:

```bash
BASE_URL=http://localhost:3004 BACKEND_URL=http://localhost:3004 npx playwright test
```

## Tear Down Infra

```bash
./scripts/infra-down.sh
```

This destroys the AWS resources and removes `.env.rds`.

## Branches

- `develop`: default integration branch on GitHub
- `main`: release/stable branch
