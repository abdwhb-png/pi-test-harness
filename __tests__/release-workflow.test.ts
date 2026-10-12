import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/release-summary.mjs");
let fixtureDir: string;

beforeEach(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "release-summary-"));
	writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({
		name: "@example/harness",
		version: "0.9.0",
	}));
});

afterEach(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
});

type Step = { outcome: string; outputs?: Record<string, string> };

function runSummary(steps: Record<string, Step>, status = "success") {
	const summaryPath = join(fixtureDir, "summary.md");
	writeFileSync(summaryPath, "Existing job summary\n");
	execFileSync(process.execPath, [script], {
		cwd: fixtureDir,
		env: {
			...process.env,
			GITHUB_STEP_SUMMARY: summaryPath,
			GITHUB_SERVER_URL: "https://github.com",
			GITHUB_REPOSITORY: "example/harness",
			GITHUB_SHA: "0123456789abcdef",
			GITHUB_REF_NAME: "main",
			RELEASE_JOB_STATUS: status,
			RELEASE_STEPS: JSON.stringify(steps),
		},
	});
	return readFileSync(summaryPath, "utf8");
}

describe("Release workflow summary", () => {
	it("reports npm publication and the separate GitHub operations with links", () => {
		const summary = runSummary({
			install: { outcome: "success" },
			build: { outcome: "success" },
			npm_before: { outcome: "success", outputs: { exists: "false" } },
			changesets: {
				outcome: "success",
				outputs: {
					published: "true",
					"has-changesets": "false",
					"published-packages": '[{"name":"@example/harness","version":"0.9.0"}]',
				},
			},
			github_release: {
				outcome: "success",
				outputs: { tag: "v0.9.0", release: "created" },
			},
		});
		expect(summary).toContain("Existing job summary\n");
		expect(summary).toContain("Published [@example/harness@0.9.0](https://www.npmjs.com/package/@example/harness/v/0.9.0)");
		expect(summary).toContain("Pushed [v0.9.0](https://github.com/example/harness/tree/v0.9.0)");
		expect(summary).toContain("Created [v0.9.0](https://github.com/example/harness/releases/tag/v0.9.0)");
		expect(summary).toContain("https://github.com/example/harness/commit/0123456789abcdef");
		expect(summary).toContain("Not required (no pending changesets)");
	});

	it.each(["true", "false"])("reports an existing npm version when Changesets published=%s", (published) => {
		const summary = runSummary({
			npm_before: { outcome: "success", outputs: { exists: "true" } },
			changesets: {
				outcome: "success",
				outputs: { published, "has-changesets": "false" },
			},
			github_release: { outcome: "skipped" },
		});
		expect(summary).toContain("Already published before this run");
		expect(summary).toContain("Skipped (version already on npm; metadata recovery is separate)");
		expect(summary).not.toContain("| npm publication | Published ");
	});

	it("links the version PR and explains why publication was skipped", () => {
		const summary = runSummary({
			changesets: {
				outcome: "success",
				outputs: { "has-changesets": "true", "pr-number": "42" },
			},
			github_release: { outcome: "skipped" },
		});
		expect(summary).toContain("Created or updated [#42](https://github.com/example/harness/pull/42)");
		expect(summary).toContain("Not attempted (pending changesets)");
		expect(summary).toContain("Skipped (versioning only)");
	});

	it("distinguishes empty changesets from a version PR", () => {
		const summary = runSummary({
			changesets: { outcome: "success", outputs: { "has-changesets": "true" } },
			github_release: { outcome: "skipped" },
		});
		expect(summary).toContain("Not created (only empty changesets)");
		expect(summary).not.toContain("Created or updated");
	});

	it("keeps publication uncertain after a failed action", () => {
		const summary = runSummary({
			build: { outcome: "success" },
			changesets: { outcome: "failure", outputs: { published: "false" } },
			github_release: { outcome: "skipped" },
		}, "failure");
		expect(summary).toContain("Workflow result: **failure**");
		expect(summary).toContain("Unconfirmed (Changesets failure; inspect logs and npm)");
	});

	it("preserves confirmed npm publication and tag push when GitHub Release creation fails", () => {
		const summary = runSummary({
			npm_before: { outcome: "success", outputs: { exists: "false" } },
			changesets: {
				outcome: "success",
				outputs: {
					published: "true",
					"has-changesets": "false",
					"published-packages": '[{"name":"@example/harness","version":"0.9.0"}]',
				},
			},
			github_release: { outcome: "failure", outputs: { tag: "v0.9.0" } },
		}, "failure");
		expect(summary).toContain("Published [@example/harness@0.9.0]");
		expect(summary).toContain("Pushed [v0.9.0]");
		expect(summary).toContain("Unconfirmed (GitHub step failure)");
	});

	it("shows that publication was not attempted when preparation fails", () => {
		const summary = runSummary({
			install: { outcome: "failure" },
			build: { outcome: "skipped" },
			changesets: { outcome: "skipped" },
			github_release: { outcome: "skipped" },
		}, "failure");
		expect(summary).toContain("| Dependency install | failure |");
		expect(summary).toContain("Not attempted (Changesets skipped)");
		expect(summary).toContain("Skipped (no release confirmed)");
	});

	it("reports an already existing GitHub release separately", () => {
		const summary = runSummary({
			github_release: {
				outcome: "success",
				outputs: { tag: "v0.9.0", release: "existing" },
			},
		});
		expect(summary).toContain("Already existed [v0.9.0](https://github.com/example/harness/releases/tag/v0.9.0)");
	});
});
