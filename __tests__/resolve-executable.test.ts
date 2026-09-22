/**
 * Unit tests for how the sandbox launches external commands.
 *
 * **Why injectable**: both the resolution and the shell decision only matter on
 * win32, which no Linux CI runner can exercise. Taking the platform (and
 * environment) as parameters makes both branches provable here instead of
 * assumed from the platform's behaviour.
 *
 * The contract under guard: an extensionless command (`sfw`, `npm`) resolves to
 * its PATHEXT shim on Windows, that shim is launched through cmd.exe (a `.cmd`
 * is not an executable image), and an unmatched command is returned unchanged so
 * `verifySandboxInstall({ npmCommand: ["nope"] })` still raises ENOENT.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resolveExecutable, _spawnTarget } from "../src/sandbox.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resolve-executable-"));
	tempDirs.push(dir);
	return dir;
}

function touch(filePath: string): string {
	fs.writeFileSync(filePath, "");
	return filePath;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("_resolveExecutable", () => {
	it("leaves the command untouched off Windows", () => {
		const dir = makeTempDir();
		touch(path.join(dir, "sfw.cmd"));

		expect(
			_resolveExecutable("sfw", "linux", { PATH: dir, PATHEXT: ".cmd" }),
		).toBe("sfw");
	});

	it("leaves a command that already carries an extension alone", () => {
		expect(
			_resolveExecutable("npm.cmd", "win32", { PATH: "", PATHEXT: ".cmd" }),
		).toBe("npm.cmd");
	});

	it("resolves an extensionless command to its shim through PATH and PATHEXT", () => {
		const dir = makeTempDir();
		const shim = touch(path.join(dir, "sfw.cmd"));

		expect(
			_resolveExecutable("sfw", "win32", { PATH: dir, PATHEXT: ".cmd" }),
		).toBe(shim);
	});

	it("searches PATH in order and takes the first match", () => {
		const first = makeTempDir();
		const second = makeTempDir();
		const shim = touch(path.join(second, "tool.cmd"));

		expect(
			_resolveExecutable("tool", "win32", {
				PATH: [first, second].join(path.delimiter),
				PATHEXT: ".cmd",
			}),
		).toBe(shim);
	});

	it("prefers the earlier PATHEXT entry when both shims exist", () => {
		const dir = makeTempDir();
		// Uppercase to match PATHEXT: this suite runs on a case-sensitive filesystem
		// even when the platform under test is Windows.
		const exe = touch(path.join(dir, "tool.EXE"));
		touch(path.join(dir, "tool.CMD"));

		expect(
			_resolveExecutable("tool", "win32", {
				PATH: dir,
				PATHEXT: ".EXE;.CMD",
			}),
		).toBe(exe);
	});

	it("falls back to the standard Windows PATHEXT when the environment omits it", () => {
		const dir = makeTempDir();
		const shim = touch(path.join(dir, "tool.CMD"));

		expect(_resolveExecutable("tool", "win32", { PATH: dir })).toBe(shim);
	});

	it("resolves an explicit path by appending PATHEXT", () => {
		const dir = makeTempDir();
		const shim = touch(path.join(dir, "custom-tool.cmd"));
		const command = path.join(dir, "custom-tool");

		expect(
			_resolveExecutable(command, "win32", { PATH: "", PATHEXT: ".cmd" }),
		).toBe(shim);
	});

	it("returns the command unchanged when nothing matches, preserving ENOENT", () => {
		const dir = makeTempDir();

		expect(
			_resolveExecutable("commande-inexistante", "win32", {
				PATH: dir,
				PATHEXT: ".cmd",
			}),
		).toBe("commande-inexistante");
	});

	it("returns an unmatched explicit path unchanged, preserving ENOENT", () => {
		const dir = makeTempDir();
		const command = path.join(dir, "absent-tool");

		expect(
			_resolveExecutable(command, "win32", { PATH: "", PATHEXT: ".cmd" }),
		).toBe(command);
	});
});

describe("_spawnTarget", () => {
	it("launches a Windows .cmd shim through cmd.exe with the script as an argument", () => {
		expect(
			_spawnTarget("C:\\npm\\prefix\\sfw.CMD", ["npm", "ci"], "win32", {
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toEqual({
			command: "C:\\Windows\\System32\\cmd.exe",
			args: ["/d", "/s", "/c", "C:\\npm\\prefix\\sfw.CMD", "npm", "ci"],
		});
	});

	it("treats .cmd and .bat alike, regardless of case", () => {
		expect(
			_spawnTarget("C:\\tools\\thing.BAT", [], "win32", { ComSpec: "cmd.exe" })
				.command,
		).toBe("cmd.exe");
	});

	it("falls back to cmd.exe when the environment has no ComSpec", () => {
		expect(_spawnTarget("C:\\tools\\thing.cmd", [], "win32", {}).command).toBe(
			"cmd.exe",
		);
	});

	it("spawns a real binary directly, keeping the argument array intact", () => {
		expect(
			_spawnTarget("C:\\tools\\thing.exe", ["pack", "--quiet"], "win32", {}),
		).toEqual({ command: "C:\\tools\\thing.exe", args: ["pack", "--quiet"] });
		expect(_spawnTarget("C:\\tools\\thing", [], "win32", {})).toEqual({
			command: "C:\\tools\\thing",
			args: [],
		});
	});

	it("never routes through cmd.exe off Windows", () => {
		expect(_spawnTarget("/usr/bin/sfw.cmd", ["npm", "ci"], "linux", {})).toEqual({
			command: "/usr/bin/sfw.cmd",
			args: ["npm", "ci"],
		});
		expect(_spawnTarget("/usr/bin/sfw", [], "darwin", {})).toEqual({
			command: "/usr/bin/sfw",
			args: [],
		});
	});
});
