#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-a2-test
OLD=/srv/company-agent-staging
SCOPE=company-agent-a2-test
test "$(readlink -f "$ROOT")" = "$ROOT"
cd "$ROOT"
test "$(cat .project-scope)" = "$SCOPE"
exec 9>.deploy.lock
flock -n 9
test ! -d release
test -s a2-release.tgz
sha256sum --check artifact.sha256
for name in caf-a2-app caf-a2-db; do if sudo -n docker inspect "$name" >/dev/null 2>&1; then printf 'A2 name already exists; use explicit recovery.\n' >&2; exit 1; fi; done
if sudo -n docker volume inspect caf-a2-data >/dev/null 2>&1; then printf 'A2 data volume already exists; refuse implicit reuse.\n' >&2; exit 1; fi
if sudo -n docker network inspect caf-a2-network >/dev/null 2>&1; then printf 'A2 network already exists; use explicit recovery.\n' >&2; exit 1; fi
test "$(sha256sum "$OLD/release/pnpm-lock.yaml" | cut -d' ' -f1)" = "$(cut -d' ' -f1 backups/old-lock.sha256)"
mkdir unpack
tar -xzf a2-release.tgz -C unpack
test "$(cat unpack/.project-scope)" = "$SCOPE"
cmp unpack/release/pnpm-lock.yaml "$OLD/release/pnpm-lock.yaml"
mv unpack/release release
mkdir -p release/node_modules
mkdir -p state/a2-host
chmod 700 state private
NODE=$(cat backups/node-image.txt)
POSTGRES=$(cat backups/postgres-image.txt)
sudo -n docker run --rm --label com.company-agent.scope="$SCOPE" --cpus=1 --memory=768m --pids-limit=128 --mount "type=bind,src=$ROOT/release/connectors/im-bridge,dst=/install" --workdir=/install "$NODE" npm ci --ignore-scripts --omit=dev --no-audit --no-fund --fetch-retries=1 > build-im-dependencies.log 2>&1
sudo -n chown -R 1000:1000 "$ROOT/release" "$ROOT/state" "$ROOT/private"
sudo -n docker network create --label com.company-agent.scope="$SCOPE" caf-a2-network >/dev/null
sudo -n docker volume create --label com.company-agent.scope="$SCOPE" caf-a2-data >/dev/null
sudo -n docker run -d --name=caf-a2-db --label com.company-agent.scope="$SCOPE" --restart=unless-stopped --network=caf-a2-network --cpus=0.5 --memory=768m --pids-limit=128 --env-file="$ROOT/private/postgres.env" --mount type=volume,src=caf-a2-data,dst=/var/lib/postgresql --health-cmd='pg_isready -U caf_a2 -d caf_a2' --health-interval=5s --health-retries=12 "$POSTGRES" >/dev/null
for attempt in $(seq 1 40); do if sudo -n docker exec caf-a2-db pg_isready -U caf_a2 -d caf_a2 >/dev/null; then break; fi; sleep 1; done
sudo -n docker exec caf-a2-db pg_isready -U caf_a2 -d caf_a2 >/dev/null
sudo -n docker create --name=caf-a2-app --label com.company-agent.scope="$SCOPE" --restart=unless-stopped --network=caf-a2-network --cpus=1 --memory=1536m --pids-limit=256 --read-only --user=1000:1000 --cap-drop=ALL --security-opt=no-new-privileges --tmpfs=/tmp:rw,exec,nosuid,nodev,size=128m --tmpfs=/home/node/.cache:rw,uid=1000,gid=1000,mode=700,size=64m --log-driver=json-file --log-opt=max-size=10m --log-opt=max-file=3 --publish=127.0.0.1:14417:4317 --workdir=/app --mount "type=bind,src=$ROOT/release,dst=/app,readonly" --mount "type=bind,src=$OLD/release/node_modules,dst=/app/node_modules,readonly" --mount "type=bind,src=$ROOT/state,dst=/app/.local" --mount "type=bind,src=$ROOT/private/app-secrets.json,dst=/run/secrets/company-agent-staging.json,readonly" --env HOST=0.0.0.0 --env PORT=4317 --env PUBLIC_ORIGIN=https://sales.hongkeweilai.com:8443/a2 --env PUBLIC_BASE_PATH=/a2 --env TRUSTED_PROXY_IP=172.18.0.4 --env FRAMEWORK_ROOT=/app/.local/a2-host --env ENABLE_ENTRY_CONNECTORS=1 --env MAX_CONCURRENT_AGENTS=2 --health-cmd='node -e "fetch(\"http://127.0.0.1:4317/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"' --health-interval=10s --health-retries=6 "$NODE" node scripts/staging/container-entrypoint.mjs serve >/dev/null
sudo -n docker network connect --ip 172.18.0.5 caf-staging-network caf-a2-app
sudo -n docker start caf-a2-app >/dev/null
ready=no
for attempt in $(seq 1 45); do if curl --fail --silent http://127.0.0.1:14417/health > health-internal.json; then ready=yes;break;fi;sleep 1;done
test "$ready" = yes
test "$(sudo -n docker inspect caf-a2-app --format '{{index .Config.Labels "com.company-agent.scope"}}')" = "$SCOPE"
printf 'A2 application ready on loopback14417; public proxy has not switched.\n'
