// The Host's pieces that do not need a Channel: the LaunchAgent it installs, and how
// it recognizes Claude Code's folder trust dialog. The Host as a whole is in e2e.test.ts.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LAUNCH_AGENT_LABEL, launchAgentPlist } from "../src/host/launchd";
import { plainText, showsTrustDialog } from "../src/host/supervisor";

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

describe("the Host's LaunchAgent", () => {
  it("is a property list launchd reads, running `host run` in the background with the recorded environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "switchboard-plist-"));
    try {
      const path = join(dir, `${LAUNCH_AGENT_LABEL}.plist`);
      await writeFile(
        path,
        launchAgentPlist({
          node: "/opt/node <22>/bin/node",
          cli: "/Users/a&b/switchboard.js",
          logPath: "/Users/a&b/.config/switchboard/host/host.log",
          workingDirectory: "/Users/a&b",
          environment: { PATH: "/usr/bin:/bin", SWITCHBOARD_CONFIG_DIR: "/Users/a&b/.config/switchboard" },
        }),
      );
      // Python's plistlib reads property lists as strictly as launchd, on Linux CI too.
      const { stdout } = await run("python3", [
        "-c",
        "import json, plistlib, sys; print(json.dumps(plistlib.load(open(sys.argv[1], 'rb'))))",
        path,
      ]);
      expect(JSON.parse(stdout)).toEqual({
        Label: "dev.switchboard.host",
        ProgramArguments: ["/opt/node <22>/bin/node", "/Users/a&b/switchboard.js", "host", "run"],
        EnvironmentVariables: { PATH: "/usr/bin:/bin", SWITCHBOARD_CONFIG_DIR: "/Users/a&b/.config/switchboard" },
        WorkingDirectory: "/Users/a&b",
        RunAtLoad: true,
        // Restarted after a crash only: a refusal a restart cannot help exits 0.
        KeepAlive: { SuccessfulExit: false },
        ThrottleInterval: 30,
        ProcessType: "Background",
        StandardOutPath: "/Users/a&b/.config/switchboard/host/host.log",
        StandardErrorPath: "/Users/a&b/.config/switchboard/host/host.log",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the folder trust dialog", () => {
  it("is recognized on Claude Code 2.1.300's screen, whose words are placed by cursor moves", async () => {
    const screen = await readFile(join(here, "fixtures", "claude-trust-dialog.ansi"), "utf8");
    expect(showsTrustDialog(plainText(screen))).toBe(true);
  });

  it("is not seen in a session that talks about trust", () => {
    expect(showsTrustDialog("I trust the tests more than this folder's README.")).toBe(false);
  });

  it("is not seen in a brief that quotes one of its lines", () => {
    expect(showsTrustDialog("When Claude asks, pick 'Yes, I trust this folder' and carry on.")).toBe(false);
  });
});
