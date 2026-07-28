#!/usr/bin/env bash
set -euo pipefail

app_dir="${JAPANESE_WORDS_APP_DIR:-/opt/japanese-words/app}"
install_root="${JAPANESE_WORDS_NODE_ROOT:-/opt/japanese-words/runtime}"
current_link="${install_root}/node-current"
node_version="22.23.1"
node_release="node-v${node_version}-linux-x64"
archive_name="${node_release}.tar.xz"
download_url="https://nodejs.org/download/release/v${node_version}/${archive_name}"
expected_sha256="9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578"
runtime_override="/etc/systemd/system/japanese-words.service.d/10-node-runtime.conf"
backup_override="/etc/systemd/system/japanese-words-backup.service.d/10-node-runtime.conf"
lock_file="${JAPANESE_WORDS_DEPLOY_LOCK:-/run/japanese-words-deploy.lock}"
confirmation=""
expected_commit=""
manual_archive=""
dry_run=false

for argument in "$@"; do
  case "${argument}" in
    --confirm=*) confirmation="${argument#--confirm=}" ;;
    --dry-run) dry_run=true ;;
    --expected-commit=*) expected_commit="${argument#--expected-commit=}" ;;
    --archive=*) manual_archive="${argument#--archive=}" ;;
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

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "This reviewed runtime archive only supports the Production x86_64 host." >&2
  exit 1
fi

if [[ -z "${expected_commit}" ]]; then
  echo "Runtime validation requires --expected-commit=<full Git hash>." >&2
  exit 2
fi

if [[ ! "${expected_commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected commit must be a full lowercase 40-character Git hash." >&2
  exit 2
fi

for command_name in awk cp curl flock git install ln mktemp mv node npm readlink rm rmdir sha256sum sleep systemctl tar; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Missing required command: ${command_name}" >&2
    exit 1
  fi
done

if [[ ! -d "${app_dir}/.git" ]]; then
  echo "Expected Git repository at ${app_dir}." >&2
  exit 1
fi

exec 9>"${lock_file}"
if ! flock -n 9; then
  echo "Another Production deployment or runtime upgrade is already running." >&2
  exit 1
fi

current_commit="$(git -C "${app_dir}" rev-parse HEAD)"
current_node="$(node --version)"

if [[ -n "$(git -C "${app_dir}" status --porcelain)" ]]; then
  echo "Production working tree is not clean; refusing the runtime upgrade." >&2
  git -C "${app_dir}" status --short >&2
  exit 1
fi

if [[ "${current_commit}" != "${expected_commit}" ]]; then
  echo "Production HEAD does not match --expected-commit." >&2
  exit 1
fi

if ! systemctl is-active --quiet japanese-words.service; then
  echo "japanese-words.service must be healthy before the runtime upgrade." >&2
  exit 1
fi

if ! curl --fail --silent --show-error --max-time 15 \
  -H 'Host: bijinihaitan.cn' http://127.0.0.1/healthz >/dev/null; then
  echo "Production health check failed before the runtime upgrade." >&2
  exit 1
fi

echo "Production commit: ${current_commit}"
echo "Current runtime:   ${current_node} ($(command -v node))"
echo "Target runtime:    v${node_version}"
echo "Official archive:  ${download_url}"
echo "Archive SHA-256:   ${expected_sha256}"

if [[ "${dry_run}" == true ]]; then
  echo "Dry run complete; no runtime, unit, dependency, or service changes were made."
  exit 0
fi

if [[ "${confirmation}" != "UPGRADE_NODE_22" ]]; then
  echo "Runtime upgrade requires --confirm=UPGRADE_NODE_22." >&2
  exit 2
fi

if [[ -n "${manual_archive}" && ! -r "${manual_archive}" ]]; then
  echo "Cannot read manual Node archive: ${manual_archive}" >&2
  exit 1
fi

install -d -m 0755 "${install_root}"
archive_file="$(mktemp "/tmp/${archive_name}.XXXXXX")"
extract_root="$(mktemp -d "${install_root}/.node-install.XXXXXX")"
validation_root="$(mktemp -d /tmp/japanese-words-node22-validation.XXXXXX)"
validation_release="${validation_root}/release"
rollback_root="$(mktemp -d /tmp/japanese-words-node22-rollback.XXXXXX)"
release_dir="${install_root}/${node_release}"
next_link="${current_link}.next.${BASHPID}"
rollback_link="${current_link}.rollback.${BASHPID}"
previous_link_target=""
had_runtime_override=false
had_backup_override=false
runtime_changed=false
upgrade_completed=false

cleanup() {
  set +e
  git -C "${app_dir}" worktree remove --force "${validation_release}" >/dev/null 2>&1
  rmdir "${validation_root}" >/dev/null 2>&1
  rm -f "${archive_file}" "${next_link}" "${rollback_link}"
  rm -rf "${extract_root}" "${rollback_root}"
}

rollback() {
  echo "Node runtime upgrade failed; restoring the previous service runtime." >&2
  set +e
  if [[ -n "${previous_link_target}" ]]; then
    ln -s "${previous_link_target}" "${rollback_link}"
    mv -Tf "${rollback_link}" "${current_link}"
  else
    rm -f "${current_link}"
  fi
  if [[ "${had_runtime_override}" == true ]]; then
    cp "${rollback_root}/japanese-words-runtime.conf" "${runtime_override}"
  else
    rm -f "${runtime_override}"
  fi
  if [[ "${had_backup_override}" == true ]]; then
    cp "${rollback_root}/japanese-words-backup-runtime.conf" "${backup_override}"
  else
    rm -f "${backup_override}"
  fi
  systemctl daemon-reload
  systemctl restart japanese-words.service
  recovered=false
  for attempt in 1 2 3 4 5; do
    if curl --fail --silent --show-error --max-time 15 \
      -H 'Host: bijinihaitan.cn' http://127.0.0.1/healthz >/dev/null; then
      recovered=true
      break
    fi
    sleep 2
  done
  if [[ "${recovered}" == true ]]; then
    echo "Previous Production runtime restored and healthy." >&2
  else
    echo "HIGH PRIORITY: automatic runtime rollback did not restore local health." >&2
  fi
  set -e
}

finish() {
  exit_status=$?
  trap - EXIT
  if [[ "${runtime_changed}" == true && "${upgrade_completed}" != true ]]; then
    rollback
  fi
  cleanup
  exit "${exit_status}"
}
trap finish EXIT

if [[ -n "${manual_archive}" ]]; then
  cp "${manual_archive}" "${archive_file}"
else
  curl --fail --location --silent --show-error \
    --retry 3 --retry-delay 2 --retry-all-errors \
    --connect-timeout 15 --max-time 300 \
    --output "${archive_file}" "${download_url}"
fi

archive_sha256="$(sha256sum "${archive_file}" | awk 'NR == 1 { print $1 }')"
if [[ "${archive_sha256}" != "${expected_sha256}" ]]; then
  echo "Node archive SHA-256 does not match the reviewed value." >&2
  exit 1
fi

tar -xJf "${archive_file}" -C "${extract_root}"
candidate_dir="${extract_root}/${node_release}"
if [[ "$("${candidate_dir}/bin/node" --version)" != "v${node_version}" ]]; then
  echo "Extracted Node runtime does not match v${node_version}." >&2
  exit 1
fi

echo "Validating the full application under Node v${node_version} outside the live directory..."
git -C "${app_dir}" worktree add --detach "${validation_release}" "${current_commit}"
(
  cd "${validation_release}"
  export PATH="${candidate_dir}/bin:${PATH}"
  npm ci
  npm run lint
  npm run typecheck
  npm test
  npm run build
)

echo "Checking the live dependency tree with Node v${node_version}..."
(
  cd "${app_dir}"
  "${candidate_dir}/bin/node" -e "import('./server/tencent-runtime.mjs')"
)

echo "Creating a complete workflow and image backup before changing the runtime..."
(
  cd "${app_dir}"
  node server/tencent-backup.mjs
)

if [[ -L "${current_link}" ]]; then
  previous_link_target="$(readlink "${current_link}")"
elif [[ -e "${current_link}" ]]; then
  echo "${current_link} exists but is not a symbolic link." >&2
  exit 1
fi

if [[ -f "${runtime_override}" ]]; then
  had_runtime_override=true
  cp "${runtime_override}" "${rollback_root}/japanese-words-runtime.conf"
fi
if [[ -f "${backup_override}" ]]; then
  had_backup_override=true
  cp "${backup_override}" "${rollback_root}/japanese-words-backup-runtime.conf"
fi

if [[ -d "${release_dir}" ]]; then
  if [[ "$("${release_dir}/bin/node" --version)" != "v${node_version}" ]]; then
    echo "Existing ${release_dir} is not the reviewed Node runtime." >&2
    exit 1
  fi
else
  mv "${candidate_dir}" "${release_dir}"
fi

runtime_changed=true
ln -s "${release_dir}" "${next_link}"
mv -Tf "${next_link}" "${current_link}"
install -d -m 0755 "${runtime_override%/*}" "${backup_override%/*}"
install -m 0644 "${app_dir}/server/systemd/japanese-words-node22.conf" "${runtime_override}"
install -m 0644 "${app_dir}/server/systemd/japanese-words-backup-node22.conf" "${backup_override}"

systemctl daemon-reload
systemctl restart japanese-words.service

healthy=false
for attempt in 1 2 3 4 5; do
  if curl --fail --silent --show-error --max-time 15 \
    -H 'Host: bijinihaitan.cn' http://127.0.0.1/healthz >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "${healthy}" != true ]]; then
  echo "Production health check failed under Node v${node_version}." >&2
  exit 1
fi

main_pid="$(systemctl show japanese-words.service --property=MainPID --value)"
running_node="$(readlink -f "/proc/${main_pid}/exe")"
if [[ "${running_node}" != "${release_dir}/bin/node" ]]; then
  echo "Production service did not start with the reviewed Node runtime." >&2
  exit 1
fi

upgrade_completed=true
echo "Node runtime upgrade completed: ${current_node} -> v${node_version}"
echo "Active runtime: ${running_node}"
echo "Node 20 remains installed as the package-managed rollback runtime."
