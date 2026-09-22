/**
 * Sandbox install verification — verifies npm packages work when installed clean.
 *
 * 1. npm pack → tarball
 * 2. Install in temp dir
 * 3. DefaultResourceLoader discovers extensions/skills
 * 4. Verify resources load without errors
 * 5. Optional smoke test
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { withoutJitiNativeImport } from "./pi-loader-parity.js";
import type { SandboxOptions, SandboxResult } from "./types.js";
import { createTestSession } from "./session.js";

/** Resolve the npm command array. Defaults to platform-aware npm. */
function resolveNpmCommand(npmCommand?: string[]): string[] {
	if (npmCommand && npmCommand.length > 0) return npmCommand;
	return [process.platform === "win32" ? "npm.cmd" : "npm"];
}

/**
 * Resolve `command` to something execFileSync can actually start.
 *
 * **Why this exists**: on Windows a bare `sfw` (or `npm`) is the `.cmd` shim, and
 * child_process applies no PATHEXT when creating the process, so spawning it
 * fails with ENOENT — which broke the documented `npmCommand: ["sfw", "npm"]`
 * preset on the Windows integration matrix. Candidate extensions come from
 * PATHEXT (or the usual Windows default) and are matched against PATH in the
 * same order the platform itself would. An unmatched command is returned
 * unchanged, so a genuinely missing executable still raises a clear ENOENT.
 *
 * Exported for unit testing — not part of the public API contract.
 * @internal
 */
export function _resolveExecutable(
	command: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (platform !== "win32") return command;
	if (path.extname(command) !== "") return command;

	const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.filter(Boolean);

	// An explicit path never goes through PATH resolution — only PATHEXT applies.
	if (command.includes("/") || command.includes("\\")) {
		for (const extension of extensions) {
			const candidate = `${command}${extension}`;
			if (fs.existsSync(candidate)) return candidate;
		}
		return command;
	}

	const directories = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const directory of directories) {
		for (const extension of extensions) {
			const candidate = path.join(directory, `${command}${extension}`);
			if (fs.existsSync(candidate)) return candidate;
		}
	}

	return command;
}

/**
 * How to launch a resolved command, without Node's deprecated shell form.
 *
 * **Why**: on Windows a `.cmd`/`.bat` is not an executable image — it needs a
 * terminal. Since the CVE-2024-27980 fix, child_process refuses to launch one
 * with `shell: false` and fails with `EINVAL`, so resolving `sfw` to `sfw.CMD`
 * was necessary but not sufficient.
 *
 * Node documents three ways to launch it: `exec()`, `{ shell: true }`, or
 * spawning `cmd.exe` with the script as an argument. The shell option is
 * deprecated as a *runtime* warning in Node 24 (DEP0190) because an argument
 * array passed that way is only space-joined, never escaped. This takes the
 * third route — what `exec()` does internally — so the argument array reaches the
 * child intact and no deprecated form is used.
 *
 * Real binaries (`.exe`, or a path with no shim extension) spawn directly and
 * stay shell-free on every platform.
 *
 * Known limitation, unchanged from the shell form: cmd.exe applies its own
 * parsing to the arguments that follow the script, so an argument containing
 * spaces has to survive it. Only the script path is guaranteed, because Node
 * quotes an argument that contains spaces when it builds the command line.
 *
 * Exported for unit testing — not part of the public API contract.
 * @internal
 */
export function _spawnTarget(
	resolved: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
	if (platform !== "win32" || !/\.(cmd|bat)$/i.test(resolved)) {
		return { command: resolved, args };
	}

	// `/d` skips AutoRun scripts, `/s` keeps cmd's parsing of the rest as-is.
	return {
		command: env.ComSpec ?? "cmd.exe",
		args: ["/d", "/s", "/c", resolved, ...args],
	};
}

/**
 * Run a command via execFileSync with safe string conversion for the full
 * command line in the error message.
 */
function run(args: string[], cwd: string, label: string): string {
	const [cmd, ...cmdArgs] = args;
	const target = _spawnTarget(_resolveExecutable(cmd), cmdArgs);
	try {
		return execFileSync(target.command, target.args, {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch (err: any) {
		// Enhance the error message with context
		const stderr = err.stderr?.toString().trim() ?? "";
		const enhanced = new Error(
			`${label} failed: ${err.message}${stderr ? `\nstderr: ${stderr}` : ""}`,
		);
		// Preserve the original error code (ENOENT, etc.)
		(enhanced as any).code = err.code;
		throw enhanced;
	}
}

/** Manifest fields the sandbox install path needs. */
interface PackageManifest {
	name?: string;
	pi?: {
		extensions?: string[];
	};
}

/**
 * Read a package.json, reporting the offending path instead of surfacing a bare
 * SyntaxError. A malformed manifest is fatal for both call sites below, so the
 * failure is rethrown with the path that caused it.
 */
function readPackageJson(filePath: string): PackageManifest {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (err) {
		throw new Error(
			`Could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		);
	}
	try {
		return JSON.parse(raw) as PackageManifest;
	} catch (err) {
		throw new Error(
			`Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		);
	}
}

/**
 * Read the package name from a package.json, decoded here rather than at the
 * call site: every consumer of this value needs it to be a non-empty string.
 */
function readPackageName(filePath: string): string {
	const manifest = readPackageJson(filePath);
	const name = manifest.name;
	if (typeof name !== "string" || name.length === 0) {
		throw new Error(`package.json at ${filePath} has no "name" field`);
	}
	return name;
}

export async function verifySandboxInstall(
	options: SandboxOptions,
): Promise<SandboxResult> {
	const packageDir = path.resolve(options.packageDir);
	const npmCmd = resolveNpmCommand(options.npmCommand);

	// Validate package directory
	const pkgJsonPath = path.join(packageDir, "package.json");
	if (!fs.existsSync(pkgJsonPath)) {
		throw new Error(`No package.json found at ${pkgJsonPath}`);
	}
	const pkgName = readPackageName(pkgJsonPath);

	// Create sandbox temp dir
	const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-"));

	try {
		// 1. npm pack → tarball
		const packArgs = [...npmCmd.slice(1), "pack", "--pack-destination", "."];
		const packOutput = run(
			[...npmCmd.slice(0, 1), ...packArgs],
			packageDir,
			`npm pack in ${packageDir}`,
		);

		// The output is the tarball filename
		const tarballName = packOutput.split("\n").pop()!.trim();
		const tarballSrc = path.join(packageDir, tarballName);
		const tarballDest = path.join(sandboxDir, tarballName);
		try {
			fs.copyFileSync(tarballSrc, tarballDest);
		} finally {
			// Always clean up tarball from source (even if copy fails)
			try {
				if (fs.existsSync(tarballSrc)) fs.unlinkSync(tarballSrc);
			} catch {
				/* best-effort */
			}
		}

		// 2. Create minimal package.json in sandbox
		const sandboxPkg = {
			name: "pi-test-sandbox",
			private: true,
			type: "module",
			dependencies: {
				[pkgName]: `file:./${tarballName}`,
			},
		};
		fs.writeFileSync(
			path.join(sandboxDir, "package.json"),
			JSON.stringify(sandboxPkg, null, 2),
		);

		// 3. npm install
		const installArgs = [...npmCmd.slice(1), "install", "--ignore-scripts=false"];
		run(
			[...npmCmd.slice(0, 1), ...installArgs],
			sandboxDir,
			`npm install in ${sandboxDir}`,
		);

		// 4. Find the installed package and use DefaultResourceLoader
		const installedPkgDir = path.join(
			sandboxDir,
			"node_modules",
			...pkgName.split("/"),
		);

		if (!fs.existsSync(installedPkgDir)) {
			throw new Error(`Package not found after install: ${installedPkgDir}`);
		}

		// Read installed package.json for pi manifest
		const installedPkgJson = readPackageJson(
			path.join(installedPkgDir, "package.json"),
		);
		const piManifest = installedPkgJson.pi;

		// Resolve extension paths from the installed package
		const extensionPaths: string[] = [];
		if (piManifest?.extensions) {
			for (const ext of piManifest.extensions) {
				const resolved = path.resolve(installedPkgDir, ext);
				if (fs.existsSync(resolved)) {
					extensionPaths.push(resolved);
				} else {
					// Try as glob/directory
					const dir = path.resolve(installedPkgDir, ext);
					if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
						const files = fs
							.readdirSync(dir)
							.filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
						extensionPaths.push(...files.map((f) => path.join(dir, f)));
					}
				}
			}
		}

		// Load extensions via DefaultResourceLoader
		const settingsManager = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({
			cwd: sandboxDir,
			agentDir: sandboxDir,
			settingsManager,
			additionalExtensionPaths: extensionPaths,
		});
		// Extension modules evaluate here; keep the loader configuration in parity
		// with Pi's shipped runtimes (see withoutJitiNativeImport).
		await withoutJitiNativeImport(() => loader.reload());

		const extensionsResult = loader.getExtensions();
		const skillsResult = loader.getSkills();

		// Collect tool names from loaded extensions (no cast needed)
		const toolNames: string[] = [];
		for (const ext of extensionsResult.extensions) {
			for (const [name] of ext.tools ?? new Map()) {
				toolNames.push(name);
			}
		}

		const result: SandboxResult = {
			loaded: {
				extensions: extensionsResult.extensions.length,
				extensionErrors: extensionsResult.errors.map(
					(e) => `${e.path}: ${e.error}`,
				),
				tools: toolNames,
				skills: skillsResult.skills.length,
			},
		};

		// 5. Verify expectations
		if (options.expect) {
			if (options.expect.extensions !== undefined) {
				if (extensionsResult.extensions.length !== options.expect.extensions) {
					throw new Error(
						`Expected ${options.expect.extensions} extension(s), got ${extensionsResult.extensions.length}`,
					);
				}
			}
			if (options.expect.tools) {
				for (const expectedTool of options.expect.tools) {
					if (!toolNames.includes(expectedTool)) {
						throw new Error(
							`Expected tool "${expectedTool}" not found. Available: ${toolNames.join(", ")}`,
						);
					}
				}
			}
			if (options.expect.skills !== undefined) {
				if (skillsResult.skills.length !== options.expect.skills) {
					throw new Error(
						`Expected ${options.expect.skills} skill(s), got ${skillsResult.skills.length}`,
					);
				}
			}
		}

		// 6. Optional smoke test
		if (options.smoke) {
			const t = await createTestSession({
				extensions: extensionPaths,
				cwd: sandboxDir,
				mockTools: options.smoke.mockTools,
			});

			await t.run(...options.smoke.script);
			result.smoke = { events: t.events };
			t.dispose();
		}

		return result;
	} finally {
		// Clean up sandbox (retry for Windows EBUSY on open handles)
		if (fs.existsSync(sandboxDir)) {
			try {
				fs.rmSync(sandboxDir, {
					recursive: true,
					force: true,
					maxRetries: 3,
					retryDelay: 200,
				});
			} catch {
				// Best-effort cleanup — temp dir will be cleaned by OS
			}
		}
	}
}
