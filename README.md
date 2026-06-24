# Dashboard

This repo is the integrated dashboard app on `main`. The active local development
workflow also keeps split worktrees available so backend, frontend, and tests can
move independently and be merged back to `main` when requested.

## Local Demo

Integrated `main`:

```bash
npm install
npm run dev
```

Open http://localhost:3004.

Split worktree workflow:

```bash
cd ../wt-backend
npm install
npm run dev
```

```bash
cd ../wt-frontend
npm install
npm run dev
```

Open http://localhost:3003. The frontend proxies `/api/*` to the backend on
http://localhost:3004.

Quick Order is a separate repo pushed to `bganguly/nextjs-websocket`:

```bash
cd ../wt-quickorder
npm install
npm run dev
```

Open http://localhost:3005.

## AWS Infra

The infra scripts manage the AWS RDS Postgres stack with Terraform. They are
safe to rerun: Terraform recreates missing pieces, updates changed pieces, and
leaves healthy existing pieces alone.

Create or repair infra:

```bash
./scripts/infra-up.sh
```

What it does:

- Checks local dependencies: `terraform` and `aws`
- Detects your public IP and restricts the DB security group to that CIDR
- Runs `terraform init`
- Runs `terraform apply` for the VPC, subnets, route table, security group, and RDS Postgres
- Writes `.env.rds`
- Checks whether Quick Order is already active on `3005`

Expected timing:

- Existing healthy infra: usually under 2 minutes
- New RDS instance: usually 5-10 minutes
- Destroying RDS: usually 5-10 minutes

After `infra-up.sh` completes:

```bash
source .env.rds
DATABASE_URL="$DATABASE_URL" npx prisma db push
DATABASE_URL="$DATABASE_URL" npm run dev
```

If Quick Order is not already running:

```bash
cd ../wt-quickorder
npm install
npm run dev
```

Destroy infra and stop AWS billing:

```bash
./scripts/infra-down.sh
```

`infra-down.sh` removes the RDS instance and networking resources, then deletes
`.env.rds`.

## Verify

Integrated:

```bash
npm run lint
npx playwright test
```

Split:

```bash
cd ../wt-backend && npm run lint
cd ../wt-frontend && npm run lint
cd ../wt-testing && npm run lint
```

```bash
cd ../wt-testing
BASE_URL=http://localhost:3003 BACKEND_URL=http://localhost:3004 npx playwright test
```

## Branches

- `main`: integrated dashboard
- `feature/service-layer`: backend/API/data worktree
- `feature/frontend-ui`: dashboard UI worktree
- `feature/testing-setup`: Playwright, infra scripts, and verification worktree
- `../wt-quickorder`: separate quickorder repo on `main`
