#!/usr/bin/env node
/**
 * CLI entry point for the prepare-package workflow.
 * Imports core logic from prepare-package-lib.mjs.
 */

import { statSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { preparePackage, packageTarball } from "./prepare-package-lib.mjs";

const ROOT = resolve(import.meta.dirname, "..");

try {
	const pkg = preparePackage(ROOT);

	// Report dist/package
	const packageDir = join(ROOT, "dist", "package");
	const files = readdirSync(packageDir).filter(
		(f) => f !== "." && f !== "..",
	);
	const totalSize = files.reduce((acc, f) => {
		try {
			return acc + statSync(join(packageDir, f)).size;
		} catch {
			return acc;
		}
	}, 0);

	console.log(
		`dist/package ready: ${files.length} files, ${(totalSize / 1024).toFixed(1)} KB`,
	);
	console.log(`  name: ${pkg.name}@${pkg.version}`);
	console.log(`  peerDependencies: ${Object.keys(pkg.peerDependencies).length}`);

	// Create tarball
	const tarballPath = packageTarball(ROOT);
	const tarballStats = statSync(tarballPath);
	console.log(
		`dist/package.tgz: ${(tarballStats.size / 1024).toFixed(1)} KB`,
	);
} catch (err) {
	console.error(`prepare-package failed:`, err.message);
	process.exit(1);
}