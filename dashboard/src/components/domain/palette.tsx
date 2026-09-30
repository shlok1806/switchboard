import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { VIEWS } from "@/components/shell/nav";
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
import { useTheme, type ThemeChoice } from "@/lib/theme";
import { PRESENCE_LABEL } from "@/lib/format";

const THEMES: { id: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { id: "system", label: "System theme", icon: Monitor },
  { id: "light", label: "Light theme", icon: Sun },
  { id: "dark", label: "Dark theme", icon: Moon },
];

/** ⌘K: jump to any view, Task or Agent. shadcn Command over cmdk. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { tasks, agents } = useChannel();
  const { choice, set } = useTheme();

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
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search" description="Search views, Tasks and Agents">
      <CommandInput placeholder="Search views, Tasks and Agents" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Views">
          {VIEWS.map((v) => (
            <CommandItem key={v.id} onSelect={() => run({ view: v.id })}>
              <v.icon aria-hidden /> {v.title}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Theme">
          {THEMES.map((t) => (
            <CommandItem
              key={t.id}
              value={`Theme ${t.label}`}
              onSelect={() => {
                set(t.id);
                onOpenChange(false);
              }}
            >
              <t.icon aria-hidden /> {t.label}
              {choice === t.id && <CommandShortcut>Current</CommandShortcut>}
            </CommandItem>
          ))}
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
