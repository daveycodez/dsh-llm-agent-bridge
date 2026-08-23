import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function releaseMetadata(tag, version) {
  const expectedTag = `v${version}`;
  if (tag !== expectedTag) {
    throw new Error(`Release tag ${tag || "<missing>"} must exactly match ${expectedTag}`);
  }

  return {
    version,
    npmTag: version.includes("-") ? "next" : "latest",
  };
}

async function main() {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const metadata = releaseMetadata(process.env.GITHUB_REF_NAME ?? process.argv[2], manifest.version);
  const output = `version=${metadata.version}\nnpm_tag=${metadata.npmTag}\n`;

  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
