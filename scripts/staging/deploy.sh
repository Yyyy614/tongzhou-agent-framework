#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-staging
PROJECT=company-agent-staging
APP=caf-staging-app
DB=caf-staging-db
NET=caf-staging-network
VOL=caf-staging-pgdata
NODE=${STAGING_NODE_IMAGE:-node:24.17.0-bookworm-slim}
POSTGRES=${STAGING_POSTGRES_IMAGE:-postgres:18.4-bookworm}
if [ "$(readlink -f "$PWD")" != "$ROOT" ]; then printf 'Refusing a different staging directory\n' >&2; exit 1; fi
test "$(cat .project-scope)" = "$PROJECT"
test -s private/app-secrets.json
test -s private/postgres.env
for name in "$APP" "$DB" caf-staging-build; do
  if sudo -n docker container inspect "$name" >/dev/null 2>&1; then printf 'Reserved test container already exists: %s\n' "$name" >&2; exit 1; fi
done
if ss -lnt | grep -q ':14317 '; then printf 'Test port is occupied\n' >&2; exit 1; fi
if [ "$(awk '/MemAvailable/{print $2}' /proc/meminfo)" -lt 3145728 ]; then printf 'Insufficient spare RAM; test not started\n' >&2; exit 1; fi
if [ "$(df --output=avail -k "$ROOT" | tail -n 1)" -lt 5242880 ]; then printf 'Insufficient spare disk; test not started\n' >&2; exit 1; fi
chmod 700 private state
chmod 600 private/*
sudo -n docker pull "$NODE"
sudo -n docker pull "$POSTGRES"
# Install into this test release only, inside a resource-limited disposable tool.
sudo -n docker run --rm --name caf-staging-build --label com.company-agent.scope="$PROJECT" \
  --cpus=1 --memory=1536m --pids-limit=256 --user=1000:1000 \
  --security-opt=no-new-privileges --cap-drop=ALL \
  --mount "type=bind,src=$ROOT/release,dst=/app" --workdir=/app \
  "$NODE" sh -ec 'npm install --prefix /tmp/caf-pnpm --ignore-scripts --no-audit --no-fund pnpm@11.28.5; node /tmp/caf-pnpm/node_modules/pnpm/bin/pnpm.mjs install --prod --frozen-lockfile --ignore-scripts'
for kind in network volume; do
  name="$NET"; if [ "$kind" = volume ]; then name="$VOL"; fi
  if sudo -n docker "$kind" inspect "$name" >/dev/null 2>&1; then
    owner=$(sudo -n docker "$kind" inspect "$name" --format '{{index .Labels "com.company-agent.scope"}}')
    if [ "$owner" != "$PROJECT" ]; then printf 'Existing resource is not this test project\n' >&2; exit 1; fi
  else
    sudo -n docker "$kind" create --label com.company-agent.scope="$PROJECT" "$name" >/dev/null
  fi
done
sudo -n docker run -d --name "$DB" --label com.company-agent.scope="$PROJECT" \
  --restart=unless-stopped --network="$NET" --cpus=0.5 --memory=512m --pids-limit=128 \
  --security-opt=no-new-privileges --env-file="$ROOT/private/postgres.env" \
  --log-driver=json-file --log-opt=max-size=10m --log-opt=max-file=3 \
  --mount "type=volume,src=$VOL,dst=/var/lib/postgresql" \
  --health-cmd='pg_isready -U caf_test -d caf_staging' --health-interval=5s --health-retries=12 \
  "$POSTGRES" -c shared_buffers=128MB -c max_connections=40
ready=no
for attempt in $(seq 1 60); do
  if sudo -n docker exec "$DB" pg_isready -U caf_test -d caf_staging >/dev/null 2>&1; then ready=yes; break; fi
  sleep 1
done
if [ "$ready" != yes ]; then printf 'Test database did not become ready\n' >&2; exit 1; fi
sudo -n docker run -d --name "$APP" --label com.company-agent.scope="$PROJECT" \
  --restart=unless-stopped --network="$NET" --cpus=1 --memory=1536m --pids-limit=256 \
  --read-only --user=1000:1000 --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs=/tmp:rw,exec,nosuid,nodev,size=128m --tmpfs=/home/node/.cache:rw,uid=1000,gid=1000,mode=700,size=64m \
  --log-driver=json-file --log-opt=max-size=10m --log-opt=max-file=3 \
  --publish=127.0.0.1:14317:4317 --workdir=/app \
  --mount "type=bind,src=$ROOT/release,dst=/app,readonly" \
  --mount "type=bind,src=$ROOT/state,dst=/app/.local" \
  --mount "type=bind,src=$ROOT/private/app-secrets.json,dst=/run/secrets/company-agent-staging.json,readonly" \
  --env=HOST=0.0.0.0 --env=PORT=4317 --env=PUBLIC_ORIGIN=http://127.0.0.1:14317 \
  --env=FRAMEWORK_ROOT=/app/.local/host \
  --health-cmd='node -e "fetch(\"http://127.0.0.1:4317/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"' \
  --health-interval=10s --health-retries=6 \
  "$NODE" node scripts/staging/container-entrypoint.mjs serve
for attempt in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:14317/health; then printf '\nStaging API ready on loopback only.\n'; exit 0; fi
  sleep 1
done
printf 'Test API failed health check; use scoped rollback, no production services touched.\n' >&2
exit 1
