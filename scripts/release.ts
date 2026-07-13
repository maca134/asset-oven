/**
 * Interactive release helper: prompts for a release type, bumps
 * package.json and creates the matching commit + git tag via
 * `bun pm version`, then optionally pushes both to origin.
 *
 * Run with: bun run release
 */
const RELEASE_TYPES = ["patch", "minor", "major", "prerelease"] as const;
type ReleaseType = (typeof RELEASE_TYPES)[number];

const PACKAGE_DIR = "asset-oven";

function run(cmd: string[], cwd?: string): number {
	const proc = Bun.spawnSync(cmd, {
		cwd,
		stdio: ["inherit", "inherit", "inherit"],
	});
	return proc.exitCode ?? 1;
}

if (run(["git", "diff", "--quiet"]) !== 0) {
	console.error("Uncommitted changes found -- aborting release.");
	process.exit(1);
}

if (run(["bun", "run", "lint"]) !== 0) {
	console.error("Lint failed -- aborting release.");
	process.exit(1);
}

if (run(["bun", "run", "format"]) !== 0) {
	console.error("Formatting failed -- aborting release.");
	process.exit(1);
}

if (run(["git", "diff", "--quiet"]) !== 0) {
	// commit formatting changes
	if (run(["git", "commit", "-am", "chore: format"]) !== 0) {
		console.error(
			"Failed to commit formatting changes -- aborting release."
		);
		process.exit(1);
	}
}

if (run(["bun", "test"]) !== 0) {
	console.error("Tests failed -- aborting release.");
	process.exit(1);
}

const pkg = (await Bun.file(`${PACKAGE_DIR}/package.json`).json()) as {
	version: string;
};
console.log(`Current version: ${pkg.version}`);

const typeAnswer = prompt(`Release type (${RELEASE_TYPES.join("/")})`, "patch");
if (typeAnswer === null) {
	console.log("Aborted.");
	process.exit(1);
}

await Bun.sleep(500);

const releaseType = typeAnswer.trim().toLowerCase();
if (!RELEASE_TYPES.includes(releaseType as ReleaseType)) {
	console.error(
		`Invalid release type: "${releaseType}". Expected one of: ${RELEASE_TYPES.join(", ")}`
	);
	process.exit(1);
}

const versionExitCode = run(["bun", "pm", "version", releaseType], PACKAGE_DIR);
if (versionExitCode !== 0) {
	console.error("bun pm version failed -- aborting release.");
	process.exit(versionExitCode);
}

// publish
const publishAnswer = prompt("Publish the new version to npm now? (y/N)", "N");
if (publishAnswer === null || !/^y(es)?$/i.test(publishAnswer.trim())) {
	console.log("Skipped publish. Run `bun pm publish` when you're ready.");
	process.exit(0);
}

await Bun.sleep(500);

const publishExitCode = run(["bun", "publish"], PACKAGE_DIR);
if (publishExitCode !== 0) {
	console.error("bun publish failed -- aborting release.");
	process.exit(publishExitCode);
}

const pushAnswer = prompt(
	"Push the new commit and tag to origin now? (y/N)",
	"N"
);
if (pushAnswer === null || !/^y(es)?$/i.test(pushAnswer.trim())) {
	console.log(
		"Skipped push. Run `git push --follow-tags` when you're ready."
	);
	process.exit(0);
}

process.exit(run(["git", "push", "--follow-tags"]));
