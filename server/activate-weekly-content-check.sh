#!/usr/bin/env bash
set -euo pipefail

app_dir="${JAPANESE_WORDS_APP_DIR:-/opt/japanese-words/app}"
backup_root="${JAPANESE_WORDS_BACKUP_DIR:-/var/backups/japanese-words}"
lock_file="${JAPANESE_WORDS_DEPLOY_LOCK:-/run/japanese-words-deploy.lock}"
service_name="japanese-words-weekly-check.service"
timer_name="japanese-words-weekly-check.timer"
service_file="/etc/systemd/system/${service_name}"
timer_file="/etc/systemd/system/${timer_name}"
confirmation=""
expected_commit=""
dry_run=false

for argument in "$@"; do
  case "${argument}" in
    --confirm=*) confirmation="${argument#--confirm=}" ;;
    --expected-commit=*) expected_commit="${argument#--expected-commit=}" ;;
    --dry-run) dry_run=true ;;
    *)
      echo "Unknown argument: ${argument}" >&2
      exit 2
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

if [[ ! "${expected_commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Activation requires --expected-commit=<full lowercase Git hash>." >&2
  exit 2
fi

for command_name in chmod cp curl date flock git install mkdir node rm systemctl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Missing required command: ${command_name}" >&2
    exit 1
  fi
done

exec 9>"${lock_file}"
if ! flock -n 9; then
  echo "Another Production deployment or activation is already running." >&2
  exit 1
fi

if [[ ! -d "${app_dir}/.git" ]]; then
  echo "Expected Git repository at ${app_dir}." >&2
  exit 1
fi

if [[ -n "$(git -C "${app_dir}" status --porcelain)" ]]; then
  echo "Production working tree is not clean; refusing activation." >&2
  exit 1
fi

current_commit="$(git -C "${app_dir}" rev-parse HEAD)"
if [[ "${current_commit}" != "${expected_commit}" ]]; then
  echo "Production HEAD does not match --expected-commit." >&2
  exit 1
fi

for required_file in \
  "${app_dir}/server/weekly-content-check.mjs" \
  "${app_dir}/server/run-weekly-content-check.sh" \
  "${app_dir}/server/systemd/${service_name}" \
  "${app_dir}/server/systemd/${timer_name}"; do
  if [[ ! -r "${required_file}" ]]; then
    echo "Missing reviewed activation file: ${required_file}" >&2
    exit 1
  fi
done

if ! systemctl is-active --quiet japanese-words.service; then
  echo "japanese-words.service must be healthy before activation." >&2
  exit 1
fi

if ! curl --fail --silent --show-error --max-time 15 \
  -H 'Host: bijinihaitan.cn' http://127.0.0.1/healthz >/dev/null; then
  echo "Production health check failed before activation." >&2
  exit 1
fi

protected_units=(nginx feishu-score-bot.service xray.service)
declare -A protected_pids
for unit in "${protected_units[@]}"; do
  if ! systemctl is-active --quiet "${unit}"; then
    echo "Protected unit is not active before activation: ${unit}" >&2
    exit 1
  fi
  protected_pids["${unit}"]="$(systemctl show "${unit}" --property=MainPID --value)"
done

echo "Production commit: ${current_commit}"
echo "Activation target: ${timer_name} at Tue..Sun 14:40 Asia/Shanghai"
echo "Checker behavior: read-only draft/image verification plus health record and optional alert"

if [[ "${dry_run}" == true ]]; then
  echo "Dry run complete; no backup, health record, unit, timer, or service state was changed."
  exit 0
fi

if [[ "${confirmation}" != "ACTIVATE_WEEKLY_CHECK" ]]; then
  echo "Activation requires --confirm=ACTIVATE_WEEKLY_CHECK." >&2
  exit 2
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
unit_backup_dir="${backup_root}/systemd/weekly-content-check-${timestamp}"
mkdir -p "${unit_backup_dir}"
chmod 0700 "${unit_backup_dir}"
had_service=false
had_timer=false
if [[ -f "${service_file}" ]]; then
  cp -a "${service_file}" "${unit_backup_dir}/${service_name}"
  had_service=true
fi
if [[ -f "${timer_file}" ]]; then
  cp -a "${timer_file}" "${unit_backup_dir}/${timer_name}"
  had_timer=true
fi

rollback() {
  echo "Weekly content check activation failed; restoring previous unit state." >&2
  set +e
  systemctl disable --now "${timer_name}" >/dev/null 2>&1
  if [[ "${had_service}" == true ]]; then
    cp -a "${unit_backup_dir}/${service_name}" "${service_file}"
  else
    rm -f "${service_file}"
  fi
  if [[ "${had_timer}" == true ]]; then
    cp -a "${unit_backup_dir}/${timer_name}" "${timer_file}"
  else
    rm -f "${timer_file}"
  fi
  systemctl daemon-reload
  if [[ "${had_timer}" == true ]]; then
    systemctl enable --now "${timer_name}" >/dev/null 2>&1
  fi
  set -e
}
trap rollback ERR

cd "${app_dir}"
node server/tencent-backup.mjs
install -m 0644 "server/systemd/${service_name}" "${service_file}"
install -m 0644 "server/systemd/${timer_name}" "${timer_file}"
systemctl daemon-reload
systemctl start "${service_name}"
systemctl enable --now "${timer_name}"
systemctl is-active --quiet "${timer_name}"

for unit in "${protected_units[@]}"; do
  if ! systemctl is-active --quiet "${unit}"; then
    echo "Protected unit stopped during activation: ${unit}" >&2
    exit 1
  fi
  current_pid="$(systemctl show "${unit}" --property=MainPID --value)"
  expected_pid="${protected_pids[$unit]}"
  if [[ "${current_pid}" != "${expected_pid}" ]]; then
    echo "Protected unit restarted during activation: ${unit}" >&2
    exit 1
  fi
done

trap - ERR
echo "Weekly content verification activated without restarting protected services."
echo "Unit backup: ${unit_backup_dir}"
