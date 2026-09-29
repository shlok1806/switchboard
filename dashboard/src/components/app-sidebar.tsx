"use client"

/* Switchboard: adapted from the shadcn/ui sidebar-07 block (MIT).
 * Kept: Sidebar collapsible="icon", header / content / footer, SidebarRail,
 * NavMain and NavUser structure. Replaced: the sample data and TeamSwitcher,
 * which becomes the Channel header; NavProjects becomes the Agents group. */

import * as React from "react"
import { Activity, Columns3, KanbanSquare, Radio, Users } from "lucide-react"

import { NavMain, type NavItem } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { useChannel } from "@/data/store"
import { href, type Route } from "@/lib/router"
import { cn } from "@/lib/utils"

export function AppSidebar({ route, ...props }: React.ComponentProps<typeof Sidebar> & { route: Route }) {
  const { snapshot, tasks, agents, connection } = useChannel()
  const stale = tasks.filter((t) => t.claim?.stale).length
  const live = agents.filter((a) => a.presence === "live").length

  const items: NavItem[] = [
    { title: "Feed", url: href({ view: "feed" }), icon: Activity, isActive: route.view === "feed" },
    {
      title: "Tasks",
      url: href({ view: "tasks" }),
      icon: KanbanSquare,
      isActive: route.view === "tasks" || route.view === "task",
      badge: stale ? { text: String(stale), tone: "red", label: `${stale} Stale Claim` } : undefined,
    },
    {
      title: "Agents",
      url: href({ view: "agents" }),
      icon: Users,
      isActive: route.view === "agents" || route.view === "agent",
      badge: { text: String(live), tone: "green", label: `${live} Live` },
    },
    { title: "Compare Captures", url: href({ view: "compare" }), icon: Columns3, isActive: route.view === "compare" },
  ]

  const byPresence = [...agents].sort((a, b) => "lig".indexOf(a.presence[0]) - "lig".indexOf(b.presence[0]))

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="hover:bg-transparent">
              <a href={href({ view: "feed" })}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-[8px] bg-accent text-on-accent">
                  <Radio className="size-4" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-display text-[14px] font-semibold text-ink">Switchboard</span>
                  <span className="truncate font-mono text-[11px] text-ink-3">{snapshot?.channel.repo ?? "connecting"}</span>
                </div>
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    connection === "live" ? "bg-green" : "bg-orange",
                  )}
                  aria-label={connection === "live" ? "Connected" : "Reconnecting"}
                />
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={items} />
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Agents</SidebarGroupLabel>
          <SidebarMenu>
            {byPresence.map((a) => (
              <SidebarMenuItem key={a.id}>
                <SidebarMenuButton
                  asChild
                  size="sm"
                  isActive={route.view === "agent" && route.id === a.id}
                  className={a.presence === "gone" ? "opacity-60" : ""}
                >
                  <a href={href({ view: "agent", id: a.id })}>
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        a.presence === "live" ? "bg-green" : a.presence === "idle" ? "bg-orange" : "bg-ink-3",
                      )}
                    />
                    <span className="truncate font-mono text-[11.5px]">{a.id}</span>
                    {a.proxyMode === "raw" && (
                      <span className="ml-auto font-mono text-[9.5px] font-semibold tracking-[0.06em] text-orange">RAW</span>
                    )}
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
