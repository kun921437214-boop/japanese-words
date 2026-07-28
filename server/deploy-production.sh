#!/usr/bin/env bash
set -euo pipefail

app_dir="${JAPANESE_WORDS_APP_DIR:-/opt/japanese-words/app}"
deploy_branch="${JAPANESE_WORDS_DEPLOY_BRANCH:-main}"
backup_root="${JAPANESE_WORDS_BACKUP_DIR:-/var/backups/japanese-words}"
lock_file="${JAPANESE_WORDS_DEPLOY_LOCK:-/run/japanese-words-deploy.lock}"
bundle_url="${JAPANESE_WORDS_DEPLOY_BUNDLE_URL:-https://github.com/kun921437214-boop/japanese-words/releases/download/tencent-deploy-channel/japanese-words-production.bundle}"
bundle_cache="${JAPANESE_WORDS_DEPLOY_BUNDLE_CACHE:-${backup_root}/deploy-cache/japanese-words-production.bundle}"
confirmation=""
dry_run=false
manual_bundle=""
expected_commit=""

for argument in "$@"; do
  case "${argument}" in
    --confirm=*) confirmation="${argument#--confirm=}" ;;
    --dry-run) dry_run=true ;;
    --branch=*) deploy_branch="${argument#--branch=}" ;;
    --bundle=*) manual_bundle="${argument#--bundle=}" ;;
    --expected-commit=*) expected_commit="${argument#--expected-commit=}" ;;
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

if [[ ! "${deploy_branch}" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "Invalid deploy branch: ${deploy_branch}" >&2
  exit 2
fi

if [[ -n "${expected_commit}" && ! "${expected_commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected commit must be a full lowercase 40-character Git hash." >&2
  exit 2
fi

if [[ -n "${manual_bundle}" && -z "${expected_commit}" ]]; then
  echo "A manually supplied bundle requires --expected-commit=<full Git hash>." >&2
  exit 2
fi

for command_name in awk curl flock git nginx node npm systemctl timeout; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Missing required command: ${command_name}" >&2
    exit 1
  fi
done

if [[ ! -d "${app_dir}/.git" ]]; then
  echo "Expected Git repository at ${app_dir}." >&2
  exit 1
fi

cd "${app_dir}"
exec 9>"${lock_file}"
if ! flock -n 9; then
  echo "Another Production deployment is already running." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Production working tree is not clean; refusing to deploy." >&2
  git status --short >&2
  exit 1
fi

remote_ref="refs/remotes/origin/${deploy_branch}"
current_commit="$(git rev-parse HEAD)"
current_short="${current_commit:0:12}"
fetch_succeeded=false
fetch_source=""
advertised_commit=""

probe_remote_branch() {
  local profile="$1"
  local output=""
  local candidate=""
  echo "Checking ${deploy_branch} through ${profile}..."
  if [[ "${profile}" == "default transport" ]]; then
    output="$(timeout 20 git ls-remote --exit-code origin "refs/heads/${deploy_branch}")" || return 1
  else
    output="$(timeout 25 git -c http.version=HTTP/1.1 -c http.maxRequests=1 \
      ls-remote --exit-code origin "refs/heads/${deploy_branch}")" || return 1
  fi
  candidate="$(awk 'NR == 1 { print $1 }' <<<"${output}")"
  [[ "${candidate}" =~ ^[0-9a-f]{40}$ ]] || return 1
  advertised_commit="${candidate}"
}

fetch_remote_branch() {
  local profile="$1"
  echo "Fetching ${deploy_branch} through ${profile}..."
  case "${profile}" in
    "default transport")
      timeout 30 git fetch --no-tags --prune origin \
        "refs/heads/${deploy_branch}:${remote_ref}"
      ;;
    "HTTP/1.1 fallback")
      timeout 40 git -c http.version=HTTP/1.1 fetch --no-tags --prune origin \
        "refs/heads/${deploy_branch}:${remote_ref}"
      ;;
    "low-bandwidth fallback")
      timeout 75 git -c http.version=HTTP/1.1 -c http.maxRequests=1 \
        -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=20 \
        fetch --no-tags --prune origin \
        "refs/heads/${deploy_branch}:${remote_ref}"
      ;;
    *) return 2 ;;
  esac
}

import_deploy_bundle() {
  local bundle_file="$1"
  local source_label="$2"
  local bundle_head=""
  if ! git bundle verify "${bundle_file}"; then
    echo "Deploy bundle verification failed: ${bundle_file}" >&2
    return 1
  fi
  bundle_head="$(git bundle list-heads "${bundle_file}" HEAD | awk 'NR == 1 { print $1 }')"
  if [[ ! "${bundle_head}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Deploy bundle does not contain a valid HEAD commit." >&2
    return 1
  fi
  if [[ -n "${expected_commit}" && "${bundle_head}" != "${expected_commit}" ]]; then
    echo "Deploy bundle HEAD does not match --expected-commit." >&2
    return 1
  fi
  if [[ -n "${advertised_commit}" && "${bundle_head}" != "${advertised_commit}" ]]; then
    echo "Deploy bundle is older than the branch currently advertised by GitHub." >&2
    return 1
  fi
  if ! git fetch --no-tags "${bundle_file}" "HEAD:${remote_ref}"; then
    return 1
  fi
  fetch_succeeded=true
  fetch_source="${source_label}"
}

if [[ -n "${manual_bundle}" ]]; then
  if [[ ! -r "${manual_bundle}" ]]; then
    echo "Cannot read manual deploy bundle: ${manual_bundle}" >&2
    exit 1
  fi
  import_deploy_bundle "${manual_bundle}" "verified manual bundle"
else
  for profile in "default transport" "HTTP/1.1 fallback"; do
    if probe_remote_branch "${profile}"; then
      break
    fi
  done

  if [[ -n "${advertised_commit}" && "${advertised_commit}" == "${current_commit}" ]]; then
    echo "Current: ${current_short}"
    echo "GitHub:  ${advertised_commit:0:12} (${deploy_branch})"
    echo "Production is already on the GitHub-advertised commit. No pack download was needed."
    exit 0
  fi

  if [[ -n "${advertised_commit}" ]] && git cat-file -e "${advertised_commit}^{commit}" 2>/dev/null; then
    git update-ref "${remote_ref}" "${advertised_commit}"
    fetch_succeeded=true
    fetch_source="GitHub-advertised commit already present locally"
  else
    for profile in "default transport" "HTTP/1.1 fallback" "low-bandwidth fallback"; do
      if fetch_remote_branch "${profile}"; then
        fetch_succeeded=true
        fetch_source="GitHub smart HTTP (${profile})"
        break
      fi
      sleep 2
    done
  fi

  if [[ "${fetch_succeeded}" != true ]]; then
    echo "Git smart HTTP was unavailable; downloading the repository's official deploy bundle..."
    install -d -m 0700 "${bundle_cache%/*}"
    bundle_download="$(mktemp "${bundle_cache}.download.XXXXXX")"
    if curl --fail --location --silent --show-error \
      --retry 3 --retry-delay 2 --retry-all-errors \
      --connect-timeout 15 --max-time 180 \
      --output "${bundle_download}" "${bundle_url}" && \
      import_deploy_bundle "${bundle_download}" "official GitHub release bundle"; then
      mv "${bundle_download}" "${bundle_cache}"
    else
      mv "${bundle_download}" "${bundle_download}.failed" >/dev/null 2>&1 || true
    fi
  fi
fi

if [[ "${fetch_succeeded}" != true ]]; then
  echo "Unable to obtain ${deploy_branch} from GitHub smart HTTP or the official release bundle." >&2
  exit 1
fi

target_commit="$(git rev-parse "${remote_ref}")"
target_short="${target_commit:0:12}"

if [[ -n "${advertised_commit}" && "${target_commit}" != "${advertised_commit}" ]]; then
  echo "Fetched target does not match the commit advertised by GitHub." >&2
  exit 1
fi

echo "Current: ${current_short}"
echo "Target:  ${target_short} (${deploy_branch})"
echo "Source:  ${fetch_source}"

if [[ "${current_commit}" == "${target_commit}" ]]; then
  echo "Production is already on the requested commit."
  exit 0
fi

if ! git merge-base --is-ancestor "${current_commit}" "${target_commit}"; then
  echo "Target is not a fast-forward descendant of Production; refusing to deploy." >&2
  exit 1
fi

if ! git diff --quiet "${current_commit}" "${target_commit}" -- package-lock.json; then
  echo "package-lock.json changed; use the reviewed manual dependency deployment procedure." >&2
  exit 1
fi

if [[ "${dry_run}" == true ]]; then
  echo "Dry run complete; no Production files or services were changed."
  exit 0
fi

if [[ "${confirmation}" != "DEPLOY" ]]; then
  echo "Deployment requires --confirm=DEPLOY." >&2
  exit 2
fi

worktree_parent="$(mktemp -d /tmp/japanese-words-deploy.XXXXXX)"
release_dir="${worktree_parent}/release"
staged_dist="$(mktemp -d /opt/japanese-words/.dist-next.XXXXXX)"
previous_dist="/opt/japanese-words/.dist-previous-${current_short}-$(date -u +%Y%m%dT%H%M%SZ)"
failed_dist="/opt/japanese-words/.dist-failed-${target_short}-$(date -u +%Y%m%dT%H%M%SZ)"
dist_swapped=false
code_advanced=false

cleanup() {
  git -C "${app_dir}" worktree remove --force "${release_dir}" >/dev/null 2>&1 || true
  rmdir "${worktree_parent}" >/dev/null 2>&1 || true
  if [[ -d "${staged_dist}" ]]; then
    if ! rmdir "${staged_dist}" >/dev/null 2>&1; then
      mv "${staged_dist}" "${failed_dist}" >/dev/null 2>&1 || true
      echo "Preserved the failed staged artifact at ${failed_dist}." >&2
    fi
  fi
}
trap cleanup EXIT

rollback() {
  echo "Deployment failed; restoring ${current_short}." >&2
  set +e
  if [[ "${dist_swapped}" == true ]]; then
    mv "${app_dir}/dist" "${failed_dist}"
    mv "${previous_dist}" "${app_dir}/dist"
  fi
  if [[ "${code_advanced}" == true ]]; then
    git -C "${app_dir}" reset --hard "${current_commit}"
  fi
  systemctl restart japanese-words.service
  systemctl reload nginx
  set -e
}

echo "Preparing and validating ${target_short} outside the live directory..."
git worktree add --detach "${release_dir}" "${target_commit}"
(
  cd "${release_dir}"
  npm ci
  npm run lint
  npm run typecheck
  npm test
  npm run build
)

cp -a "${release_dir}/dist/." "${staged_dist}/"
echo "Creating a complete workflow and image backup..."
node server/tencent-backup.mjs

if ! git merge --ff-only "${target_commit}"; then
  rollback
  exit 1
fi
code_advanced=true

if ! nginx -t; then
  rollback
  exit 1
fi

if ! mv "${app_dir}/dist" "${previous_dist}"; then
  rollback
  exit 1
fi
if ! mv "${staged_dist}" "${app_dir}/dist"; then
  mv "${previous_dist}" "${app_dir}/dist"
  rollback
  exit 1
fi
dist_swapped=true

if ! systemctl reload nginx; then
  rollback
  exit 1
fi
if ! systemctl restart japanese-words.service; then
  rollback
  exit 1
fi

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
  rollback
  exit 1
fi

install -d -m 0700 "${backup_root}/releases"
mv "${previous_dist}" "${backup_root}/releases/"
dist_swapped=false

echo "Production deployment completed: ${current_short} -> ${target_short}"
echo "Run SITE_URL=https://bijinihaitan.cn npm run smoke:production from a trusted workstation."
