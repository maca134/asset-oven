/**
 * Interactive release helper: prompts for a release type, bumps
 * asset-oven/package.json via `bun pm version --no-git-tag-version`, then
 * creates the matching commit + git tag itself and optionally pushes both
 * to origin. Pushing the tag triggers the `.github/workflows/publish.yml`
 * CI workflow, which does the actual `bun publish` -- this script does not
 * publish locally.
 *
 * The commit/tag step is done here rather than left to `bun pm version`
 * because that command only creates the git commit + tag when run from the
 * git root -- from a workspace subdirectory (asset-oven/, in this monorepo)
 * it silently just edits package.json with no error (verified against Bun
 * 1.3.14).
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

const versionExitCode = run(
	["bun", "pm", "version", releaseType, "--no-git-tag-version"],
	PACKAGE_DIR
);
if (versionExitCode !== 0) {
	console.error("bun pm version failed -- aborting release.");
	process.exit(versionExitCode);
}

const newPkg = (await Bun.file(`${PACKAGE_DIR}/package.json`).json()) as {
	version: string;
};
const tag = `v${newPkg.version}`;
console.log(`Bumped to ${tag}`);

if (run(["git", "add", `${PACKAGE_DIR}/package.json`]) !== 0) {
	console.error("git add failed -- aborting release.");
	process.exit(1);
}
if (run(["git", "commit", "-m", tag]) !== 0) {
	console.error("git commit failed -- aborting release.");
	process.exit(1);
}
// annotated (-a), not lightweight: `git push --follow-tags` below only
// pushes annotated tags, ignoring lightweight ones by design
if (run(["git", "tag", "-a", tag, "-m", tag]) !== 0) {
	console.error("git tag failed -- aborting release.");
	process.exit(1);
}

const pushAnswer = prompt(
	"Push the new commit and tag to origin now? This triggers the CI publish workflow. (y/N)",
	"N"
);
if (pushAnswer === null || !/^y(es)?$/i.test(pushAnswer.trim())) {
	console.log(
		"Skipped push. Run `git push --follow-tags` when you're ready to publish."
	);
	process.exit(0);
}

process.exit(run(["git", "push", "--follow-tags"]));
