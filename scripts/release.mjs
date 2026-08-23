/**
 * Bump the app version everywhere it is written down, then tag it.
 *
 * The version lives in four files that must agree: two package.json files,
 * tauri.conf.json (which names the installer and the entry in Add/Remove
 * Programs) and Cargo.toml. The release workflow refuses to build when they
 * disagree with the tag, which is a good check but a poor way to find out.
 *
 *     pnpm release 0.2.0
 *
 * Stops short of pushing. Pushing the tag is what publishes to employees, and
 * that should be a thing you type, not a thing a script does while you read
 * its output.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: pnpm release <major.minor.patch>   e.g. pnpm release 0.2.0");
  process.exit(1);
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

if (git("status", "--porcelain")) {
  console.error("The working tree has uncommitted changes. Commit or stash them first:");
  console.error(git("status", "--short"));
  process.exit(1);
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") {
  console.error(`On branch "${branch}". Releases are cut from main.`);
  process.exit(1);
}

/** Rewrites one file, and fails loudly if the edit found nothing to change. */
function bump(relativePath, pattern, replacement) {
  const path = join(root, relativePath);
  const before = readFileSync(path, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before) {
    console.error(`Could not find the version to bump in ${relativePath}.`);
    process.exit(1);
  }
  writeFileSync(path, after);
  return relativePath;
}

// Anchored to the FIRST "version" key so a dependency's version is never hit.
const jsonVersion = /("version"\s*:\s*)"[^"]+"/;
const touched = [
  bump("package.json", jsonVersion, `$1"${version}"`),
  bump("apps/desktop/package.json", jsonVersion, `$1"${version}"`),
  bump("apps/desktop/src-tauri/tauri.conf.json", jsonVersion, `$1"${version}"`),
  bump("apps/desktop/src-tauri/Cargo.toml", /^version = "[^"]+"/m, `version = "${version}"`),
];

// Cargo.lock records the crate's own version too, and a stale lock makes the
// next build dirty the working tree at exactly the wrong moment. Edited
// directly rather than by running cargo, so cutting a release does not depend
// on a Rust toolchain being present or on the registry being reachable.
touched.push(
  bump(
    "apps/desktop/src-tauri/Cargo.lock",
    new RegExp('(name = "bamboo-ep-desktop"\r?\nversion = )"[^"]+"'),
    `$1"${version}"`,
  ),
);

git("add", ...touched);
git("commit", "-m", `Release v${version}`);
git("tag", "-a", `v${version}`, "-m", `v${version}`);

console.log(`\nTagged v${version}. Nothing has been pushed yet.`);
console.log("\nTo build and publish the installers:");
console.log(`\n    git push && git push origin v${version}\n`);
console.log("That starts the release workflow. It opens a DRAFT release -");
console.log("check the installers, then press publish on GitHub.");
