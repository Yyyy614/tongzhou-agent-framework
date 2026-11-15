#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-a2-test
test "$(readlink -f "$ROOT")" = "$ROOT"
cd "$ROOT"
test "$(cat .project-scope)" = company-agent-a2-test
CONFIG=$(cat backups/nginx-source.txt)
case "$(readlink -f "$CONFIG")" in /srv/company-agent-staging/*) ;; *) exit 1;; esac
CURRENT=$(mktemp backups/nginx-published.XXXXXX)
cp -p "$CONFIG" "$CURRENT"
rollback(){ trap - ERR INT TERM; cat "$CURRENT" > "$CONFIG"; sudo -n docker exec caf-staging-tls nginx -t -c /etc/nginx/staging.conf; sudo -n docker exec caf-staging-tls nginx -s reload -c /etc/nginx/staging.conf; printf 'Published test proxy restored.\n' >&2; exit 1; }
trap rollback ERR INT TERM
python3 - "$CONFIG" <<'PY'
import sys
before=open('backups/nginx-before.conf').read()
current=open(sys.argv[1]).read()
start=current.index('        location = /a2 {')
end=current.index('        location / {',start)
assert current[:start]+current[end:]==before, 'Other proxy changes exist; refuse overwrite'
with open(sys.argv[1],'w') as f:f.write(before)
PY
sudo -n docker exec caf-staging-tls nginx -t -c /etc/nginx/staging.conf
sudo -n docker exec caf-staging-tls nginx -s reload -c /etc/nginx/staging.conf
trap - ERR INT TERM
printf 'Removed only A2 public route; isolated database and all records retained.\n'
