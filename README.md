# Dashboard

Start by bringing the AWS database infra up. The app expects a Postgres
`DATABASE_URL`, and `infra-up.sh` is the standard way to create, repair, or find
that database.

Important: `infra-up.sh` only creates or reconnects the AWS infrastructure. It
does not populate millions of orders or rebuild the token/read-model tables. For
the full demo experience, use an already-populated database. If the existing RDS
database is intact, bringing infra up and starting `3004` should make the
dashboard work immediately. Quick Order on `3005` is the only separate app that
may still need to be started.

## 1. Bring Infra Up

```bash
./scripts/infra-up.sh
```

The script is safe to rerun. Terraform creates missing resources, updates changed
resources, and leaves existing healthy resources alone.

It prints each step with an ETA:

- dependency checks
- public IP detection for the RDS security group
- `terraform init`
- VPC, subnet, route table, security group, and RDS Postgres apply
- `.env.rds` generation
- Quick Order `3005` availability check

Typical timing:

- Existing healthy infra: under 2 minutes
- New RDS instance: 5-10 minutes
- Infra destroy: 5-10 minutes

Data timing:

- Existing populated RDS database: no backfill should be needed
- Fresh empty RDS database: schema creation is quick, but large seed/read-model
  population can take hours
- Token summaries, category facts, and aggregate read models are required for
  the sub-second search/chart behavior demonstrated here

## 2. Find `DATABASE_URL`

After infra is up, the generated value is stored in `.env.rds`.

Print the active database URL:

```bash
./scripts/database-url.sh
```

Load it into your current shell:

```bash
source .env.rds
```

If `.env.rds` is missing, run:

```bash
./scripts/infra-up.sh
```

## 3. Prepare Or Reuse The Database

```bash
npm install
DATABASE_URL="$DATABASE_URL" npx prisma db push
```

For an already-populated RDS database, stop here and start the dashboard.

Only seed a new empty database when you intentionally want to rebuild the demo
data from scratch. This is not a quick infra step; large data and read-model
population can take hours.

```bash
DATABASE_URL="$DATABASE_URL" npx tsx scripts/seed.ts
```

For very large local/RDS data sets, the repo also contains lower-level SQL and
backfill helpers such as:

```bash
psql "$DATABASE_URL" -v orders=4000000 -f scripts/seed-large.sql
DATABASE_URL="$DATABASE_URL" npx tsx scripts/backfill-visible-token-category-summary.ts
```

Use those only when rebuilding the large benchmark dataset deliberately.

## 4. Start Dashboard

```bash
DATABASE_URL="$DATABASE_URL" npm run dev
```

Open http://localhost:3004.

## 5. Start Quick Order

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

Run Playwright after the dashboard is active:

```bash
BASE_URL=http://localhost:3004 BACKEND_URL=http://localhost:3004 npx playwright test
```

## Tear Down Infra

Destroy AWS resources and stop RDS billing:

```bash
./scripts/infra-down.sh
```

This removes the RDS instance and networking resources, then deletes `.env.rds`.

## Branches

- `develop`: default integration branch on GitHub
- `main`: release/stable branch
