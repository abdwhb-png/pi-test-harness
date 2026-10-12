import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { verifySandboxInstall, when, calls, says } from "../src/index.js";

const DUMMY_EXTENSION = path.resolve(__dirname, "fixtures/dummy-extension");

describe("verifySandboxInstall", () => {
	it.each(["npm run", "direct invocation"])("handles allow-scripts from %s", async (mode) => {
		const fixtureDir = mkdtempSync(path.join(tmpdir(), "pi-npm-config-fixture-"));
		const cliPath = path.join(fixtureDir, "npm.mjs");
		writeFileSync(cliPath, `
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [fixture, command] = process.argv.slice(2);
if (command === "install" && process.env.npm_config_allow_scripts) {
  throw new Error("EALLOWSCRIPTS: npm run projected allow-scripts into a project install");
}
if (process.env.PI_TEST_INSTALL_MARKER !== "preserved") {
  throw new Error("The npm child lost unrelated environment settings");
}
if (command === "pack") {
  writeFileSync("fixture.tgz", "controlled package fixture");
  console.log("fixture.tgz");
} else if (command === "install") {
  const { name } = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8"));
  const target = join(process.cwd(), "node_modules", name);
  mkdirSync(target, { recursive: true });
  cpSync(fixture, target, { recursive: true });
} else {
  throw new Error("Unexpected npm command: " + command);
}
`);
		const original = {
			lifecycle: process.env.npm_lifecycle_event,
			allowScripts: process.env.npm_config_allow_scripts,
			marker: process.env.PI_TEST_INSTALL_MARKER,
		};
		if (mode === "npm run") process.env.npm_lifecycle_event = "test";
		else delete process.env.npm_lifecycle_event;
		process.env.npm_config_allow_scripts = "fixture-only@1.0.0";
		process.env.PI_TEST_INSTALL_MARKER = "preserved";
		try {
			const installation = verifySandboxInstall({
				packageDir: DUMMY_EXTENSION,
				npmCommand: [process.execPath, cliPath, DUMMY_EXTENSION],
				expect: { extensions: 1, tools: ["dummy_tool"] },
			});
			if (mode === "npm run") {
				const result = await installation;
				expect(result.loaded.extensionErrors).toEqual([]);
				expect(result.loaded.tools).toContain("dummy_tool");
			} else {
				await expect(installation).rejects.toThrow("EALLOWSCRIPTS");
			}
			expect(process.env.npm_config_allow_scripts).toBe("fixture-only@1.0.0");
		} finally {
			for (const [key, value] of [
				["npm_lifecycle_event", original.lifecycle],
				["npm_config_allow_scripts", original.allowScripts],
				["PI_TEST_INSTALL_MARKER", original.marker],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(fixtureDir, { recursive: true, force: true });
		}
	});

	it("installs and loads a dummy extension package", async () => {
		const result = await verifySandboxInstall({
			packageDir: DUMMY_EXTENSION,
			npmCommand: ["sfw", "npm"],
			expect: {
				extensions: 1,
				tools: ["dummy_tool"],
			},
		});

		expect(result.loaded.extensionErrors).toEqual([]);
		expect(result.loaded.extensions).toBe(1);
		expect(result.loaded.tools).toContain("dummy_tool");
	}, 30_000); // npm pack + install can be slow

	it("detects missing expected tools", async () => {
		await expect(
			verifySandboxInstall({
				packageDir: DUMMY_EXTENSION,
				npmCommand: ["sfw", "npm"],
				expect: {
					extensions: 1,
					tools: ["nonexistent_tool"],
				},
			}),
		).rejects.toThrow(/Expected tool "nonexistent_tool" not found/);
	}, 30_000);

	it("detects wrong extension count", async () => {
		await expect(
			verifySandboxInstall({
				packageDir: DUMMY_EXTENSION,
				npmCommand: ["sfw", "npm"],
				expect: {
					extensions: 5, // wrong
				},
			}),
		).rejects.toThrow(/Expected 5 extension\(s\), got/);
	}, 30_000);

	it("runs a smoke test in the sandbox", async () => {
		const result = await verifySandboxInstall({
			packageDir: DUMMY_EXTENSION,
			npmCommand: ["sfw", "npm"],
			expect: {
				extensions: 1,
				tools: ["dummy_tool"],
			},
			smoke: {
				mockTools: {
					bash: "ok",
					read: "contents",
					write: "written",
					edit: "edited",
				},
				script: [
					when("Test the dummy tool", [
						calls("dummy_tool", { value: "hello" }),
						says("Tool works."),
					]),
				],
			},
		});

		expect(result.smoke).toBeDefined();
		expect(result.smoke!.events.toolResultsFor("dummy_tool")).toHaveLength(1);
		expect(result.smoke!.events.toolResultsFor("dummy_tool")[0].text).toBe(
			"echo: hello",
		);
	}, 60_000); // smoke test includes full session setup

	describe("npmCommand option", () => {
		it("throws ENOENT for a nonexistent npm command", async () => {
			await expect(
				verifySandboxInstall({
					packageDir: DUMMY_EXTENSION,
					npmCommand: ["commande-pi-test-harness-inexistante"],
				}),
			).rejects.toThrow(/ENOENT/);
		}, 10_000);

		it("uses sfw npm for pack when npmCommand is sfw", async () => {
			const result = await verifySandboxInstall({
				packageDir: DUMMY_EXTENSION,
				npmCommand: ["sfw", "npm"],
				expect: {
					extensions: 1,
					tools: ["dummy_tool"],
				},
			});
			expect(result.loaded.extensionErrors).toEqual([]);
			expect(result.loaded.extensions).toBe(1);
			expect(result.loaded.tools).toContain("dummy_tool");
		}, 30_000);
	});
});
