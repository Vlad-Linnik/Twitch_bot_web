#!/usr/bin/env bash
#
# Deploy TwitchBot-Web on the production host.
#
#   ./deploy/deploy.sh
#
# Environment overrides:
#   PM2_APP    pm2 app name or id to restart   (default: 2)
#   SITE_URL   public URL, for the post-deploy checks
#   SKIP_CHECK set to 1 to skip the post-deploy HTTP checks
#
# Everything below is wrapped in main() and only invoked on the last line. That is
# load-bearing, not style: bash reads a script incrementally as it executes, and this
# script git-pulls the very file it is running from. Without the wrapper, a pull that
# changes deploy.sh shifts the byte offsets underneath the interpreter and it resumes
# mid-statement in whatever happens to be at that position.
set -euo pipefail

PM2_APP="${PM2_APP:-2}"
SITE_URL="${SITE_URL:-https://chatwizardbot.ddns.net}"

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  echo "==> $(pwd)"

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$branch" != "main" ]; then
    echo "!! on branch '$branch', not main - aborting" >&2
    exit 1
  fi

  # package-lock.json drifts on its own here, because a plain `npm install` rewrites it
  # (patch bumps inside the ^ ranges, plus "peer" metadata this npm version records
  # differently from the one the lockfile was authored with). It is a generated file and
  # nothing on this host ever authors it deliberately, so discarding is always correct -
  # and it is the whole reason `git pull` kept refusing to run. npm ci below is what stops
  # it coming back; this stays as the cleanup for drift already on disk.
  if ! git diff --quiet -- package-lock.json; then
    echo "==> discarding local package-lock.json drift"
    git checkout -- package-lock.json
  fi

  # Anything ELSE dirty is a real edit made straight on the server. Never silently destroy
  # it - stop and let a human decide.
  if ! git diff --quiet || [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "!! uncommitted changes on the server - aborting:" >&2
    git status --short >&2
    exit 1
  fi

  local before after
  before="$(git rev-parse HEAD)"
  echo "==> git pull"
  git pull --ff-only
  after="$(git rev-parse HEAD)"

  if [ "$before" = "$after" ]; then
    echo "==> already up to date ($after)"
  else
    echo "==> $before -> $after"
  fi

  # npm ci, never npm install: it installs strictly from the lockfile and never writes to
  # it, which is what keeps the drift above from returning. The cost is that it deletes
  # node_modules wholesale, so a failed install leaves the app unable to start - hence
  # running it only when the dependency files actually changed, rather than every deploy.
  if [ ! -d node_modules ]; then
    echo "==> npm ci (no node_modules)"
    npm ci
  elif [ "$before" != "$after" ] && ! git diff --quiet "$before" "$after" -- package.json package-lock.json; then
    echo "==> npm ci (dependencies changed)"
    npm ci
  else
    echo "==> npm ci skipped (dependencies unchanged)"
  fi

  # public/css/output.css is gitignored, so it is never delivered by the pull and has to be
  # rebuilt here. Tailwind v4 skips the write entirely when the output is byte-identical,
  # which matters: lib/assetVersion.js fingerprints this file by mtime+size, so a no-op
  # rebuild correctly leaves the ?v= URL - and every browser's cached copy - alone.
  echo "==> npm run build:css"
  npm run build:css

  echo "==> pm2 restart $PM2_APP"
  pm2 restart "$PM2_APP"

  if [ "${SKIP_CHECK:-0}" = "1" ]; then
    echo "==> checks skipped"
    return 0
  fi

  # pm2 returns as soon as it has signalled the process; the app still has to boot and
  # connect to Mongo before it can answer.
  sleep 3
  check
}

# Verifies the deploy actually took, rather than trusting that a restart implies a healthy
# app. Each check is a property that is false on the previous release, so a silently
# no-op'd deploy fails here instead of looking like a success.
check() {
  local failed=0

  echo "==> checking $SITE_URL"

  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$SITE_URL/")"
  if [ "$code" = "200" ]; then
    echo "    [ok]   home responds 200"
  else
    echo "    [FAIL] home responds $code"
    failed=1
  fi

  # A real GET, not `curl -I`: HEAD has no body, so the compression middleware never
  # engages and the header is legitimately absent even on a correctly deployed app. Using
  # -I here reported a false failure against a known-good server.
  if curl -s -o /dev/null -D - --max-time 15 -H 'Accept-Encoding: gzip' "$SITE_URL/" | grep -qi '^content-encoding: gzip'; then
    echo "    [ok]   responses are compressed"
  else
    echo "    [FAIL] no Content-Encoding: gzip"
    failed=1
  fi

  # `|| true` is required, not defensive noise: under `set -e` with pipefail, grep finding
  # nothing fails the whole assignment and kills the script - which would abort the run at
  # the first failed check and defeat the point of accumulating `failed` to report all of them.
  local css
  css="$(curl -s --max-time 15 "$SITE_URL/" | grep -o 'output\.css?v=[a-f0-9]\{8\}' | head -1 || true)"
  if [ -n "$css" ]; then
    echo "    [ok]   assets fingerprinted ($css)"
    if curl -s -o /dev/null -D - --max-time 15 "$SITE_URL/css/$css" | grep -qi 'cache-control:.*immutable'; then
      echo "    [ok]   fingerprinted assets are immutable"
    else
      # Non-fatal on its own: the page is correct, only the caching hint is missing.
      echo "    [warn] fingerprinted CSS is not served immutable"
    fi
  else
    echo "    [FAIL] no fingerprinted output.css in the HTML"
    failed=1
  fi

  if [ "$failed" -ne 0 ]; then
    echo "!! deploy checks failed - inspect with: pm2 logs $PM2_APP --lines 50" >&2
    exit 1
  fi
  echo "==> deployed"
}

main "$@"
