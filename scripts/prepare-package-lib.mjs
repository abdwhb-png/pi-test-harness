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
 * Create a tarball at dist/package.tgz from the prepared dist/package/ directory.
 * Uses npm pack with execFileSync (no shell interpolation) for deterministic output.
 * Returns the path to the tarball.
 */
export function packageTarball(rootDir) {
	const distDir = join(rootDir, "dist");
	const packageDir = join(distDir, "package");
	const tarballPath = join(distDir, "package.tgz");

	if (!existsSync(packageDir)) {
		throw new Error("dist/package/ not found — run prepare-package first");
	}

	// npm pack from dist/package/ (which has its own minimal package.json)
	// --pack-destination outputs to dist/; the filename is scoped-package-version.tgz
	const result = execFileSync(
		"npm",
		["pack", "--pack-destination", distDir, "--quiet"],
		{ cwd: packageDir, encoding: "utf8" },
	).trim();

	// result is the filename npm wrote (e.g. abdwhb-png-pi-test-harness-0.7.0.tgz)
	const generatedTarball = join(distDir, result);

	if (!existsSync(generatedTarball)) {
		throw new Error(`npm pack did not produce expected tarball: ${result}`);
	}

	// Rename to stable dist/package.tgz
	renameSync(generatedTarball, tarballPath);

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
	const rootPkg = JSON.parse(
		readFileSync(join(rootDir, "package.json"), "utf-8"),
	);
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