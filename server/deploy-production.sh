#!/usr/bin/env bash
set -euo pipefail

app_dir="${JAPANESE_WORDS_APP_DIR:-/opt/japanese-words/app}"
deploy_branch="${JAPANESE_WORDS_DEPLOY_BRANCH:-codex/fix-daily-automation-assets}"
backup_root="${JAPANESE_WORDS_BACKUP_DIR:-/var/backups/japanese-words}"
lock_file="${JAPANESE_WORDS_DEPLOY_LOCK:-/run/japanese-words-deploy.lock}"
confirmation=""
dry_run=false

for argument in "$@"; do
  case "${argument}" in
    --confirm=*) confirmation="${argument#--confirm=}" ;;
    --dry-run) dry_run=true ;;
    --branch=*) deploy_branch="${argument#--branch=}" ;;
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

for command_name in curl flock git nginx node npm systemctl timeout; do
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
fetch_succeeded=false
for attempt in 1 2 3; do
  echo "Fetching ${deploy_branch} (attempt ${attempt}/3)..."
  if timeout 45 git fetch --prune origin \
    "refs/heads/${deploy_branch}:${remote_ref}"; then
    fetch_succeeded=true
    break
  fi
  sleep "$((attempt * 2))"
done

if [[ "${fetch_succeeded}" != true ]]; then
  echo "Unable to fetch ${deploy_branch} after three attempts." >&2
  exit 1
fi

current_commit="$(git rev-parse HEAD)"
target_commit="$(git rev-parse "${remote_ref}")"
current_short="${current_commit:0:12}"
target_short="${target_commit:0:12}"

echo "Current: ${current_short}"
echo "Target:  ${target_short} (${deploy_branch})"

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
