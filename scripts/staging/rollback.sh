#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-staging
PROJECT=company-agent-staging
if [ "$(readlink -f "$PWD")" != "$ROOT" ]; then exit 1; fi
test "$(cat .project-scope)" = "$PROJECT"
for name in caf-staging-tls caf-staging-app caf-staging-db caf-staging-build; do
  if sudo -n docker container inspect "$name" >/dev/null 2>&1; then
    owner=$(sudo -n docker container inspect "$name" --format '{{index .Config.Labels "com.company-agent.scope"}}')
    if [ "$owner" != "$PROJECT" ]; then printf 'Refusing an unowned container\n' >&2; exit 1; fi
    sudo -n docker stop "$name"
  fi
done
printf 'Only test containers stopped; test data and all production services retained.\n'
