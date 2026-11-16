#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-v07-test
OLD=/srv/company-agent-staging
SCOPE=company-agent-v07-test
test "$(readlink -f "$ROOT")" = "$ROOT"
cd "$ROOT"
test "$(cat .project-scope)" = "$SCOPE"
exec 9>.deploy.lock
flock -n 9
test ! -d release
if ss -Hln sport = :14427 | grep -q .; then printf 'Port14427 occupied.\n' >&2; exit 1; fi
test -s v07-release.tgz
sha256sum --check artifact.sha256
for name in caf-v07-app caf-v07-db; do if sudo -n docker inspect "$name" >/dev/null 2>&1; then printf 'V07 name already exists; use explicit recovery.\n' >&2; exit 1; fi; done
if sudo -n docker volume inspect caf-v07-data >/dev/null 2>&1; then printf 'V07 data volume already exists; refuse implicit reuse.\n' >&2; exit 1; fi
if sudo -n docker network inspect caf-v07-network >/dev/null 2>&1; then printf 'V07 network already exists; use explicit recovery.\n' >&2; exit 1; fi
test "$(sha256sum "$OLD/release/pnpm-lock.yaml" | cut -d' ' -f1)" = "$(cut -d' ' -f1 backups/old-lock.sha256)"
mkdir unpack
tar -xzf v07-release.tgz -C unpack
test "$(cat unpack/.project-scope)" = "$SCOPE"
cmp unpack/release/pnpm-lock.yaml "$OLD/release/pnpm-lock.yaml"
mv unpack/release release
mkdir -p release/node_modules
mkdir -p state/v07-host
chmod 700 state private
NODE=$(cat backups/node-image.txt)
POSTGRES=$(cat backups/postgres-image.txt)
test -d /srv/company-agent-a2-test/release/connectors/im-bridge/node_modules
cmp release/connectors/im-bridge/package-lock.json /srv/company-agent-a2-test/release/connectors/im-bridge/package-lock.json
sudo -n chown -R 1000:1000 "$ROOT/release" "$ROOT/state" "$ROOT/private"
sudo -n docker network create --label com.company-agent.scope="$SCOPE" caf-v07-network >/dev/null
sudo -n docker volume create --label com.company-agent.scope="$SCOPE" caf-v07-data >/dev/null
sudo -n docker run -d --name=caf-v07-db --label com.company-agent.scope="$SCOPE" --restart=unless-stopped --network=caf-v07-network --cpus=0.5 --memory=512m --pids-limit=128 --env-file="$ROOT/private/postgres.env" --mount type=volume,src=caf-v07-data,dst=/var/lib/postgresql --health-cmd='pg_isready -U caf_v07 -d caf_v07' --health-interval=5s --health-retries=12 "$POSTGRES" >/dev/null
for attempt in $(seq 1 40); do if sudo -n docker exec caf-v07-db pg_isready -U caf_v07 -d caf_v07 >/dev/null; then break; fi; sleep 1; done
sudo -n docker exec caf-v07-db pg_isready -U caf_v07 -d caf_v07 >/dev/null
sudo -n docker create --name=caf-v07-app --label com.company-agent.scope="$SCOPE" --restart=unless-stopped --network=caf-v07-network --cpus=1 --memory=1024m --pids-limit=256 --read-only --user=1000:1000 --cap-drop=ALL --security-opt=no-new-privileges --tmpfs=/tmp:rw,exec,nosuid,nodev,size=128m --tmpfs=/home/node/.cache:rw,uid=1000,gid=1000,mode=700,size=64m --log-driver=json-file --log-opt=max-size=10m --log-opt=max-file=3 --publish=127.0.0.1:14427:4317 --workdir=/app --mount "type=bind,src=$ROOT/release,dst=/app,readonly" --mount "type=bind,src=$OLD/release/node_modules,dst=/app/node_modules,readonly" --mount "type=bind,src=$ROOT/state,dst=/app/.local" --mount "type=bind,src=$ROOT/private/app-secrets.json,dst=/run/secrets/company-agent-staging.json,readonly" --mount "type=bind,src=/srv/company-agent-a2-test/release/connectors/im-bridge/node_modules,dst=/app/connectors/im-bridge/node_modules,readonly" --env WEB_PROFILE=studio --env HOST=0.0.0.0 --env PORT=4317 --env PUBLIC_ORIGIN=https://sales.hongkeweilai.com:8443/v07 --env PUBLIC_BASE_PATH=/v07 --env TRUSTED_PROXY_IP=172.18.0.4 --env FRAMEWORK_ROOT=/app/.local/v07-host --env ENABLE_ENTRY_CONNECTORS=1 --env MAX_CONCURRENT_AGENTS=2 --health-cmd='node -e "fetch(\"http://127.0.0.1:4317/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"' --health-interval=10s --health-retries=6 "$NODE" node scripts/staging/container-entrypoint.mjs serve >/dev/null
sudo -n docker network connect caf-staging-network caf-v07-app
sudo -n docker start caf-v07-app >/dev/null
ready=no
for attempt in $(seq 1 45); do if curl --fail --silent http://127.0.0.1:14427/health > health-internal.json; then ready=yes;break;fi;sleep 1;done
test "$ready" = yes
test "$(sudo -n docker inspect caf-v07-app --format '{{index .Config.Labels "com.company-agent.scope"}}')" = "$SCOPE"
printf 'V07 application ready on loopback14427; public proxy has not switched.\n'
