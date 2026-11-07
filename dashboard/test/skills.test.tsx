// @vitest-environment happy-dom
// The Skills view, used as a Person would: it lists the skills Persons share on the Channel,
// each at its latest version with who published it; a skill opens with every file in full and
// the command that installs it, at the version picked; and a Worker without shared skills says so.

import type { Agent, AgentId, ChannelSnapshot, Skill, SkillEntry, SkillResponse, SkillsResponse } from "@shared/index";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { SkillsView } from "@/views/SkillsView";

const scout = {
  id: "maya/claude/2b8d" as AgentId,
  person: "maya",
  nickname: "scout",
  cli: "claude-code",
  presence: "live",
  lastSeenAt: "2026-10-15T10:00:00.000Z",
  startedAt: "2026-10-15T09:00:00.000Z",
} as unknown as Agent;

function channel(extra: Partial<ChannelSource>) {
  const source = {
    me: "shlok",
    capabilities: {},
    snapshot: async () =>
      ({ channel: { repo: "shlok1806/app" }, persons: [], agents: [scout], tasks: [], events: [], verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
    hosts: async () => null,
    subscribe: () => () => {},
    ...extra,
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const ENTRY = "---\nname: release-notes\ndescription: Writes release notes from merged pull requests.\n---\n\nGroup them by label.\n";

/** The bytes the Channel holds, by digest; a stand-in digest per file. */
const bytesByDigest = new Map<string, Uint8Array>();

function entry(path: string, content: string | Uint8Array): SkillEntry {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const digest = `${bytesByDigest.size + 1}`.padStart(64, "a");
  bytesByDigest.set(digest, bytes);
  return { path, size: bytes.length, digest, encoding: typeof content === "string" ? "utf8" : "base64" };
}

const v = (version: number, files: SkillEntry[], name = "release-notes"): Skill => ({
  name,
  version,
  description: "Writes release notes from merged pull requests.",
  publishedBy: { person: "maya", agent: scout.id },
  publishedAt: "2026-10-15T09:30:00.000Z",
  size: files.reduce((sum, f) => sum + f.size, 0),
  paths: files.map((f) => f.path),
  digest: `${version}`.repeat(64),
  files,
});

const versions = [
  v(1, [entry("SKILL.md", ENTRY.replace("Group them by label.\n", ""))]),
  v(2, [entry("SKILL.md", ENTRY), entry("templates/notes.md", "## {{tag}}\n")]),
];

const skills = async (): Promise<SkillsResponse> => {
  const { files: _files, ...latest } = versions[1]!;
  return { skills: [latest] };
};
const skill = async (_name: string, version?: number): Promise<SkillResponse> => ({ skill: versions[(version ?? 2) - 1]!, versions: [1, 2] });
const skillFiles = async (files: SkillEntry[]) => new Map(files.map((f) => [f.path, bytesByDigest.get(f.digest)!]));

describe("the Skills view", () => {
  it("lists each shared skill at its latest version, with what it does and the Agent that published it", async () => {
    render(<SkillsView />, { wrapper: channel({ skills, skill, skillFiles }) });
    const row = (await screen.findByText("release-notes")).closest("li")!;
    expect(within(row).getByText("v2")).toBeTruthy();
    expect(within(row).getByText("Writes release notes from merged pull requests.")).toBeTruthy();
    expect(within(row).getByText(/2 files/)).toBeTruthy();
    expect(within(row).getByRole("link", { name: "maya/scout" }).getAttribute("href")).toBe(`#/agents/${encodeURIComponent(scout.id)}`);
    fireEvent.click(within(row).getByRole("button"));
    expect(window.location.hash).toBe("#/skills/release-notes");
  });

  it("opens a skill with every file in full and the command that installs the version shown", async () => {
    const read = vi.fn(skill);
    const { rerender } = render(<SkillsView name="release-notes" />, { wrapper: channel({ skills, skill: read, skillFiles }) });
    const inspector = await screen.findByRole("complementary", { name: "release-notes, in the inspector" });
    await waitFor(() => expect(within(inspector).getByText("templates/notes.md")).toBeTruthy());
    expect(within(inspector).getByText(/Group them by label\./)).toBeTruthy();
    expect(within(inspector).getByText("switchboard skills install release-notes")).toBeTruthy();

    // An older version: its own files, and the command names it.
    fireEvent.click(within(inspector).getByRole("button", { name: "v1" }));
    expect(window.location.hash).toBe("#/skills/release-notes/1");
    rerender(<SkillsView name="release-notes" version={1} />);
    await waitFor(() => expect(screen.getByText("switchboard skills install release-notes --version 1")).toBeTruthy());
    expect(screen.queryByText("templates/notes.md")).toBeNull();
    expect(read).toHaveBeenLastCalledWith("release-notes", 1);
  });

  it("shows a binary file by its size and SHA-256, and a large skill's text a file at a time", async () => {
    const font = entry("fonts/inter.woff2", Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 0xff]));
    const bundle = entry("lib/bundle.js", `${"export const a = 1;\n".repeat(40_000)}`);
    const specimen = v(1, [entry("SKILL.md", ENTRY), font, bundle], "type-specimen");
    const read = vi.fn(skillFiles);
    render(<SkillsView name="type-specimen" />, {
      wrapper: channel({ skills, skill: async () => ({ skill: specimen, versions: [1] }), skillFiles: read }),
    });
    const inspector = await screen.findByRole("complementary", { name: "type-specimen, in the inspector" });
    await waitFor(() => expect(within(inspector).getByText("fonts/inter.woff2")).toBeTruthy());
    expect(within(inspector).getByText(/3 files · 781\.4 KB · 1 binary/)).toBeTruthy();
    expect(within(inspector).getByText("7 bytes · binary, not shown")).toBeTruthy();
    const shown = within(inspector).getByLabelText("fonts/inter.woff2, binary");
    expect(within(shown).getByText("7 bytes")).toBeTruthy();
    expect(within(shown).getByText(font.digest)).toBeTruthy();
    expect(within(inspector).getByText(/with each binary file's size and SHA-256/)).toBeTruthy();
    // Over half a megabyte of text: nothing read until a file is asked for, and never the font.
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(within(inspector).getByRole("button", { name: "Show SKILL.md" }));
    await waitFor(() => expect(within(inspector).getByText(/Group them by label\./)).toBeTruthy());
    expect(read).toHaveBeenCalledWith([specimen.files[0]]);
    expect(within(inspector).getByRole("button", { name: "Show bundle.js" })).toBeTruthy();
  });

  it("says why a skill cannot be read", async () => {
    const missing = async (): Promise<SkillResponse> => {
      throw new Error("No skill is named gone on this Channel.");
    };
    render(<SkillsView name="gone" />, { wrapper: channel({ skills, skill: missing }) });
    expect(await screen.findByText("No skill is named gone on this Channel.")).toBeTruthy();
  });

  it("says when the Channel's Worker has no shared skills", async () => {
    render(<SkillsView />, { wrapper: channel({ skills: async () => null }) });
    expect(await screen.findByRole("heading", { name: "Skills are not on this Channel yet" })).toBeTruthy();
  });
});
