---
"@abdwhb-png/pi-test-harness": patch
---

Clear all open dependency advisories, and take vitest to 5.

`sfw npm audit` reported 6 vulnerabilities (3 moderate, 3 high) in the dev tooling — vitest's mocker, postcss, nanoid, brace-expansion and js-yaml — which made the verify job's audit step fail. `vitest` moves from 3.2.7 to 5.0.1 and the remaining transitive advisories are resolved, taking the audit to zero. The suite needed no configuration change for vitest 5.
