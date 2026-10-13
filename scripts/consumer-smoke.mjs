import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";

const { values: { runtime } } = parseArgs({
	options: { runtime: { type: "string", default: "node" } },
});
if (runtime !== "node" && runtime !== "bun") {
	throw new Error(`Unsupported consumer runtime: ${runtime}. Use node or bun.`);
}

const root = resolve(import.meta.dirname, "..");
const { name: packageName, version, peerDependencies, devDependencies } = JSON.parse(
	readFileSync(join(root, "package.json"), "utf8"),
);
// Pin qualification to the canonical development versions rather than
// silently selecting a new Pi patch from the peer ranges.
const peerVersions = Object.fromEntries(Object.keys(peerDependencies).map((name) => {
	const pinned = devDependencies[name];
	if (!/^\d+\.\d+\.\d+$/.test(pinned ?? "")) {
		throw new Error(`Consumer smoke requires an exact development version for ${name}`);
	}
	return [name, pinned];
}));
const peerSpecs = Object.entries(peerVersions).map(([name, pinned]) => `${name}@${pinned}`);
const minimalTarball = join(root, "dist", "package.tgz");
if (!existsSync(minimalTarball)) {
	throw new Error("dist/package.tgz not found — run npm run build first");
}
const { _npmSubprocessEnv, _resolveExecutable, _spawnTarget } = await import("../dist/sandbox.js");
try {
	const target = _spawnTarget(_resolveExecutable("sfw"), ["--version"]);
	execFileSync(target.command, target.args, { encoding: "utf8", stdio: "pipe" });
} catch (err) {
	throw new Error("Socket Firewall is required for consumer installation", { cause: err });
}
const smokeDir = mkdtempSync(join(tmpdir(), "pi-test-harness-consumer-"));

try {
	const packTarget = _spawnTarget(_resolveExecutable("npm"), ["pack", "--json", "--pack-destination", smokeDir]);
	const packResult = JSON.parse(execFileSync(packTarget.command, packTarget.args, {
		cwd: root,
		encoding: "utf8",
		env: _npmSubprocessEnv(),
	}));
	const packEntry = Array.isArray(packResult) ? packResult[0] : packResult[packageName];
	if (!packEntry?.filename) {
		throw new Error("npm pack output did not contain a tarball filename");
	}

	for (const [artifact, tarball] of [
		["npm pack", join(smokeDir, packEntry.filename)],
		["dist/package.tgz", minimalTarball],
	]) {
		const consumerDir = mkdtempSync(join(smokeDir, "installed-"));
		writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2));
		console.log(`Installing ${artifact} + exact peers via sfw (${peerSpecs.join(", ")})...`);
		const installTarget = _spawnTarget(_resolveExecutable("sfw"), ["npm", "install", "--save-exact", tarball, ...peerSpecs]);
		execFileSync(installTarget.command, installTarget.args, {
			cwd: consumerDir,
			stdio: "inherit",
			env: _npmSubprocessEnv(),
		});
		copyFileSync(join(root, "scripts", "consumer-scenario.mjs"), join(consumerDir, "smoke.mjs"));
		execFileSync(runtime, ["smoke.mjs", packageName, runtime, version, JSON.stringify(peerDependencies), JSON.stringify(peerVersions)], {
			cwd: consumerDir,
			stdio: "inherit",
		});
		console.log(`${artifact}: consumer smoke OK (${runtime})`);
	}
} finally {
	rmSync(smokeDir, { recursive: true, force: true });
}
