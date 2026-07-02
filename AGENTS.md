<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Scripts consistency

`scripts/deploy.sh` and `scripts/local-dev.sh` both define an `apply_migrations` helper. Keep their behavior identical — including output verbosity (e.g. psql migration output is suppressed unless a migration fails). If you change one, change the other the same way.
