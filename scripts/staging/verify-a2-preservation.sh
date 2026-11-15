#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-a2-test
test "$(readlink -f "$ROOT")" = "$ROOT"
cd "$ROOT"
test "$(cat .project-scope)" = company-agent-a2-test
for name in $(sudo -n docker ps -a --format '{{.Names}}'); do
  sudo -n docker inspect "$name" --format '{"id":"{{.Id}}","name":"{{.Name}}","started":"{{.State.StartedAt}}","restarts":{{.RestartCount}},"running":{{.State.Running}}}'
done > backups/after-containers.jsonl
python3 - <<'PY'
import json
before=[json.loads(s) for s in open('backups/before-containers.jsonl')]
after={r['name']:r for r in (json.loads(s) for s in open('backups/after-containers.jsonl'))}
for row in before:
    assert row==after.get(row['name']), 'Existing container changed: '+row['name']
print('Original containers: identities, start times, restart counts and running states unchanged ('+str(len(before))+').')
PY
sudo -n docker exec caf-staging-db psql -U caf_test -d caf_staging -Atc "SELECT 'actors',count(*),md5(coalesce(string_agg(id||':'||data::text,'|' ORDER BY id),'')) FROM fw_ac47e475b580e7.actors UNION ALL SELECT 'agents',count(*),md5(coalesce(string_agg(id||':'||data::text,'|' ORDER BY id),'')) FROM fw_ac47e475b580e7.agents UNION ALL SELECT 'memories',count(*),md5(coalesce(string_agg(row_to_json(t)::text,'|' ORDER BY agent_id,note_id),'')) FROM fw_ac47e475b580e7.memories t UNION ALL SELECT 'accounts',count(*),md5(coalesce(string_agg(row_to_json(t)::text,'|' ORDER BY principal_id),'')) FROM fw_ac47e475b580e7.employee_credentials t" > backups/after-records.txt
cmp backups/before-records.txt backups/after-records.txt
curl --fail --silent --show-error https://sales.hongkeweilai.com/ > backups/after-443.html
curl --fail --silent --show-error --resolve sales.hongkeweilai.com:8443:127.0.0.1 https://sales.hongkeweilai.com:8443/ > backups/after-8443.html
cmp backups/before-443.html backups/after-443.html
cmp backups/before-8443.html backups/after-8443.html
printf 'Original employee/Agent/memory/account hashes and443/8443 root pages unchanged.\n'
