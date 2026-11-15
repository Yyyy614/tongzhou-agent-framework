#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-a2-test
SCOPE=company-agent-a2-test
test "$(readlink -f "$ROOT")" = "$ROOT"
cd "$ROOT"
test "$(cat .project-scope)" = "$SCOPE"
exec 9>.deploy.lock
flock -n 9
test "$(sudo -n docker inspect caf-a2-app --format '{{index .Config.Labels "com.company-agent.scope"}}')" = "$SCOPE"
test "$(sudo -n docker inspect caf-a2-app --format '{{.State.Running}}')" = false
sha256sum --check artifact.sha256
python3 - <<'PY'
import tarfile
from pathlib import PurePosixPath
with tarfile.open('a2-release.tgz') as archive:
    for item in archive.getmembers():
        path=PurePosixPath(item.name)
        assert not path.is_absolute() and '..' not in path.parts
        parts=tuple(p for p in path.parts if p!='.')
        assert not parts or parts[0] in ('release','.project-scope')
        assert not item.issym() and not item.islnk() and not item.isdev()
        if parts and parts[0]=='release':
            assert not any(p in ('private','.env') for p in parts)
            assert item.isdir() or not any(p in ('node_modules','.local') for p in parts)
PY
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
tar --exclude=release/node_modules --exclude=release/connectors/im-bridge/node_modules --exclude=release/.local -czf "backups/candidate-before-$STAMP.tgz" release
OLD_LOCK=$(sha256sum release/connectors/im-bridge/package-lock.json | cut -d' ' -f1)
# Existing candidate is stopped; update only its release directory, retaining state and data volume.
tar -xzf a2-release.tgz -C "$ROOT"
test "$(cat .project-scope)" = "$SCOPE"
cmp release/pnpm-lock.yaml /srv/company-agent-staging/release/pnpm-lock.yaml
NEW_LOCK=$(sha256sum release/connectors/im-bridge/package-lock.json | cut -d' ' -f1)
if test "$OLD_LOCK" != "$NEW_LOCK"; then
  NODE=$(cat backups/node-image.txt)
  sudo -n docker run --rm --label com.company-agent.scope="$SCOPE" --cpus=1 --memory=768m --pids-limit=128 --mount "type=bind,src=$ROOT/release/connectors/im-bridge,dst=/install" --workdir=/install "$NODE" npm ci --ignore-scripts --omit=dev --no-audit --no-fund --fetch-retries=1 > build-im-dependencies-update.log 2>&1
fi
sudo -n chown -R 1000:1000 "$ROOT/release"
sudo -n docker start caf-a2-app >/dev/null
ready=no
for attempt in $(seq 1 45); do
  if curl --fail --silent http://127.0.0.1:14417/health > health-internal.json; then ready=yes;break;fi
  sleep 1
done
test "$ready" = yes
printf 'Updated isolated A2 candidate is healthy on loopback14417; state and database retained.\n'
