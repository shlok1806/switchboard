"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "@/components/pixel-icon"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/*
 * Switchboard: every toast is a Motif message box, as the site draws its
 * notices: a raised grey box with a pixmap, mapped in over two frames with no
 * slide. Sonner is unstyled here and dressed with classNames; the stack is
 * expanded so boxes sit one above the other instead of fanning.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      expand
      gap={6}
      visibleToasts={4}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="text-green" />,
        info: <InfoIcon />,
        warning: <TriangleAlertIcon className="text-orange" />,
        error: <OctagonXIcon className="text-red" />,
        loading: <Loader2Icon />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "bevel-out notice-in flex w-[min(360px,calc(100vw-24px))] items-start gap-2.5 bg-secondary px-3 py-2.5 pr-8 text-[13px] text-secondary-foreground",
          icon: "mt-px shrink-0",
          content: "flex min-w-0 flex-1 flex-col gap-0.5",
          title: "font-bold leading-snug",
          description: "text-[12.5px] leading-snug text-muted-foreground",
          actionButton: "btn-motif h-[26px] shrink-0 self-center px-3 text-[12px]",
          cancelButton: "btn-motif h-[26px] shrink-0 self-center px-3 text-[12px]",
          closeButton:
            "!absolute !top-1.5 !right-1.5 !left-auto grid size-[18px] place-items-center bevel-thin bg-secondary text-secondary-foreground active:bevel-thin-in [&>svg]:size-3",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
