// junkmail: lists every place the fork touches an upstream file and fails if a change in an
// upstream file is not tagged with a `junkmail` comment. Tagged hooks are what keep upstream
// merges small: fork code lives in fork-owned files, upstream files only gain marked one-liners.
//
//   node scripts/junkmail/seams.mjs [upstream-ref]   (default: upstream/main)
import { execFileSync } from "node:child_process";

const upstreamRef = process.argv[2] ?? "upstream/main";
// Files that cannot carry a comment, or are regenerated rather than merged by hand.
const UNMARKABLE = new Map([
  ["apps/web/src/routeTree.gen.ts", "generated: run node scripts/junkmail/generate-routes.mjs"],
  ["packages/client-runtime/package.json", "JSON: the ./state/inbox subpath export"],
]);

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
const base = git("merge-base", "HEAD", upstreamRef).trim();

const owned = [];
const touched = [];
const unmarked = [];
for (const line of git("diff", "--name-status", "--no-renames", base).split("\n")) {
  if (!line) continue;
  const [status, file] = line.split("\t");
  if (status === "A") {
    owned.push(file);
    continue;
  }
  if (status === "D") {
    unmarked.push(`${file}: deleted an upstream file`);
    continue;
  }
  const diff = git("diff", "-U0", base, "--", file);
  const hunks = diff.split(/^(?=@@ )/m).slice(1);
  touched.push({ file, hunks: hunks.length, note: UNMARKABLE.get(file) });
  if (UNMARKABLE.has(file)) continue;
  for (const hunk of hunks) {
    if (/junkmail/i.test(hunk)) continue;
    const start = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(hunk)?.[1] ?? "?";
    unmarked.push(`${file}:${start}`);
  }
}
for (const file of git("ls-files", "--others", "--exclude-standard").split("\n")) {
  if (file) owned.push(`${file} (untracked)`);
}

console.log(`Fork vs ${upstreamRef} (merge base ${base.slice(0, 10)})\n`);
console.log(`Upstream files with fork hooks (${touched.length}):`);
for (const { file, hunks, note } of touched) {
  console.log(`  ${file}  [${hunks} hunk${hunks === 1 ? "" : "s"}]${note ? `  ${note}` : ""}`);
}
console.log(`\nFork-owned files: ${owned.length}`);
if (unmarked.length > 0) {
  console.log(`\nUnmarked changes in upstream files (${unmarked.length}):`);
  for (const entry of unmarked) console.log(`  ${entry}`);
  console.log(
    "\nMove the logic into a fork-owned file and leave a one-line hook tagged `// junkmail`.",
  );
  process.exitCode = 1;
}
