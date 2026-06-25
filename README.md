# Dashboard

📺 **Walkthrough video:** https://youtu.be/JcnuVLNKEm0

Bring infra up first, prepare the demo data, then start the dashboard. The
scripts handle the database connection details.

## 1. Bring Infra Up

```bash
./scripts/infra-up.sh
```

This creates or repairs the AWS pieces: VPC, subnets, route table, security
group, and RDS Postgres. It is safe to rerun. It prints each step and an ETA.
It also clears stale dashboard-named RDS leftovers before recreating infra.

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

Expected demo-data timing on the default `db.m5.xlarge` RDS instance:

- Order seed: progress prints every 500,000-row batch
- Order-item seed: similar batch progress after orders finish
- Full prepare run: usually about 12-20 minutes end to end

You can change seed batch size for more or fewer progress updates:

```bash
SEED_BATCH_SIZE=1000000 ./scripts/prepare-demo-data.sh
```

### Fast path: restore from a pre-baked snapshot (maintainer only)

Seeding + rebuilding takes ~15-20 minutes. To make demos quick, a maintainer can
bake the prepared database into a `pg_dump` snapshot stored in a **private** S3
object (Standard-IA) under their own AWS credentials:

```bash
DEMO_SNAPSHOT_S3_URI=s3://my-private-bucket/dash/demo.dump ./scripts/bake-demo-snapshot.sh
```

On later runs, set the same variable and `prepare-demo-data.sh` will `pg_restore`
from it in a few minutes instead of re-seeding:

```bash
DEMO_SNAPSHOT_S3_URI=s3://my-private-bucket/dash/demo.dump ./scripts/prepare-demo-data.sh
```

The bucket is private. A developer cloning from GitHub has no access to it and
no `DEMO_SNAPSHOT_S3_URI` set, so they transparently fall back to the full seed
path — nothing to configure.

## 3. Start Dashboard On 3004

```bash
./scripts/start-dashboard.sh
```

`start-dashboard.sh` loads the database connection details (`DATABASE_URL`)
first, then starts the combined dashboard backend and UI at
http://localhost:3004.

## 4. Start Quick Order On 3005

Quick Order is a separate repo pushed to `bganguly/websockets-quickorder`.

```bash
cd ../websockets-quickorder
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
