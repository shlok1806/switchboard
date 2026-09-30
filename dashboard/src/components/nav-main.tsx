/* Switchboard: adapted from the shadcn/ui sidebar-07 block's NavMain (MIT).
 * Our views have no sub-pages, so the Collapsible sub-menu becomes a flat
 * item with an optional SidebarMenuBadge. */

import { type LucideIcon } from "@/components/pixel-icon"

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

export type NavItem = {
  title: string
  url: string
  icon?: LucideIcon
  isActive?: boolean
  badge?: { text: string; tone: "red" | "green"; label: string }
}

export function NavMain({ items }: { items: NavItem[] }) {
  return (
    <SidebarGroup>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.title}>
            <SidebarMenuButton asChild tooltip={item.title} isActive={item.isActive}>
              <a href={item.url} aria-current={item.isActive ? "page" : undefined}>
                {item.icon && <item.icon />}
                <span>{item.title}</span>
              </a>
            </SidebarMenuButton>
            {item.badge && (
              <SidebarMenuBadge
                aria-label={item.badge.label}
                className={cn(
                  "rounded-[4px] font-mono text-[11px]",
                  item.badge.tone === "red" ? "bg-red-tint text-red" : "text-ink-3",
                )}
              >
                {item.badge.text}
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
