#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-a2-test
test "$(readlink -f "$ROOT")" = "$ROOT"
cd "$ROOT"
test "$(cat .project-scope)" = company-agent-a2-test
test "$(sudo -n docker inspect caf-a2-app --format '{{index .Config.Labels "com.company-agent.scope"}}')" = company-agent-a2-test
curl --fail --silent http://127.0.0.1:14417/health >/dev/null
CONFIG=$(cat backups/nginx-source.txt)
case "$(readlink -f "$CONFIG")" in /srv/company-agent-staging/*) ;; *) exit 1;; esac
cmp "$CONFIG" backups/nginx-before.conf
rollback(){ trap - ERR INT TERM; cat backups/nginx-before.conf > "$CONFIG"; sudo -n docker exec caf-staging-tls nginx -t -c /etc/nginx/staging.conf; sudo -n docker exec caf-staging-tls nginx -s reload -c /etc/nginx/staging.conf; printf 'Original test proxy restored.\n' >&2; exit 1; }
trap rollback ERR INT TERM
python3 - "$CONFIG" <<'PY'
import sys
path=sys.argv[1]
with open(path) as f: text=f.read()
needle='        location / {'
assert text.count(needle)==1 and 'location /a2/' not in text
addition='''        location = /a2 { return 308 /a2/; }
        location /a2/ {
            proxy_pass http://caf-a2-app:4317/;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $http_host;
            proxy_set_header X-Forwarded-Host $http_host;
            proxy_set_header X-Forwarded-Proto https;
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_cookie_path / /a2/;
            proxy_buffering off;
            proxy_read_timeout 180s;
        }
'''
# The existing read-only container bind points at this inode: write in place after backup.
with open(path,'w') as f: f.write(text.replace(needle,addition+needle))
PY
sudo -n docker exec caf-staging-tls nginx -t -c /etc/nginx/staging.conf
sudo -n docker exec caf-staging-tls nginx -s reload -c /etc/nginx/staging.conf
curl --fail --silent --show-error --retry 3 --retry-delay 1 --resolve sales.hongkeweilai.com:8443:127.0.0.1 https://sales.hongkeweilai.com:8443/a2/health > health-public.json
curl --fail --silent --resolve sales.hongkeweilai.com:8443:127.0.0.1 https://sales.hongkeweilai.com:8443/ > backups/after-8443.html
cmp backups/before-8443.html backups/after-8443.html
curl --fail --silent --show-error https://sales.hongkeweilai.com/ > backups/after-443.html
cmp backups/before-443.html backups/after-443.html
trap - ERR INT TERM
printf 'A2 HTTPS path ready; original443 and8443 pages unchanged.\n'
