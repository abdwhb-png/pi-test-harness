import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Verify sfw is available — fail early with a clear message
try {
	execFileSync("sfw", ["--version"], { encoding: "utf8", stdio: "pipe" });
} catch {
	console.error(
		"FATAL: sfw (Socket Firewall) is required. Install it first:\n  npm install -g sfw",
	);
	process.exit(1);
}

/**
 * Run a command via sfw for network calls.
 * Uses execFileSync directly for the sfw prefix, passing the real command as positional args.
 */
function sfwRun(args, options = {}) {
	// sfw npm install ... → execFileSync("sfw", ["npm", "install", ...])
	execFileSync("sfw", args, {
		stdio: "inherit",
		...options,
	});
}

const root = resolve(import.meta.dirname, "..");
const { name: PACKAGE_NAME } = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);

// 1. Pack the package
const packOutput = execFileSync("npm", ["pack", "--json"], {
	cwd: root,
	encoding: "utf8",
});
const packResult = JSON.parse(packOutput);
// npm pack --json may return an array (older) or object keyed by name (newer)
const packEntry = Array.isArray(packResult)
	? packResult[0]
	: packResult[PACKAGE_NAME];
const filename = packEntry?.filename;
if (!filename) {
	console.error(
		"Failed to parse npm pack output:",
		JSON.stringify(packResult).slice(0, 200),
	);
	process.exit(1);
}
const tarball = join(root, filename);

// 2. Create consumer directory
const consumerDir = mkdtempSync(join(tmpdir(), "pi-test-harness-consumer-"));

try {
// 3. Install via sfw with exact Pi 0.84.2 peers
	writeFileSync(
		join(consumerDir, "package.json"),
		JSON.stringify({ type: "module", private: true }, null, 2),
	);

	console.log("Installing package + exact Pi 0.84.2 peers via sfw...");
	sfwRun(
		[
			"npm",
			"install",
			"--silent",
			"--save-exact",
			tarball,
			"@earendil-works/pi-agent-core@0.84.2",
			"@earendil-works/pi-ai@0.84.2",
			"@earendil-works/pi-coding-agent@0.84.2",
		],
		{ cwd: consumerDir },
	);

	// 4. Verify imports and run a real session
	writeFileSync(
		join(consumerDir, "smoke.mjs"),
		`
import {
  createMockPi,
  createTestSession,
  when,
  calls,
  says,
} from "${PACKAGE_NAME}";

// Static exports
if (typeof createMockPi !== "function") throw new Error("createMockPi missing");
if (typeof createTestSession !== "function") throw new Error("createTestSession missing");
if (typeof when !== "function" || typeof calls !== "function" || typeof says !== "function") {
  throw new Error("playbook DSL exports missing");
}

// Real session — say-only playbook, no credentials, no network
const t = await createTestSession();
await t.run(when("Smoke test", [says("ok")]));
if (t.playbook.consumed !== 1) throw new Error("Expected 1 consumed action");
if (t.playbook.remaining !== 0) throw new Error("Expected 0 remaining actions");
console.log("session: say-only playbook OK");
console.log("  consumed:", t.playbook.consumed);
console.log("  remaining:", t.playbook.remaining);
t.dispose();
console.log("\\nconsumer smoke OK");
`,
	);

	console.log("Running smoke test...");
	execFileSync("node", ["smoke.mjs"], { cwd: consumerDir, stdio: "inherit" });
} finally {
	rmSync(tarball, { force: true });
	rmSync(consumerDir, { recursive: true, force: true });
}
