// Copies the plugin-authoring skill into each host's global skill folder, as
// <skills>/hookmux/. The folder is replaced as a whole, so a removed file does
// not linger from an older version.

import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostAdapter } from "../hosts/types.ts";

const SKILL_FOLDER = "hookmux";

export interface SkillResult {
  adapter: HostAdapter;
  target: string;
  error?: string;
}

/** Installs the skill for every adapter that has a skill folder. Missing `skillDir` installs nothing. */
export function installSkill(skillDir: string, adapters: HostAdapter[]): SkillResult[] {
  if (!existsSync(skillDir)) return [];
  const results: SkillResult[] = [];
  for (const adapter of adapters) {
    if (!adapter.skills) continue;
    const target = join(adapter.skills.global, SKILL_FOLDER);
    try {
      const temp = `${target}.tmp-${process.pid}`;
      mkdirSync(dirname(target), { recursive: true });
      rmSync(temp, { recursive: true, force: true });
      cpSync(skillDir, temp, { recursive: true });
      rmSync(target, { recursive: true, force: true });
      renameSync(temp, target);
      results.push({ adapter, target });
    } catch (error) {
      results.push({ adapter, target, error: (error as Error).message });
    }
  }
  return results;
}
