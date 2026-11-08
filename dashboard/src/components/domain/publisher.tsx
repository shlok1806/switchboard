import type { AgentId, PersonName } from "@shared/index";
import { shortName } from "@/components/domain/fleet";
import { useIndex } from "@/data/store";
import { href } from "@/lib/router";

/**
 * Who published a version of a skill or an artifact: the Agent, linked to its page, when one
 * did it for its Person; the Person otherwise. An Agent the Channel no longer lists is named by
 * its Nickname then, or its ID.
 */
export function Publisher({ by }: { by: { person: PersonName; agent?: AgentId; nickname?: string } }) {
  const { agentById } = useIndex();
  const agent = by.agent === undefined ? undefined : agentById.get(by.agent);
  if (agent) {
    return (
      <a href={href({ view: "agent", id: agent.id })} className="text-ink hover:underline">
        {by.person}/{shortName(agent)}
      </a>
    );
  }
  if (by.agent !== undefined && by.nickname) return <span>{`${by.person}/${by.nickname}`}</span>;
  return <span>{by.agent ?? by.person}</span>;
}
