/**
 * Core logic for generating a minimal dist/package directory.
 *
 * Separated from the CLI runner so it can be imported and tested directly.
 */

import {
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Read the root package.json and generate a minimal package.json for the
 * consumer-facing dist/package directory.
 *
 * The generated package.json includes only:
 *   - name, version, type
 *   - exports (with paths adjusted relative to dist/package)
 *   - peerDependencies
 *
 * It explicitly excludes devDependencies, scripts, files, and publish metadata.
 */
export function generatePackageJson(rootPkg) {
	const pkg = {
		name: rootPkg.name,
		version: rootPkg.version,
		type: rootPkg.type,
		exports: structuredClone(rootPkg.exports),
		peerDependencies: structuredClone(rootPkg.peerDependencies),
	};

	// Adjust exports paths to be relative to dist/package (same level as dist/)
	// The root exports point to ./dist/*; since dist/package is inside dist/,
	// we strip the ./dist/ prefix so paths resolve correctly.
	if (pkg.exports && typeof pkg.exports === "object") {
		for (const [key, val] of Object.entries(pkg.exports)) {
			if (val && typeof val === "object" && !Array.isArray(val)) {
				const entry = { ...val };
				for (const [subKey, subVal] of Object.entries(entry)) {
					if (typeof subVal === "string" && subVal.startsWith("./dist/")) {
						entry[subKey] = "." + subVal.slice("./dist".length);
					}
				}
				pkg.exports[key] = entry;
			} else if (typeof val === "string" && val.startsWith("./dist/")) {
				pkg.exports[key] = "." + val.slice("./dist".length);
			}
		}
	}

	return pkg;
}

/**
 * Determine whether a file in the dist/ directory should be included in the
 * generated dist/package.
 */
export function isDistArtifact(filename) {
	if (filename.startsWith(".")) return false;
	if (filename === "package") return false;

	return (
		filename.endsWith(".js") ||
		filename.endsWith(".d.ts") ||
		filename.endsWith(".d.ts.map") ||
		filename.endsWith(".js.map") ||
		filename === "mock-pi-script.mjs"
	);
}

/**
 * Copy all compiled artifacts from dist/ to dist/package/.
 */
export function copyDistArtifacts(distDir, packageDir) {
	const entries = readdirSync(distDir, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!isDistArtifact(entry.name)) continue;

		const src = join(distDir, entry.name);
		const dest = join(packageDir, entry.name);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(src, dest);
	}
}

/**
 * Recursively verify that package entries are physical files or directories.
 *
 * Uses lstatSync (which does NOT follow symlinks) so nested symlinks fail closed.
 */
export function verifyNoSymlinks(packageDir) {
	const entries = readdirSync(packageDir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = join(packageDir, entry.name);
		const stats = lstatSync(fullPath);
		if (stats.isSymbolicLink()) {
			throw new Error(`${fullPath} is a symlink`);
		}
		if (stats.isDirectory()) {
			verifyNoSymlinks(fullPath);
			continue;
		}
		if (!stats.isFile()) {
			throw new Error(`${fullPath} is not a regular file`);
		}
	}
}

/**
 * How to invoke npm from a child process, portably.
 *
 * **Why not just `execFileSync("npm", ...)`**: on Windows npm is the `npm.cmd`
 * shim, and child_process does not apply PATHEXT when creating a process, so the
 * spawn fails with `ENOENT` — which is what broke the Windows integration job at
 * the tarball step. Running npm's own CLI script under the Node binary that is
 * already executing this script works on every platform, needs no shell, and
 * guarantees the same npm that started the run. The fallback covers a direct
 * `node scripts/prepare-package.mjs`, where npm exports no `npm_execpath`.
 */
function npmInvocation() {
	const execPath = process.env.npm_execpath;
	if (execPath && /\.(c|m)?js$/.test(execPath)) {
		return { command: process.execPath, args: [execPath], shell: false };
	}
	// A `.cmd` shim cannot be executed without a shell on Windows.
	if (process.platform === "win32") {
		return { command: "npm.cmd", args: [], shell: true };
	}
	return { command: "npm", args: [], shell: false };
}

/**
 * Names of the tarballs sitting directly in a directory.
 */
function listTarballs(dir) {
	return new Set(
		readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
			.map((entry) => entry.name),
	);
}

/**
 * Create a tarball at dist/package.tgz from the prepared dist/package/ directory.
 * Uses npm pack via {@link npmInvocation} (no shell interpolation) so the call
 * works on Windows. Returns the path to the tarball.
 *
 * Which file npm wrote is worked out by comparing the directory before and after,
 * not by reading npm's stdout. `npm pack` prints the bare filename only while
 * npm_config_json is unset, and npm exports its own config into the environment of
 * the scripts it runs: changesets publishes with --json, so the pack nested inside
 * `npm publish` printed a JSON document where a filename was expected.
 */
export function packageTarball(rootDir) {
	const distDir = join(rootDir, "dist");
	const packageDir = join(distDir, "package");
	const tarballPath = join(distDir, "package.tgz");

	if (!existsSync(packageDir)) {
		throw new Error("dist/package/ not found — run prepare-package first");
	}

	const before = listTarballs(distDir);

	// npm pack from dist/package/ (which has its own minimal package.json), with
	// --pack-destination putting the archive in dist/ under npm's own name.
	const npm = npmInvocation();
	execFileSync(
		npm.command,
		[...npm.args, "pack", "--pack-destination", distDir, "--quiet"],
		{ cwd: packageDir, shell: npm.shell },
	);

	const created = [...listTarballs(distDir)].filter(
		(name) => !before.has(name),
	);
	if (created.length !== 1) {
		throw new Error(
			`npm pack wrote ${created.length} tarballs, expected one: ` +
				(created.join(", ") || distDir),
		);
	}

	// Rename to stable dist/package.tgz
	renameSync(join(distDir, created[0]), tarballPath);

	// Verify the tarball exists and is a regular file
	const stats = statSync(tarballPath);
	if (!stats.isFile()) {
		throw new Error(`${tarballPath} is not a regular file`);
	}

	return tarballPath;
}

/**
 * Run the full prepare-package workflow.
 * Returns the generated package.json so callers can inspect it.
 */
/**
 * Read and parse a JSON file, naming the file in the failure rather than
 * surfacing a bare SyntaxError from somewhere inside this pipeline.
 */
function readJsonFile(filePath) {
	let raw;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (err) {
		throw new Error(`Could not read ${filePath}: ${err.message}`, {
			cause: err,
		});
	}
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new Error(`Invalid JSON in ${filePath}: ${err.message}`, {
			cause: err,
		});
	}
}

export function preparePackage(rootDir) {
	const distDir = join(rootDir, "dist");
	const packageDir = join(distDir, "package");

	if (!existsSync(distDir)) {
		throw new Error("dist/ directory not found — run build first");
	}

	rmSync(packageDir, { recursive: true, force: true });
	mkdirSync(packageDir, { recursive: true });

	// 1. Copy compiled artifacts and bundled skills
	copyDistArtifacts(distDir, packageDir);
	const skillsDir = join(rootDir, "skills");
	if (existsSync(skillsDir)) {
		cpSync(skillsDir, join(packageDir, "skills"), { recursive: true });
	}

	// 2. Write minimal package.json
	const rootPkg = readJsonFile(join(rootDir, "package.json"));
	const pkg = generatePackageJson(rootPkg);
	const pkgJsonPath = join(packageDir, "package.json");
	writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");

	// 3. Verify no symlinks
	verifyNoSymlinks(packageDir);

	// 4. Self-check: no devDependencies, scripts, or files in generated pkg
	if (pkg.devDependencies) {
		throw new Error("generated package.json must not contain devDependencies");
	}
	if (pkg.scripts) {
		throw new Error("generated package.json must not contain scripts");
	}
	if (pkg.files) {
		throw new Error("generated package.json must not contain files");
	}

	return pkg;
}
