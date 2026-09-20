---
"@abdwhb-png/pi-test-harness": patch
---

Upgrade the harness to Pi 0.84 and keep runtime API-key initialization offline through Pi's native synchronization path.

(The packed consumer smoke test installs the peers declared in `package.json` as of the 0.85 upgrade, so it is no longer pinned to a literal Pi version here.)
