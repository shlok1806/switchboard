// `switchboard --help`, run from the built CLI the way a Person runs it.

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/clis/index";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "switchboard.js");

describe("switchboard --help", () => {
  it("offers the Proxy Capture flags for every CLI that has one", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, "--help"]);
    for (const [name, adapter] of Object.entries(ADAPTERS)) {
      const line = stdout.split("\n").find((l) => l.trimStart().startsWith(`switchboard run ${name} `));
      expect(line, `usage line for run ${name}`).toBeDefined();
      expect(line?.includes("[--proxy raw|digest|off] [--no-mask]")).toBe(adapter.proxy);
    }
    expect(stdout).not.toMatch(/without the\s+Proxy Capture/);
  });
});
