# Dashboard

Start by bringing the AWS database infra up. The app expects a Postgres
`DATABASE_URL`, and `infra-up.sh` is the standard way to create, repair, or find
that database.

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

## 3. Prepare The Database

```bash
npm install
DATABASE_URL="$DATABASE_URL" npx prisma db push
```

Seed data when needed:

```bash
DATABASE_URL="$DATABASE_URL" npx tsx scripts/seed.ts
```

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
