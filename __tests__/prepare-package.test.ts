/**
 * Tests for the dist/package generation helper.
 *
 * Verifies that prepare-package-lib.mjs correctly generates a minimal
 * consumer-facing package from build output.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	symlinkSync,
	rmSync,
	existsSync,
	lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
	generatePackageJson,
	isDistArtifact,
	copyDistArtifacts,
	verifyNoSymlinks,
	packageTarball,
	preparePackage,
} from "../scripts/prepare-package-lib.mjs";

let fixtureDir: string;

beforeEach(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "prepare-package-test-"));
});

afterEach(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
});

function createMockRootPackage(distFiles: string[], rootPkg?: Record<string, unknown>) {
	// Write root package.json
	const pkg = {
		name: "@test/test-package",
		version: "1.0.0",
		type: "module",
		exports: {
			".": {
				types: "./dist/index.d.ts",
				import: "./dist/index.js",
			},
		},
		peerDependencies: {
			"@earendil-works/pi-agent-core": "^0.83.0",
			"@earendil-works/pi-coding-agent": "^0.83.0",
		},
		devDependencies: {
			vitest: "^3.0.0",
			eslint: "^9.0.0",
		},
		scripts: {
			build: "tsc",
			test: "vitest run",
		},
		files: ["dist/**", "src/**"],
		...rootPkg,
	};
	writeFileSync(join(fixtureDir, "package.json"), JSON.stringify(pkg, null, 2));

	// Create dist/ with mock files
	const distDir = join(fixtureDir, "dist");
	mkdirSync(distDir, { recursive: true });
	for (const file of distFiles) {
		writeFileSync(join(distDir, file), `// ${file} content`);
	}

	return pkg;
}

function createMockSkill() {
	const skillDir = join(fixtureDir, "skills", "pi-test-harness");
	mkdirSync(join(skillDir, "references"), { recursive: true });
	mkdirSync(join(skillDir, "evals"), { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "---\nname: pi-test-harness\n---\n");
	writeFileSync(join(skillDir, "references", "api-reference.md"), "# API\n");
	writeFileSync(
		join(skillDir, "evals", "evals.json"),
		JSON.stringify({ skill_name: "pi-test-harness", evals: [] }),
	);
	return skillDir;
}

describe("generatePackageJson", () => {
	it("returns a minimal package.json without devDependencies, scripts, or files", () => {
		const rootPkg = {
			name: "@test/pkg",
			version: "0.1.0",
			type: "module",
			exports: {
				".": {
					types: "./dist/index.d.ts",
					import: "./dist/index.js",
				},
			},
			peerDependencies: {
				"@earendil-works/pi-agent-core": "^0.83.0",
			},
			devDependencies: { vitest: "^3.0.0" },
			scripts: { build: "tsc" },
			files: ["dist/**"],
		};

		const result = generatePackageJson(rootPkg);

		expect(result).toEqual({
			name: "@test/pkg",
			version: "0.1.0",
			type: "module",
			exports: {
				".": {
					types: "./index.d.ts",
					import: "./index.js",
				},
			},
			peerDependencies: {
				"@earendil-works/pi-agent-core": "^0.83.0",
			},
		});

		// Must NOT have these keys
		expect(result).not.toHaveProperty("devDependencies");
		expect(result).not.toHaveProperty("scripts");
		expect(result).not.toHaveProperty("files");
	});

	it("strips ./dist/ prefix from exports paths", () => {
		const rootPkg = {
			name: "@test/pkg",
			version: "0.1.0",
			type: "module",
			exports: {
				".": "./dist/index.js",
				"./utils": {
					types: "./dist/utils.d.ts",
					import: "./dist/utils.js",
				},
			},
			peerDependencies: {},
		};

		const result = generatePackageJson(rootPkg);

		expect(result.exports).toEqual({
			".": "./index.js",
			"./utils": {
				types: "./utils.d.ts",
				import: "./utils.js",
			},
		});
	});
});

describe("isDistArtifact", () => {
	it("accepts .js, .d.ts, .d.ts.map, .js.map, and mock-pi-script.mjs", () => {
		expect(isDistArtifact("index.js")).toBe(true);
		expect(isDistArtifact("index.d.ts")).toBe(true);
		expect(isDistArtifact("index.d.ts.map")).toBe(true);
		expect(isDistArtifact("index.js.map")).toBe(true);
		expect(isDistArtifact("mock-pi-script.mjs")).toBe(true);
	});

	it("rejects hidden files, package directory, and non-compiled files", () => {
		expect(isDistArtifact(".hidden")).toBe(false);
		expect(isDistArtifact("package")).toBe(false);
		expect(isDistArtifact("source.ts")).toBe(false);
		expect(isDistArtifact("readme.md")).toBe(false);
		expect(isDistArtifact("CHANGELOG.md")).toBe(false);
	});
});

describe("copyDistArtifacts", () => {
	it("copies only compiled artifacts to dist/package/", () => {
		createMockRootPackage([
			"index.js",
			"index.d.ts",
			"index.js.map",
			"index.d.ts.map",
			"mock-pi-script.mjs",
			"source.ts", // should NOT be copied
			"readme.md", // should NOT be copied
		]);

		const distDir = join(fixtureDir, "dist");
		const packageDir = join(distDir, "package");

		copyDistArtifacts(distDir, packageDir);

		const copiedFiles = readdirSync(packageDir).sort();
		expect(copiedFiles).toEqual([
			"index.d.ts",
			"index.d.ts.map",
			"index.js",
			"index.js.map",
			"mock-pi-script.mjs",
		]);
	});
});

describe("verifyNoSymlinks", () => {
	it("passes when all files are regular", () => {
		createMockRootPackage(["index.js", "index.d.ts"]);
		const distDir = join(fixtureDir, "dist");
		const packageDir = join(distDir, "package");
		copyDistArtifacts(distDir, packageDir);

		expect(() => verifyNoSymlinks(packageDir)).not.toThrow();
	});

	it("accepts nested directories containing only physical files", () => {
		const packageDir = join(fixtureDir, "dist", "package");
		const skillDir = join(packageDir, "skills", "pi-test-harness");
		mkdirSync(join(skillDir, "references"), { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "# Skill\n");
		writeFileSync(join(skillDir, "references", "api.md"), "# API\n");

		expect(() => verifyNoSymlinks(packageDir)).not.toThrow();
	});

	it("throws when a nested skill file is a symlink", () => {
		const packageDir = join(fixtureDir, "dist", "package");
		const skillDir = join(packageDir, "skills", "pi-test-harness");
		mkdirSync(skillDir, { recursive: true });
		const target = join(fixtureDir, "target.md");
		writeFileSync(target, "content");
		symlinkSync(target, join(skillDir, "SKILL.md"));

		expect(() => verifyNoSymlinks(packageDir)).toThrow("symlink");
	});
});

describe("packageTarball", () => {
	it("creates dist/package.tgz with a stable filename from dist/package/", () => {
		createMockRootPackage([
			"index.js",
			"index.d.ts",
			"index.js.map",
			"index.d.ts.map",
			"mock-pi-script.mjs",
			"playbook.js",
			"playbook.d.ts",
			"session.js",
			"session.d.ts",
		]);
		createMockSkill();

		// Prepare dist/package first
		preparePackage(fixtureDir);

		const tarballPath = packageTarball(fixtureDir);

		// Stable name: dist/package.tgz
		expect(tarballPath).toBe(join(fixtureDir, "dist", "package.tgz"));
		expect(existsSync(tarballPath)).toBe(true);

		// Tarball contains only the package files (no source, no node_modules)
		const listing = execFileSync("tar", ["-tf", tarballPath], {
			encoding: "utf8",
			// bsdtar on Windows terminates every line with CRLF; a bare split("\n")
			// leaves a trailing \r on each entry and fails every toContain below.
		})
			.split(/\r?\n/)
			.filter(Boolean);

		// package/ prefix per npm tarball convention
		expect(listing).toContain("package/index.js");
		expect(listing).toContain("package/index.d.ts");
		expect(listing).toContain("package/mock-pi-script.mjs");
		expect(listing).toContain("package/package.json");
		expect(listing).toContain("package/skills/pi-test-harness/SKILL.md");
		expect(listing).toContain(
			"package/skills/pi-test-harness/references/api-reference.md",
		);
		expect(listing).toContain("package/skills/pi-test-harness/evals/evals.json");

		// No source files or node_modules leaked
		expect(listing.some((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))).toBe(false);
		expect(listing.some((f) => f.includes("node_modules"))).toBe(false);
		expect(listing.some((f) => f.includes("CHANGELOG.md") || f.includes("README.md"))).toBe(false);
	});

	it("packed package.json has peerDependencies but no scripts or devDependencies", () => {
		createMockRootPackage(["index.js", "index.d.ts"]);
		preparePackage(fixtureDir);

		const tarballPath = packageTarball(fixtureDir);

		// Extract package.json from the tarball to a temp dir and read it
		const extractDir = join(fixtureDir, "extract");
		mkdirSync(extractDir, { recursive: true });
		execFileSync("tar", ["-xf", tarballPath, "-C", extractDir]);

		const packedPkg = JSON.parse(
			readFileSync(join(extractDir, "package", "package.json"), "utf-8"),
		);

		expect(packedPkg.name).toBe("@test/test-package");
		expect(packedPkg.version).toBe("1.0.0");
		expect(packedPkg.peerDependencies).toEqual({
			"@earendil-works/pi-agent-core": "^0.83.0",
			"@earendil-works/pi-coding-agent": "^0.83.0",
		});
		expect(packedPkg).not.toHaveProperty("devDependencies");
		expect(packedPkg).not.toHaveProperty("scripts");
		expect(packedPkg).not.toHaveProperty("files");

		// exports paths are relative to package root (no ./dist/ prefix)
		expect(packedPkg.exports["."].types).toBe("./index.d.ts");
		expect(packedPkg.exports["."].import).toBe("./index.js");
	});

	it("throws when dist/package does not exist", () => {
		createMockRootPackage(["index.js"]);
		expect(() => packageTarball(fixtureDir)).toThrow(
			"dist/package/ not found",
		);
	});
});

describe("preparePackage (full workflow)", () => {
	it("produces a valid dist/package from mock build output", () => {
		createMockRootPackage([
			"index.js",
			"index.d.ts",
			"index.js.map",
			"index.d.ts.map",
			"mock-pi-script.mjs",
			"playbook.js",
			"playbook.d.ts",
			"playbook.js.map",
			"playbook.d.ts.map",
			"session.js",
			"session.d.ts",
			"session.js.map",
			"session.d.ts.map",
		]);
		createMockSkill();

		const pkg = preparePackage(fixtureDir);
		const exportsMap = pkg.exports as Record<string, Record<string, string>>;

		// Verify generated package.json
		expect(pkg.name).toBe("@test/test-package");
		expect(pkg.version).toBe("1.0.0");
		expect(pkg).not.toHaveProperty("devDependencies");
		expect(pkg).not.toHaveProperty("scripts");
		expect(pkg).not.toHaveProperty("files");

		// Verify exports paths are adjusted
		expect(exportsMap["."].types).toBe("./index.d.ts");
		expect(exportsMap["."].import).toBe("./index.js");

		// Verify all expected files exist
		const packageDir = join(fixtureDir, "dist", "package");
		const files = readdirSync(packageDir).sort();
		expect(files).toContain("index.js");
		expect(files).toContain("index.d.ts");
		expect(files).toContain("mock-pi-script.mjs");
		expect(files).toContain("playbook.js");
		expect(files).toContain("session.js");
		expect(files).toContain("skills");

		const packedSkill = join(packageDir, "skills", "pi-test-harness");
		expect(readFileSync(join(packedSkill, "SKILL.md"), "utf8")).toContain(
			"name: pi-test-harness",
		);
		expect(
			readFileSync(join(packedSkill, "references", "api-reference.md"), "utf8"),
		).toBe("# API\n");
		expect(lstatSync(join(packedSkill, "SKILL.md")).isFile()).toBe(true);
		expect(lstatSync(join(packedSkill, "SKILL.md")).isSymbolicLink()).toBe(false);

		// Verify files are physical and contain no symlinks
		expect(() => verifyNoSymlinks(packageDir)).not.toThrow();
	});

	it("removes stale files from a previous prepared package", () => {
		createMockRootPackage(["index.js", "index.d.ts"]);
		createMockSkill();
		const staleDir = join(
			fixtureDir,
			"dist",
			"package",
			"skills",
			"pi-test-harness",
			"references",
		);
		const staleFile = join(staleDir, "removed.md");
		mkdirSync(staleDir, { recursive: true });
		writeFileSync(staleFile, "stale\n");

		preparePackage(fixtureDir);

		expect(existsSync(staleFile)).toBe(false);
	});
});