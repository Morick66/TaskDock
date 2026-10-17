#!/usr/bin/env bash
set -euo pipefail
release=$1
revision=$2
expected_image=$3
dockerfile=$4
root=/opt/data/appdata/taskdock
app=$root/app
[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
[[ "$release" == "$root/releases/$revision"* || "$release" == "$root/releases/${revision:0:12}-"* ]]
[[ "$dockerfile" == Dockerfile || "$dockerfile" == Dockerfile.deploy ]]
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
[[ "$(docker inspect taskdock --format '{{.Image}}')" == "$expected_image" ]] || { echo 'Live image changed; rerun deployment.' >&2; exit 1; }
cd "$release"
image="taskdock:${revision:0:12}"
echo "Building $image"
DOCKER_BUILDKIT=0 docker build --pull=false --label "org.opencontainers.image.revision=$revision" -f "$dockerfile" -t "$image" .
backup="$root/backups/$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:12}"
mkdir -m 700 "$backup"
cp "$app/compose.homelab.yaml" "$backup/compose.homelab.yaml"
printf '%s\n' "$expected_image" > "$backup/previous-image.txt"
cd "$app"
compose=(docker compose -f compose.yaml -f compose.homelab.yaml)
cutover=0
recover() {
  status=$?
  if (( status != 0 && cutover == 1 )); then
    echo "Deployment failed; restoring previous Compose image. Backup: $backup" >&2
    cp "$backup/compose.homelab.yaml" compose.homelab.yaml
    "${compose[@]}" up -d --no-build --no-deps taskdock
  fi
  exit "$status"
}
trap recover EXIT
echo "Backing up database and attachments to $backup"
cutover=1
"${compose[@]}" stop taskdock
tar -C "$app" -czf "$backup/taskdock-data.tar.gz" taskdock-data
python3 - "$image" <<'PY'
import pathlib, re, sys
p = pathlib.Path('compose.homelab.yaml')
s, count = re.subn(r'(?m)^    image: taskdock:[^\n]+$', '    image: ' + sys.argv[1], p.read_text())
if count != 1:
    raise SystemExit('Expected exactly one TaskDock image entry')
p.write_text(s)
PY
"${compose[@]}" up -d --no-build --no-deps taskdock
healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:47823/health | python3 -c 'import json,sys; assert json.load(sys.stdin)["status"] == "ok"' 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
(( healthy == 1 ))
[[ "$(docker inspect taskdock --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$revision" ]]
printf '{"revision":"%s","image":"%s","backup":"%s"}\n' "$revision" "$image" "$backup" > "$release/deployment.json"
echo "READY $revision; backup $backup"
