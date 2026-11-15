#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-a2-test
OLD=/srv/company-agent-staging
SCOPE=company-agent-a2-test
test "$(readlink -f /srv)" = /srv
if test -e "$ROOT"; then test "$(readlink -f "$ROOT")" = "$ROOT"; test "$(cat "$ROOT/.project-scope")" = "$SCOPE"; else sudo -n install -d -m 700 -o ubuntu -g ubuntu "$ROOT"; printf '%s\n' "$SCOPE" > "$ROOT/.project-scope"; fi
cd "$ROOT"
mkdir -p private backups
chmod 700 private backups
test ! -e backups/before-containers.jsonl
for name in $(sudo -n docker ps -a --format '{{.Names}}'); do
  sudo -n docker inspect "$name" --format '{"id":"{{.Id}}","name":"{{.Name}}","started":"{{.State.StartedAt}}","restarts":{{.RestartCount}},"running":{{.State.Running}}}'
done > backups/before-containers.jsonl
curl --fail --silent --show-error --max-time 15 https://sales.hongkeweilai.com/ > backups/before-443.html
sha256sum backups/before-443.html > backups/before-443.sha256
curl --fail --silent --show-error --max-time 15 --resolve sales.hongkeweilai.com:8443:127.0.0.1 https://sales.hongkeweilai.com:8443/ > backups/before-8443.html
sha256sum backups/before-8443.html > backups/before-8443.sha256
TLS_CONFIG=$(sudo -n docker inspect caf-staging-tls --format '{{range .Mounts}}{{if eq .Destination "/etc/nginx/staging.conf"}}{{.Source}}{{end}}{{end}}')
case "$(readlink -f "$TLS_CONFIG")" in "$OLD"/*) ;; *) exit 1;; esac
cp -p "$TLS_CONFIG" backups/nginx-before.conf
printf '%s\n' "$TLS_CONFIG" > backups/nginx-source.txt
sudo -n docker exec caf-staging-db psql -U caf_test -d caf_staging -Atc "SELECT 'actors',count(*),md5(coalesce(string_agg(id||':'||data::text,'|' ORDER BY id),'')) FROM fw_ac47e475b580e7.actors UNION ALL SELECT 'agents',count(*),md5(coalesce(string_agg(id||':'||data::text,'|' ORDER BY id),'')) FROM fw_ac47e475b580e7.agents UNION ALL SELECT 'memories',count(*),md5(coalesce(string_agg(row_to_json(t)::text,'|' ORDER BY agent_id,note_id),'')) FROM fw_ac47e475b580e7.memories t UNION ALL SELECT 'accounts',count(*),md5(coalesce(string_agg(row_to_json(t)::text,'|' ORDER BY principal_id),'')) FROM fw_ac47e475b580e7.employee_credentials t" > backups/before-records.txt
sudo -n docker inspect caf-staging-app --format '{{.Image}}' > backups/node-image.txt
sudo -n docker inspect caf-staging-db --format '{{.Image}}' > backups/postgres-image.txt
sha256sum "$OLD/release/pnpm-lock.yaml" > backups/old-lock.sha256
printf 'A2 baseline preserved; existing containers and data not changed.\n'
