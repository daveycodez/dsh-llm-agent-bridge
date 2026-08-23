import { cp, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export async function installManagedPreset(source, id) {
  const home = resolve(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
  const target = join(home, ".agent-presets", id);
  await mkdir(join(home, ".agent-presets"), { recursive: true });
  if (await exists(target)) {
    if (!await exists(join(target, ".relay-managed"))) {
      throw new Error(`Relay preset ${id} already exists and is not Relay-managed`);
    }
  } else {
    await mkdir(target, { recursive: true });
  }
  for (const file of ["agent.cordis.yml", "preset.yml", ".relay-managed"]) {
    await cp(join(source, file), join(target, file));
  }
  return target;
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
