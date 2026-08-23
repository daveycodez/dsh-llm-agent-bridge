import { readdir, readFile, writeFile } from "node:fs/promises";

for (const entry of await readdir(new URL("./lib/", import.meta.url), { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
  const file = new URL(`./lib/${entry.name}`, import.meta.url);
  const source = await readFile(file, "utf8");
  await writeFile(file, source.replace(/[ \t]+$/gm, ""));
}
