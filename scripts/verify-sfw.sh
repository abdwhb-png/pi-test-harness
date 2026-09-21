#!/usr/bin/env bash
# Bootstrap Socket Firewall and prove it works before any `sfw npm ...` step.
#
# **Why the retries**: on first use sfw resolves its own release through the
# *unauthenticated* GitHub API and caches the binary under ~/.sfw-cache. GitHub
# Actions runners share IPs, so that call is periodically rate-limited and sfw
# exits with:
#
#   [sfw] Failed to prepare firewall binary: Unable to fetch latest release and
#   no valid cached release found.
#
# That is a transient infrastructure failure with nothing to do with this
# repository. Retrying is safe — the download is idempotent and cached — and the
# job still fails loudly if every attempt fails, so a real outage cannot pass
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
