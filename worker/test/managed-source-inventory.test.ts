import { describe, expect, it } from "vitest";
import inventory from "../../m1/p3/P3_ROUTE_INVENTORY.md?raw";
import agents_source from "../src/agents.ts?raw";
import agents_api from "../src/agents-api.ts?raw";
import artifacts_api from "../src/artifacts-api.ts?raw";
import branches_source from "../src/branches.ts?raw";
import branches_api from "../src/branches-api.ts?raw";
import brief_api from "../src/brief-api.ts?raw";
import channel from "../src/channel.ts?raw";
import claims_api from "../src/claims-api.ts?raw";
import directives_source from "../src/directives.ts?raw";
import directives_api from "../src/directives-api.ts?raw";
import hosts_source from "../src/hosts.ts?raw";
import hosts_api from "../src/hosts-api.ts?raw";
import index from "../src/index.ts?raw";
import librarian_api from "../src/librarian-api.ts?raw";
import brief from "../src/mcp/brief.ts?raw";
import costs from "../src/mcp/costs.ts?raw";
import github from "../src/mcp/github.ts?raw";
import tools from "../src/mcp/tools.ts?raw";
import memory_api from "../src/memory-api.ts?raw";
import relay_source from "../src/relay/relay.ts?raw";
import settings_api from "../src/settings-api.ts?raw";
import skills_api from "../src/skills-api.ts?raw";
import takeover_api from "../src/takeover-api.ts?raw";
import tasks_source from "../src/tasks.ts?raw";
import tasks_api from "../src/tasks-api.ts?raw";
import { SOURCE_INVENTORY } from "./managed-source-inventory";

const routers = {
  index: index,
  "agents-api": agents_api,
  "artifacts-api": artifacts_api,
  "branches-api": branches_api,
  "brief-api": brief_api,
  "claims-api": claims_api,
  "directives-api": directives_api,
  "hosts-api": hosts_api,
  "librarian-api": librarian_api,
  "memory-api": memory_api,
  "settings-api": settings_api,
  "skills-api": skills_api,
  "takeover-api": takeover_api,
  "tasks-api": tasks_api,
};
function discover() {
  const found = new Set<string>();
  for (const [file, source] of Object.entries(routers)) {
    for (const match of source.matchAll(
      /["']((?:(?:GET|POST|PUT|DELETE|PATCH) )?\/api\/[^"'\n]*)["']|(\/\^\\\/api\\\/[^\n]+)/g,
    ))
      found.add(`http:${file}:${match[1] ?? match[2]}`);
  }
  for (const match of channel.matchAll(/^ {2}(?:override )?(?:async )?([a-zA-Z]\w*)\(/gm))
    if (match[1] !== "constructor") found.add(`rpc:${match[1]}`);
  for (const source of [
    channel,
    relay_source,
    agents_source,
    hosts_source,
    directives_source,
    tasks_source,
    branches_source,
  ])
    for (const match of source.matchAll(/\btype\s*(?:!==|===|:)\s*["']([^"']+)["']/g)) found.add(`frame:${match[1]}`);
  for (const source of [tools, brief, github, costs])
    for (const match of source.matchAll(/\bname:\s*"([^"]+)"/g)) found.add(`mcp:${match[1]}`);
  return [...found].sort();
}
describe("source-discovered managed entry-point inventory", () => {
  it("classifies every actual HTTP matcher, public RPC, MCP tool and frame entry", () => {
    expect(discover()).toEqual(Object.keys(SOURCE_INVENTORY).sort());
    for (const classification of Object.values(SOURCE_INVENTORY)) {
      expect(inventory).toContain(`| ${classification[0]} |`);
      expect(classification[0]).toMatch(/^[HCWMJN]\d+$/);
      expect(classification[1].length).toBeGreaterThan(0);
    }
  });
  it("discovers additions to the actual MCP tool dispatch list", () => {
    const exported = /export const TOOLS[^=]*=\s*\[([^\]]+)\]/.exec(tools)?.[1];
    expect(
      exported
        ?.split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .sort(),
    ).toEqual(["channelTool", "githubTool", "briefTool", "costsTool"].sort());
  });
  it("discovers new Channel route modules imported by the actual router", () => {
    const modules = [...index.matchAll(/from "\.\/([^"/]+-api)"/g)]
      .map((match) => match[1])
      .filter((name) => name !== "auth-api" && name !== "workspace-api");
    expect([...new Set(modules)].sort()).toEqual(
      Object.keys(routers)
        .filter((name) => name !== "index")
        .sort(),
    );
  });
});
