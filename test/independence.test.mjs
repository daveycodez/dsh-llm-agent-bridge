import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

test("plugin remains independently installable", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "dsh-llm-agent-bridge");
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const relayDependencies = Object.keys(manifest[field] ?? {}).filter(isRelayPackage);
    assert.deepEqual(relayDependencies, [], `${field} must not depend on another Relay package`);
  }

  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /@relay\/plugin-sdk/, `${file} imports Relay's private plugin SDK`);
    assert.doesNotMatch(source, /(?:\.\.\/){2,}(?:packages|integrations)\//, `${file} reaches outside this repository`);
  }
});

test("build artifacts contain no checkout-specific path", async () => {
  const entries = await readdir(join(root, "lib"), { withFileTypes: true }).catch(() => null);
  if (entries === null) return; // not built yet
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith(".js") && !entry.name.endsWith(".map"))) continue;
    assert.doesNotMatch(await readFile(join(root, "lib", entry.name), "utf8"), new RegExp(escapeRegExp(root)));
  }
});

async function sourceFiles(directory) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: directory });
  return stdout
    .split("\0")
    .filter((path) => path && !path.startsWith("lib/") && [".js", ".mjs", ".ts", ".tsx"].includes(extname(path)))
    .map((path) => join(directory, path));
}

function isRelayPackage(name) {
  return name.startsWith("@relay/") || name.startsWith("relay-dsh-plugin-");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
