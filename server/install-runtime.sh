#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root."
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${repo_root}" != "/opt/japanese-words/app" ]]; then
  echo "Expected repository at /opt/japanese-words/app, found ${repo_root}."
  exit 1
fi

cd "${repo_root}"

id japanese-words >/dev/null 2>&1 || useradd --system --home-dir /var/lib/japanese-words --shell /sbin/nologin japanese-words
install -d -m 0700 -o japanese-words -g japanese-words /var/lib/japanese-words /var/backups/japanese-words
install -d -m 0755 /etc/nginx/conf.d
install -d -m 0755 /var/lib/letsencrypt/.well-known/acme-challenge

if [[ ! -f /etc/japanese-words.env ]]; then
  install -m 0600 server/tencent.env.example /etc/japanese-words.env
  echo "Created /etc/japanese-words.env; replace placeholder secrets before starting the service."
fi

npm ci
npm run build

install -m 0644 server/nginx/japanese-words-http.conf /etc/nginx/conf.d/japanese-words.conf
install -m 0644 server/systemd/japanese-words.service /etc/systemd/system/japanese-words.service
install -m 0644 server/systemd/japanese-words-backup.service /etc/systemd/system/japanese-words-backup.service
install -m 0644 server/systemd/japanese-words-backup.timer /etc/systemd/system/japanese-words-backup.timer
install -m 0644 server/systemd/japanese-words-weekly-check.service /etc/systemd/system/japanese-words-weekly-check.service
install -m 0644 server/systemd/japanese-words-weekly-check.timer /etc/systemd/system/japanese-words-weekly-check.timer

systemctl daemon-reload
nginx -t
echo "Runtime files installed. Import data and configure secrets before enabling services."
