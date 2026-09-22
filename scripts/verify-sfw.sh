#!/usr/bin/env bash
# Bootstrap Socket Firewall and prove it works before any `sfw npm ...` step.
#
# **Why the retries**: on a cold cache sfw must resolve its own release through
# the *unauthenticated* GitHub API before it can do anything, and any failure
# there is fatal:
#
#   [sfw] Failed to prepare firewall binary: Unable to fetch latest release and
#   no valid cached release found.
#
# GitHub Actions runners share IPs, so that call hits a per-hour quota. Retrying
# therefore only covers a cold start that lands on a throttled runner; it cannot
# outlast the quota. The durable fix is the cache in ci.yml: sfw keeps its binary
# in `.sfw-cache` *inside its own install directory* (not `~/.sfw-cache`), so
# ci.yml installs it into the workspace and caches that path. With a warm cache
# and SFW_SKIP_UPDATE_CHECK set, sfw makes no network call at all.
#
# Retrying stays as cold-start insurance: the download is idempotent, and the job
# still fails loudly if every attempt fails, so a real outage cannot pass
# silently.
set -euo pipefail

attempts="${SFW_VERIFY_ATTEMPTS:-3}"
delay="${SFW_VERIFY_DELAY_SECONDS:-20}"

# Pure-bash counter: `seq` is not guaranteed to exist on a minimal PATH, and a
# missing `seq` would empty the loop list and skip every attempt silently.
for ((attempt = 1; attempt <= attempts; attempt++)); do
	if sfw --version; then
		exit 0
	fi
	if [ "$attempt" -lt "$attempts" ]; then
		echo "sfw bootstrap failed (attempt ${attempt}/${attempts}); retrying in ${delay}s" >&2
		# A missing `sleep` must not abort the retries: worst case they run back
		# to back, which is still better than failing on attempt 1.
		sleep "$delay" || true
	fi
done

echo "sfw could not prepare its binary after ${attempts} attempts" >&2
exit 1
