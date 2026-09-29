import { useEffect, useState } from "react";
import { Activity, Columns3, KanbanSquare, Moon, Sun, Users } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { useChannel } from "@/data/store";
import { go, type Route } from "@/lib/router";
import { useTheme } from "@/lib/theme";
import { PRESENCE_LABEL } from "@/lib/format";

/** ⌘K: jump to any view, Task or Agent. shadcn Command over cmdk. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { tasks, agents } = useChannel();
  const { resolved, set } = useTheme();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, onOpenChange]);

  const run = (route: Route) => {
    onOpenChange(false);
    go(route);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Jump to" description="Search views, Tasks and Agents">
      <CommandInput placeholder="Jump to a view, Task or Agent" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Views">
          <CommandItem onSelect={() => run({ view: "feed" })}>
            <Activity /> Feed
          </CommandItem>
          <CommandItem onSelect={() => run({ view: "tasks" })}>
            <KanbanSquare /> Tasks
          </CommandItem>
          <CommandItem onSelect={() => run({ view: "agents" })}>
            <Users /> Agents
          </CommandItem>
          <CommandItem onSelect={() => run({ view: "compare" })}>
            <Columns3 /> Compare Captures
          </CommandItem>
          <CommandItem
            onSelect={() => {
              set(resolved === "dark" ? "light" : "dark");
              onOpenChange(false);
            }}
          >
            {resolved === "dark" ? <Sun /> : <Moon />} Switch to {resolved === "dark" ? "light" : "dark"} theme
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Tasks">
          {[...tasks]
            .sort((a, b) => a.number - b.number)
            .map((t) => (
              <CommandItem key={t.number} value={`#${t.number} ${t.title}`} onSelect={() => run({ view: "task", number: t.number })}>
                <span className="font-mono text-[12px] text-ink-3">#{t.number}</span>
                <span className="truncate">{t.title}</span>
                {t.claim?.stale && <CommandShortcut className="text-red">Stale</CommandShortcut>}
              </CommandItem>
            ))}
        </CommandGroup>
        <CommandGroup heading="Agents">
          {agents.map((a) => (
            <CommandItem key={a.id} value={`${a.id} ${a.nickname ?? ""}`} onSelect={() => run({ view: "agent", id: a.id })}>
              <span className="truncate font-mono text-[12px]">{a.id}</span>
              {a.nickname && <span className="truncate text-ink-3">{a.nickname}</span>}
              <CommandShortcut>{PRESENCE_LABEL[a.presence]}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export function usePaletteState() {
  return useState(false);
}
