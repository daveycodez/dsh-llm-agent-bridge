import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

for (const entry of await readdir(new URL("./lib/", import.meta.url), { withFileTypes: true })) {
  if (!entry.isFile() || (!entry.name.endsWith(".js") && !entry.name.endsWith(".js.map"))) continue;
  const file = new URL(`./lib/${entry.name}`, import.meta.url);
  const source = await readFile(file, "utf8");
  if (entry.name.endsWith(".map")) {
    const map = JSON.parse(source);
    map.sources = map.sources.map(normalizePath);
    await writeFile(file, `${JSON.stringify(map)}\n`);
  } else {
    await writeFile(file, normalizePath(source).replace(/[ \t]+$/gm, ""));
  }
}

function normalizePath(value) {
  return value
    .split(root).join(".")
    .replace(/(relay-(?:global-css|css-module):)(?:[A-Za-z]:)?(?:\/[^/\n"']+)+\/node_modules\//g, "$1node_modules/")
    .replace(/^(?:[A-Za-z]:)?(?:\/[^/\n"']+)+\/node_modules\//g, "node_modules/")
    .replace(/(?:\.\.\/)+node_modules\//g, "node_modules/");
}
