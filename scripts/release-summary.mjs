import { appendFileSync, readFileSync } from "node:fs";

const steps = JSON.parse(process.env.RELEASE_STEPS);
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const repoUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`;
const changesets = steps.changesets ?? { outcome: "not reached", outputs: {} };
const outputs = changesets.outputs ?? {};
const npmBefore = steps.npm_before?.outputs ?? {};
const github = steps.github_release ?? { outcome: "not reached", outputs: {} };
const githubOutputs = github.outputs ?? {};
const hasChangesets = outputs["has-changesets"] === "true";
const alreadyPublished = npmBefore.exists === "true";
const targetName = npmBefore.name ?? pkg.name;
const targetVersion = npmBefore.version ?? pkg.version;

let versionPr = `Not confirmed (Changesets ${changesets.outcome})`;
if (outputs["pr-number"]) {
	versionPr = `Created or updated [#${outputs["pr-number"]}](${repoUrl}/pull/${outputs["pr-number"]})`;
} else if (changesets.outcome === "success") {
	versionPr = hasChangesets
		? "Not created (only empty changesets)"
		: "Not required (no pending changesets)";
}

let npmPublication;
if (hasChangesets) {
	npmPublication = "Not attempted (pending changesets)";
} else if (changesets.outcome === "failure" || changesets.outcome === "cancelled") {
	// npm can succeed before the CLI or action fails. Missing outputs prove nothing.
	npmPublication = `Unconfirmed (Changesets ${changesets.outcome}; inspect logs and npm)`;
} else if (changesets.outcome !== "success") {
	npmPublication = `Not attempted (Changesets ${changesets.outcome})`;
} else if (alreadyPublished) {
	npmPublication = `Already published before this run: [${targetName}@${targetVersion}](https://www.npmjs.com/package/${targetName}/v/${targetVersion}). No new npm publication required.`;
} else if (outputs.published === "true") {
	const packages = JSON.parse(outputs["published-packages"]);
	npmPublication = `Published ${packages.map(({ name, version }) => `[${name}@${version}](https://www.npmjs.com/package/${name}/v/${version})`).join(", ")}`;
} else {
	npmPublication = "No publication confirmed by Changesets; inspect logs and npm";
}

let skipped = "Skipped (no release confirmed)";
if (hasChangesets) skipped = "Skipped (versioning only)";
else if (alreadyPublished) skipped = "Skipped (version already on npm; metadata recovery is separate)";
const githubStatus = github.outcome === "skipped" || github.outcome === "not reached"
	? skipped
	: `Unconfirmed (GitHub step ${github.outcome})`;
const tag = githubOutputs.tag;
const tagStatus = tag ? `Pushed [${tag}](${repoUrl}/tree/${tag})` : githubStatus;
let releaseStatus = githubStatus;
if (githubOutputs.release) {
	const verb = githubOutputs.release === "created" ? "Created" : "Already existed";
	releaseStatus = `${verb} [${tag}](${repoUrl}/releases/tag/${tag})`;
}

const rows = [
	["Dependency install", steps.install?.outcome ?? "not reached"],
	["Build", steps.build?.outcome ?? "not reached"],
	["npm preflight", steps.npm_before?.outcome ?? "not reached"],
	["Changesets", changesets.outcome],
	["Version PR", versionPr],
	["npm publication", npmPublication],
	["Remote tag", tagStatus],
	["GitHub Release", releaseStatus],
];
const summary = [
	"\n## Release summary\n",
	`Workflow result: **${process.env.RELEASE_JOB_STATUS}**\n`,
	`Target: **${targetName}@${targetVersion}**. Branch: \`${process.env.GITHUB_REF_NAME}\`. Commit: [\`${process.env.GITHUB_SHA}\`](${repoUrl}/commit/${process.env.GITHUB_SHA}).\n`,
	"| Operation | Result |",
	"| --- | --- |",
	...rows.map(([operation, result]) => `| ${operation} | ${result} |`),
	"",
].join("\n");
appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.stdout.write(summary);
