#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-staging
test "$(cat "$ROOT/.project-scope")" = company-agent-staging
for name in caf-staging-app caf-staging-db caf-staging-tls; do
  test "$(sudo -n docker inspect "$name" --format '{{index .Config.Labels "com.company-agent.scope"}}')" = company-agent-staging
done
SNAPSHOT="$ROOT/harness-cloud-041-before"
test ! -e "$SNAPSHOT"
umask 077
mkdir "$SNAPSHOT"
sudo -n docker inspect caf-staging-app --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}}' > "$SNAPSHOT/app-runtime.txt"
sudo -n docker exec caf-staging-db pg_dump -U caf_test -d caf_staging -Fc > "$SNAPSHOT/database.dump"
tar -czf "$SNAPSHOT/state.tgz" -C "$ROOT" state
sudo -n docker exec -i caf-staging-db psql -U caf_test -d caf_staging -v ON_ERROR_STOP=1 -At > "$SNAPSHOT/business-rows.jsonl" <<'SQL'
SELECT json_build_object('table', 'actors', 'id', id, 'hash', md5(data::text)) FROM fw_ac47e475b580e7.actors ORDER BY id;
SELECT json_build_object('table', 'agents', 'id', id, 'hash', md5(data::text)) FROM fw_ac47e475b580e7.agents ORDER BY id;
SELECT json_build_object('table', 'runs', 'id', id, 'hash', md5(row_to_json(t)::text)) FROM fw_ac47e475b580e7.runs t WHERE state <> 'running' ORDER BY id;
SQL
find "$ROOT/state/host" -type f -path '*/memory/*' -exec sha256sum {} \; > "$SNAPSHOT/memory-files.sha256"
sudo -n docker ps --filter name=aisales --format '{{.Names}}' > "$SNAPSHOT/production-names.txt"
test "$(wc -l < "$SNAPSHOT/production-names.txt")" = 11
while IFS= read -r name; do sudo -n docker inspect "$name" --format '{{.Name}} {{.Id}} {{.State.StartedAt}} {{.RestartCount}}'; done < "$SNAPSHOT/production-names.txt" > "$SNAPSHOT/production.txt"
curl --fail --silent --show-error https://sales.hongkeweilai.com/ > "$SNAPSHOT/original-443.html"
test -s "$SNAPSHOT/database.dump"
test -s "$SNAPSHOT/business-rows.jsonl"
printf 'Test backup and existing-data baseline saved: %s\n' "$SNAPSHOT"
