import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

/** The verification command the README invites a skeptic to run, as written. */
async function readmeCommand() {
  const readme = await readFile(join(root, "README.md"), "utf8");
  const match = /```bash\n(grep -rnE [^\n]+)\n```/.exec(readme);
  assert.ok(match, "the README must carry a runnable verification command");
  return match[1];
}

test("the README's verification command runs, and covers every source directory", async () => {
  const command = await readmeCommand();
  const [, pattern, ...paths] = /grep -rnE "([^"]+)" (.+)/.exec(command) ?? [];
  assert.ok(pattern, "the command must carry a pattern");

  const targets = new Set(paths.join(" ").split(/\s+/).filter(Boolean));
  // Every directory holding source must be named, or the audit has a blind spot
  // exactly where new code lands.
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (["node_modules", ".git", ".github", "lib", "test"].includes(entry.name)) continue;
    assert.ok(targets.has(entry.name), `${entry.name}/ holds source but the README's audit does not read it`);
  }
  assert.ok(targets.has("*.js") && targets.has("*.mjs"), "the root modules must be covered");
});

test("the audited patterns appear nowhere in the source", async () => {
  const command = await readmeCommand();
  const { stdout } = await execFileAsync("bash", ["-c", `cd ${JSON.stringify(root)} && ${command} || true`]);
  const hits = stdout.split("\n").filter(Boolean);

  // A comment explaining why a name is absent is allowed; anything else is the
  // claim failing, not the test being strict.
  const code = hits.filter(line => !/:\s*(\/\/|\*|\/\*)/.test(line.replace(/^[^:]+:\d+:/, "")));
  assert.deepEqual(code, [], "the README claims these names appear nowhere in the source");
});
