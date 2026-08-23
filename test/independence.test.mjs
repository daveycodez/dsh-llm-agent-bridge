import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("Claude plugin remains independently installable", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "@relay/dsh-plugin-claude");
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const relayDependencies = Object.keys(manifest[field] ?? {}).filter((name) => name.startsWith("@relay/"));
    assert.deepEqual(relayDependencies, [], `${field} must not depend on another Relay package`);
  }

  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /@relay\/plugin-sdk/, `${file} imports Relay's private plugin SDK`);
    assert.doesNotMatch(source, /(?:\.\.\/){2,}(?:packages|integrations)\//, `${file} reaches outside this repository`);
  }
});

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "lib" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if ([".js", ".mjs", ".ts", ".tsx"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}
