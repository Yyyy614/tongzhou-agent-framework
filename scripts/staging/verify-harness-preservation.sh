#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-staging
BEFORE="$ROOT/harness-cloud-041-before"
AFTER="$ROOT/harness-cloud-041-after"
test "$(cat "$ROOT/.project-scope")" = company-agent-staging
test ! -e "$AFTER"
umask 077; mkdir "$AFTER"
sudo -n docker exec -i caf-staging-db psql -U caf_test -d caf_staging -v ON_ERROR_STOP=1 -At > "$AFTER/business-rows.jsonl" <<'SQL'
SELECT json_build_object('table', 'actors', 'id', id, 'hash', md5(data::text)) FROM fw_ac47e475b580e7.actors ORDER BY id;
SELECT json_build_object('table', 'agents', 'id', id, 'hash', md5(data::text)) FROM fw_ac47e475b580e7.agents ORDER BY id;
SELECT json_build_object('table', 'runs', 'id', id, 'hash', md5(row_to_json(t)::text)) FROM fw_ac47e475b580e7.runs t WHERE state <> 'running' ORDER BY id;
SQL
python3 - "$BEFORE/business-rows.jsonl" "$AFTER/business-rows.jsonl" <<'PY'
import json,sys
before=[json.loads(line) for line in open(sys.argv[1]) if line.strip()]
after={(row['table'],row['id']):row['hash'] for row in map(json.loads,open(sys.argv[2]))}
assert before, 'Missing baseline'
assert all(after.get((row['table'],row['id']))==row['hash'] for row in before), 'Existing business data changed'
print('Existing employee, Agent and completed-run hashes unchanged:',len(before))
PY
if test -s "$BEFORE/memory-files.sha256"; then sha256sum --check --status "$BEFORE/memory-files.sha256"; else printf 'Missing private-memory baseline\n' >&2; exit 1; fi
sudo -n docker inspect caf-staging-app --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}}' > "$AFTER/app-runtime.txt"
cmp "$BEFORE/app-runtime.txt" "$AFTER/app-runtime.txt"
while IFS= read -r name; do sudo -n docker inspect "$name" --format '{{.Name}} {{.Id}} {{.State.StartedAt}} {{.RestartCount}}'; done < "$BEFORE/production-names.txt" > "$AFTER/production.txt"
test "$(wc -l < "$AFTER/production.txt")" = 11
cmp "$BEFORE/production.txt" "$AFTER/production.txt"
curl --fail --silent --show-error https://sales.hongkeweilai.com/ > "$AFTER/original-443.html"
cmp "$BEFORE/original-443.html" "$AFTER/original-443.html"
printf 'Original memory, test-app runtime, 11 production containers and HTTPS443 page unchanged.\n'
