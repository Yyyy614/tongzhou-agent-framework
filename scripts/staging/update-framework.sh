#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-staging
PROJECT=company-agent-staging
APP=caf-staging-app
PUBLIC=https://sales.hongkeweilai.com:8443
test "$(readlink -f "$PWD")" = "$ROOT"
test "$(cat .project-scope)" = "$PROJECT"
exec 9> .framework-upgrade.lock
flock -n 9 || { printf 'Another test upgrade is active\n' >&2; exit 1; }
test -s framework-next.tgz
for resource in "$APP" caf-staging-db caf-staging-tls; do
  test "$(sudo -n docker inspect "$resource" --format '{{index .Config.Labels "com.company-agent.scope"}}')" = "$PROJECT"
done
test "$(sudo -n docker inspect "$APP" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')" = 172.18.0.3
active=$(sudo -n docker exec caf-staging-db psql -U caf_test -d caf_staging -Atc "SELECT (SELECT count(*) FROM fw_ac47e475b580e7.runs WHERE state='running')+(SELECT count(*) FROM fw_ac47e475b580e7.tasks WHERE state IN ('queued','running'))")
test "$active" = 0 || { printf 'Active test work: finish it before upgrading\n' >&2; exit 1; }
NODE=$(sudo -n docker inspect "$APP" --format '{{.Image}}')
CANDIDATE=$(mktemp -d "$ROOT/framework-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
chmod 700 "$CANDIDATE"
OLD="caf-staging-app-before-$(basename "$CANDIDATE" | tr -cd 'A-Za-z0-9-')"
tar -xzf framework-next.tgz -C "$CANDIDATE"
test "$(cat "$CANDIDATE/.project-scope")" = "$PROJECT"
cmp release/pnpm-lock.yaml "$CANDIDATE/release/pnpm-lock.yaml"
mkdir "$CANDIDATE/release/node_modules"
test -f "$CANDIDATE/release/packages/work-assistant/agent-plugin.json"
test -f "$CANDIDATE/release/dist/work.js"
umask 077
sudo -n docker exec caf-staging-db pg_dump -U caf_test -d caf_staging -Fc > "$CANDIDATE/pre-upgrade.dump"
stopped=no; renamed=no; detached=no
rollback() {
  status=$?; trap - ERR
  if [ "$stopped" = yes ]; then
    if [ "$renamed" = yes ] && sudo -n docker inspect "$APP" >/dev/null 2>&1; then
      test "$(sudo -n docker inspect "$APP" --format '{{index .Config.Labels "com.company-agent.scope"}}')" = "$PROJECT"
      sudo -n docker logs --tail 80 "$APP" > "$CANDIDATE/candidate-failure.log" 2>&1 || true
      sudo -n docker rm -f "$APP" >/dev/null
    fi
    if [ "$renamed" = yes ]; then sudo -n docker rename "$OLD" "$APP"; fi
    if [ "$detached" = yes ]; then sudo -n docker network connect --ip 172.18.0.3 caf-staging-network "$APP"; fi
    sudo -n docker start "$APP" >/dev/null
    printf 'Restored previous isolated test application.\n' >&2
  fi
  exit "$status"
}
trap rollback ERR
sudo -n docker stop --time=180 "$APP" >/dev/null
stopped=yes
sudo -n docker rename "$APP" "$OLD"
renamed=yes
sudo -n docker network disconnect caf-staging-network "$OLD"
detached=yes
sudo -n docker run -d --name "$APP" --label com.company-agent.scope="$PROJECT" \
  --restart=unless-stopped --network=caf-staging-network --ip=172.18.0.3 --cpus=1 --memory=1536m --pids-limit=256 \
  --read-only --user=1000:1000 --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs=/tmp:rw,exec,nosuid,nodev,size=128m --tmpfs=/home/node/.cache:rw,uid=1000,gid=1000,mode=700,size=64m \
  --log-driver=json-file --log-opt=max-size=10m --log-opt=max-file=3 \
  --publish=127.0.0.1:14317:4317 --workdir=/app \
  --mount "type=bind,src=$CANDIDATE/release,dst=/app,readonly" \
  --mount "type=bind,src=$ROOT/release/node_modules,dst=/app/node_modules,readonly" \
  --mount "type=bind,src=$ROOT/state,dst=/app/.local" \
  --mount "type=bind,src=$ROOT/private/app-secrets.json,dst=/run/secrets/company-agent-staging.json,readonly" \
  --env=HOST=0.0.0.0 --env=PORT=4317 --env=PUBLIC_ORIGIN="$PUBLIC" --env=TRUSTED_PROXY_IP=172.18.0.4 \
  --env=FRAMEWORK_ROOT=/app/.local/host \
  --health-cmd='node -e "fetch(\"http://127.0.0.1:4317/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"' --health-interval=10s --health-retries=6 \
  "$NODE" node scripts/staging/container-entrypoint.mjs serve >/dev/null
ready=no
for attempt in $(seq 1 45); do
  if curl --fail --silent --resolve sales.hongkeweilai.com:8443:127.0.0.1 "$PUBLIC/health" > "$CANDIDATE/health.json"; then ready=yes; break; fi
  sleep 1
done
test "$ready" = yes
curl --fail --silent --resolve sales.hongkeweilai.com:8443:127.0.0.1 "$PUBLIC/assets/coordination-views.js" >/dev/null
printf '%s\n' "$OLD" > "$CANDIDATE/previous-container.txt"
trap - ERR
printf 'Isolated test framework updated. Release: %s\nPrevious container: %s\n' "$CANDIDATE" "$OLD"
