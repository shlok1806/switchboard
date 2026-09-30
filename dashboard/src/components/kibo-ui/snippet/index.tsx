"use client";

/* Switchboard: Kibo UI Snippet, re-skinned as an inset Motif field with a bevelled copy button. */

import { CheckIcon, CopyIcon } from "@/components/pixel-icon";
import {
  type ComponentProps,
  cloneElement,
  type HTMLAttributes,
  type ReactElement,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type SnippetProps = ComponentProps<typeof Tabs>;

export const Snippet = ({ className, ...props }: SnippetProps) => (
  <Tabs
    className={cn(
      "group w-full gap-0 overflow-hidden bevel-in bg-card text-card-foreground",
      className
    )}
    {...props}
  />
);

export type SnippetHeaderProps = HTMLAttributes<HTMLDivElement>;

export const SnippetHeader = ({ className, ...props }: SnippetHeaderProps) => (
  <div
    className={cn(
      "flex flex-row items-center justify-between border-b border-border bg-secondary py-0.5 pr-0.5 pl-2 text-secondary-foreground",
      className
    )}
    {...props}
  />
);

export type SnippetCopyButtonProps = ComponentProps<typeof Button> & {
  value: string;
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const SnippetCopyButton = ({
  asChild,
  value,
  onCopy,
  onError,
  timeout = 2000,
  children,
  ...props
}: SnippetCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);

  const copyToClipboard = () => {
    if (
      typeof window === "undefined" ||
      !navigator.clipboard.writeText ||
      !value
    ) {
      return;
    }

    navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      onCopy?.();

      setTimeout(() => setIsCopied(false), timeout);
    }, onError);
  };

  if (asChild) {
    return cloneElement(children as ReactElement, {
      // @ts-expect-error - we know this is a button
      onClick: copyToClipboard,
    });
  }

  const icon = isCopied ? <CheckIcon /> : <CopyIcon />;

  return (
    <Button
      className="btn-motif size-6 coarse:size-9"
      onClick={copyToClipboard}
      size="icon"
      variant="outline"
      {...props}
    >
      {children ?? icon}
    </Button>
  );
};

export type SnippetTabsListProps = ComponentProps<typeof TabsList>;

export const SnippetTabsList = TabsList;

export type SnippetTabsTriggerProps = ComponentProps<typeof TabsTrigger>;

export const SnippetTabsTrigger = ({
  className,
  ...props
}: SnippetTabsTriggerProps) => (
  <TabsTrigger className={cn("gap-1.5", className)} {...props} />
);

export type SnippetTabsContentProps = ComponentProps<typeof TabsContent>;

export const SnippetTabsContent = ({
  className,
  children,
  ...props
}: SnippetTabsContentProps) => (
  <TabsContent
    asChild
    className={cn("mt-0 bg-card px-2.5 py-2 font-mono text-[12px]", className)}
    {...props}
  >
    <pre className="truncate">{children}</pre>
  </TabsContent>
);
