/* Switchboard: adapted from the shadcn/ui sidebar-07 block's NavUser (MIT).
 * The account menu becomes the Person menu: who you are and the theme. */

import { ChevronsUpDown, Monitor, Moon, Sun } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useChannel, useMe } from "@/data/store"
import { useTheme, type ThemeChoice } from "@/lib/theme"

export function NavUser() {
  const { isMobile } = useSidebar()
  const me = useMe()
  const { agents } = useChannel()
  const { choice, set } = useTheme()
  const mine = agents.filter((a) => a.person === me && a.presence !== "gone").length

  const who = (
    <>
      <Avatar className="h-8 w-8 rounded-[8px]">
        <AvatarFallback className="rounded-[8px] bg-hover-2 font-display text-[13px] font-semibold text-ink">
          {me.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left leading-tight">
        <span className="truncate text-[13px] font-medium text-ink">{me}</span>
        <span className="truncate text-[11.5px] text-ink-3">
          {mine} {mine === 1 ? "Agent" : "Agents"} running
        </span>
      </div>
    </>
  )

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {who}
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-[10px]"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left">{who}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11.5px] font-normal text-ink-3">Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={choice} onValueChange={(v) => set(v as ThemeChoice)}>
              <DropdownMenuRadioItem value="system">
                <Monitor /> System
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">
                <Sun /> Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon /> Dark
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
