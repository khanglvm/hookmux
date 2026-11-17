// Layout of the hookmux home folder (default ~/.hookmux, or $HOOKMUX_HOME).

import { homedir } from "node:os";
import { join } from "node:path";

export interface HomePaths {
  root: string;
  bin: string;
  launcher: string;
  engineRoot: string;
  /** Symlink to the active engine version; the launcher runs through it. */
  engineCurrent: string;
  plugins: string;
  config: string;
  registry: string;
  trust: string;
  sessions: string;
  logs: string;
  logFile: string;
  logSettings: string;
  health: string;
  /** Hub-owned shadow and disabled lists, applied after user overrides. */
  flags: string;
  /** Where each installed plugin came from (`hookmux add`). */
  sources: string;
  /** Install settings that `sync` reuses, such as the host timeout. */
  installState: string;
  /** Scratch space on the same filesystem as plugins/, so staged copies can be renamed into place. */
  staging: string;
}

export function homePaths(root = process.env.HOOKMUX_HOME || join(homedir(), ".hookmux")): HomePaths {
  return {
    root,
    bin: join(root, "bin"),
    launcher: join(root, "bin", "hookmux-hook"),
    engineRoot: join(root, "engine"),
    engineCurrent: join(root, "engine", "current"),
    plugins: join(root, "plugins"),
    config: join(root, "config.toml"),
    registry: join(root, "registry.json"),
    trust: join(root, "trust.json"),
    sessions: join(root, "state", "sessions"),
    logs: join(root, "logs"),
    logFile: join(root, "logs", "hookmux.log"),
    logSettings: join(root, "logs", "settings.json"),
    health: join(root, "state", "health.json"),
    flags: join(root, "flags.json"),
    sources: join(root, "sources.json"),
    installState: join(root, "install.json"),
    staging: join(root, "tmp"),
  };
}
