#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-staging
PROJECT=company-agent-staging
APP=caf-staging-app
OLD=caf-staging-app-before-accounts
TLS=caf-staging-tls
PUBLIC=https://sales.hongkeweilai.com:8443
test "$(readlink -f "$PWD")" = "$ROOT"
test "$(cat .project-scope)" = "$PROJECT"
exec 9> .accounts-upgrade.lock
flock -n 9 || { printf 'Another test upgrade is active\n' >&2; exit 1; }
test -s accounts-framework.tgz
for name in "$OLD" "$TLS"; do
  if sudo -n docker inspect "$name" >/dev/null 2>&1; then printf 'Reserved test resource exists: %s\n' "$name" >&2; exit 1; fi
done
test "$(sudo -n docker inspect "$APP" --format '{{index .Config.Labels "com.company-agent.scope"}}')" = "$PROJECT"
test "$(sudo -n docker inspect caf-staging-db --format '{{index .Config.Labels "com.company-agent.scope"}}')" = "$PROJECT"
if ss -lnt | grep -q ':8443 '; then printf 'HTTPS test port occupied\n' >&2; exit 1; fi
test "$(sudo -n docker network inspect caf-staging-network --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')" = 172.18.0.0/16
test "$(sudo -n docker inspect "$APP" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')" = 172.18.0.3
active=$(sudo -n docker exec caf-staging-db psql -U caf_test -d caf_staging -Atc "SELECT (SELECT count(*) FROM fw_ac47e475b580e7.runs WHERE state='running')+(SELECT count(*) FROM fw_ac47e475b580e7.tasks WHERE state IN ('queued','running'))")
test "$active" = 0 || { printf 'Finish active test work before upgrading\n' >&2; exit 1; }
NODE=$(sudo -n docker inspect "$APP" --format '{{.Image}}')
NGINX=$(sudo -n docker inspect aisales-recovery-frontend --format '{{.Image}}')
CANDIDATE="$ROOT/accounts-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$CANDIDATE"
tar -xzf accounts-framework.tgz -C "$CANDIDATE"
test "$(cat "$CANDIDATE/.project-scope")" = "$PROJECT"
cmp release/pnpm-lock.yaml "$CANDIDATE/release/pnpm-lock.yaml"
mkdir "$CANDIDATE/release/node_modules"
# Copy certificate material only within this server, never to an employee or
# developer package. Do not change existing certificate files or permissions.
sudo -n install -d -m 700 -o 1000 -g 1000 private/tls
CERTROOT=/opt/ai-sales-recovery-20261023/domain-gateway-20261103/letsencrypt/live/sales.hongkeweilai.com
# openssl -checkhost prints a mismatch with exit status 0: check the result too.
sudo -n openssl x509 -in "$CERTROOT/fullchain.pem" -noout -checkhost sales.hongkeweilai.com | grep -Fx 'Hostname sales.hongkeweilai.com does match certificate'
sudo -n openssl x509 -in "$CERTROOT/fullchain.pem" -noout -checkend 604800
sudo -n install -m 600 -o 1000 -g 1000 "$CERTROOT/fullchain.pem" private/tls/fullchain.pem
sudo -n install -m 600 -o 1000 -g 1000 "$CERTROOT/privkey.pem" private/tls/privkey.pem
sudo -n docker run --rm --name caf-staging-tls-check --label com.company-agent.scope="$PROJECT" \
  --network=caf-staging-network --cpus=0.25 --memory=128m --pids-limit=64 \
  --read-only --user=1000:1000 --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs=/tmp:rw,nosuid,nodev,uid=1000,gid=1000,mode=700,size=32m --entrypoint=nginx \
  --mount "type=bind,src=$CANDIDATE/nginx-test.conf,dst=/etc/nginx/staging.conf,readonly" \
  --mount "type=bind,src=$ROOT/private/tls,dst=/run/tls,readonly" \
  "$NGINX" -t -c /etc/nginx/staging.conf
umask 077
sudo -n docker exec caf-staging-db pg_dump -U caf_test -d caf_staging -Fc > "$CANDIDATE/pre-accounts.dump"
chmod 600 "$CANDIDATE/pre-accounts.dump"
stopped=no
renamed=no
detached=no
rollback() {
  status=$?
  trap - ERR
  if [ "$stopped" = yes ]; then
    names=("$TLS"); if [ "$renamed" = yes ]; then names+=("$APP"); fi
    for name in "${names[@]}"; do
      if sudo -n docker inspect "$name" >/dev/null 2>&1; then
        owner=$(sudo -n docker inspect "$name" --format '{{index .Config.Labels "com.company-agent.scope"}}')
        if [ "$owner" = "$PROJECT" ]; then
          sudo -n docker logs --tail 80 "$name" > "$CANDIDATE/$name-failure.log" 2>&1 || true
          sudo -n docker rm -f "$name" >/dev/null
        fi
      fi
    done
    if [ "$renamed" = yes ]; then sudo -n docker rename "$OLD" "$APP"; fi
    if [ "$detached" = yes ]; then sudo -n docker network connect --ip 172.18.0.3 caf-staging-network "$APP"; fi
    sudo -n docker start "$APP" >/dev/null
    printf 'Restored the previous test application; production untouched.\n' >&2
  fi
  exit "$status"
}
trap rollback ERR
sudo -n docker stop "$APP" >/dev/null
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
for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:14317/health >/dev/null; then ready=yes; break; fi
  sleep 1
done
test "$ready" = yes
sudo -n docker run -d --name "$TLS" --label com.company-agent.scope="$PROJECT" \
  --restart=unless-stopped --network=caf-staging-network --ip=172.18.0.4 --cpus=0.25 --memory=128m --pids-limit=64 \
  --read-only --user=1000:1000 --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs=/tmp:rw,nosuid,nodev,uid=1000,gid=1000,mode=700,size=32m \
  --log-driver=json-file --log-opt=max-size=10m --log-opt=max-file=3 \
  --publish=8443:8443 --entrypoint=nginx \
  --mount "type=bind,src=$CANDIDATE/nginx-test.conf,dst=/etc/nginx/staging.conf,readonly" \
  --mount "type=bind,src=$ROOT/private/tls,dst=/run/tls,readonly" \
  "$NGINX" -c /etc/nginx/staging.conf -g 'daemon off;' >/dev/null
ready=no
for attempt in $(seq 1 15); do
  if curl --fail --silent --resolve sales.hongkeweilai.com:8443:127.0.0.1 "$PUBLIC/health"; then ready=yes; break; fi
  sleep 1
done
test "$ready" = yes
cp "$CANDIDATE/rollback.sh" "$ROOT/rollback.sh"
trap - ERR
printf '\nIndependent HTTPS test ready: %s\nRelease: %s\n' "$PUBLIC" "$CANDIDATE"
