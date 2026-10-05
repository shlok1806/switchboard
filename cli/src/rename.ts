// `switchboard rename <agent> <nickname>`: a Person renames an Agent on the
// Channel, while it runs or not (ADR 0009). Any Person on the Channel may rename
// any Agent; the Agent ID never changes, and the rename is an Event naming who
// made it. The Agent can be named by its Agent ID, the ID without its Person
// (`claude/7f3a`), or its current Nickname.

import type { Agent, AgentResponse, AgentsResponse } from "../../shared/src/index";
import { nicknamePath, sameNickname } from "../../shared/src/index";
import { ChannelChoiceError, chooseChannel, describeChoice } from "./channel-choice";
import { ChannelClient, ChannelError, targetOf } from "./channel-client";
import { readConfig } from "./config";

/** The Agents `name` names: by Agent ID, by the ID without its Person, or by Nickname. */
export function matchAgents(agents: readonly Agent[], name: string): Agent[] {
  const wanted = name.trim();
  const exact = agents.filter((a) => a.id === wanted.toLowerCase());
  if (exact.length > 0) return exact;
  const short = agents.filter((a) => a.id.endsWith(`/${wanted.toLowerCase()}`));
  if (short.length > 0) return short;
  return agents.filter((a) => a.nickname !== undefined && sameNickname(a.nickname, wanted));
}

export interface RenameOptions {
  agent: string;
  /** Null clears the Nickname. */
  nickname: string | null;
  repo?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  say: (line: string) => void;
}

/** Renames the Agent; answers with the exit code, having said why on failure. */
export async function renameAgent(options: RenameOptions): Promise<number> {
  const config = await readConfig(options.env);
  if (!config) {
    console.error("switchboard: not logged in. Run `switchboard login` first.");
    return 1;
  }
  let repo: string;
  try {
    const choice = await chooseChannel(config, {
      ...(options.repo === undefined ? {} : { flag: options.repo }),
      env: options.env,
      cwd: options.cwd,
    });
    repo = choice.repo;
    if (choice.reason !== "default") options.say(`Using ${describeChoice(choice)}.`);
  } catch (error) {
    if (!(error instanceof ChannelChoiceError)) throw error;
    console.error(`switchboard: ${error.message}`);
    return 2;
  }
  const client = new ChannelClient(targetOf(config, repo));
  try {
    const { agents } = await client.request<AgentsResponse>("/api/agents");
    const found = matchAgents(agents, options.agent);
    if (found.length !== 1) {
      console.error(
        found.length === 0
          ? `switchboard: no Agent on ${repo} is called ${options.agent}. Name it by its Agent ID or Nickname.`
          : `switchboard: ${options.agent} could be ${found.map((a) => a.id).join(", ")}. Use the full Agent ID.`,
      );
      return 1;
    }
    const [target] = found as [Agent];
    const { agent } = await client.request<AgentResponse>(nicknamePath(target.id), {
      method: "POST",
      body: JSON.stringify({ nickname: options.nickname }),
    });
    options.say(
      agent.nickname === undefined
        ? `${agent.id} has no Nickname now.`
        : `${agent.id} is "${agent.nickname}" on ${repo} now.`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof ChannelError)) throw error;
    console.error(`switchboard: ${error.message}`);
    return 1;
  }
}
