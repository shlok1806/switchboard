import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import {
  CheckCircle,
  ChevronDown,
  Loader2,
  Settings,
  XCircle,
} from "@/components/pixel-icon"
import { useState } from "react"

export type ToolPart = {
  type: string
  state:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error"
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  toolCallId?: string
  errorText?: string
}

export type ToolProps = {
  toolPart: ToolPart
  defaultOpen?: boolean
  className?: string
}

const Tool = ({ toolPart, defaultOpen = false, className }: ToolProps) => {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  const { state, input, output, toolCallId } = toolPart

  const getStateIcon = () => {
    switch (state) {
      case "input-streaming":
        return <Loader2 className="h-4 w-4 animate-spin text-accent" />
      case "input-available":
        return <Settings className="h-4 w-4 text-orange" />
      case "output-available":
        return <CheckCircle className="h-4 w-4 text-green" />
      case "output-error":
        return <XCircle className="h-4 w-4 text-red" />
      default:
        return <Settings className="text-muted-foreground h-4 w-4" />
    }
  }

  const getStateBadge = () => {
    const baseClasses = "px-2 py-0.5 rounded-full text-[11.5px] font-medium"
    switch (state) {
      case "input-streaming":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-accent-tint text-accent-ink"
            )}
          >
            Processing
          </span>
        )
      case "input-available":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-orange-tint text-orange"
            )}
          >
            Ready
          </span>
        )
      case "output-available":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-green-tint text-green"
            )}
          >
            Completed
          </span>
        )
      case "output-error":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-red-tint text-red"
            )}
          >
            Error
          </span>
        )
      default:
        return (
          <span
            className={cn(
              baseClasses,
              "bg-inset text-ink-2"
            )}
          >
            Pending
          </span>
        )
    }
  }

  const formatValue = (value: unknown): string => {
    if (value === null) return "null"
    if (value === undefined) return "undefined"
    if (typeof value === "string") return value
    if (typeof value === "object") {
      return JSON.stringify(value, null, 2)
    }
    return String(value)
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-card bg-surface shadow-card",
        className
      )}
    >
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="bg-surface h-auto w-full justify-between rounded-b-none px-3 py-2 font-normal hover:bg-inset"
          >
            <div className="flex items-center gap-2">
              {getStateIcon()}
              <span className="font-mono text-[12.5px] font-medium">
                {toolPart.type}
              </span>
              {getStateBadge()}
            </div>
            <ChevronDown className={cn("h-4 w-4", isOpen && "rotate-180")} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent
          className={cn(
            "border-border border-t",
            "data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden"
          )}
        >
          <div className="bg-surface space-y-3 p-3">
            {input && Object.keys(input).length > 0 && (
              <div>
                <h4 className="text-muted-foreground mb-2 text-sm font-medium">
                  Input
                </h4>
                <div className="bg-inset rounded-[6px] border border-line p-2 font-mono text-[12px]">
                  {Object.entries(input).map(([key, value]) => (
                    <div key={key} className="mb-1">
                      <span className="text-muted-foreground">{key}:</span>{" "}
                      <span>{formatValue(value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {output && (
              <div>
                <h4 className="text-muted-foreground mb-2 text-sm font-medium">
                  Output
                </h4>
                <div className="bg-inset max-h-60 overflow-auto rounded-[6px] border border-line p-2 font-mono text-[12px]">
                  <pre className="whitespace-pre-wrap">
                    {formatValue(output)}
                  </pre>
                </div>
              </div>
            )}

            {state === "output-error" && toolPart.errorText && (
              <div>
                <h4 className="mb-2 text-sm font-medium text-red">Error</h4>
                <div className="bg-background rounded border border-red/30 p-2 text-sm">
                  {toolPart.errorText}
                </div>
              </div>
            )}

            {state === "input-streaming" && (
              <div className="text-muted-foreground text-sm">
                Processing tool call...
              </div>
            )}

            {toolCallId && (
              <div className="text-muted-foreground border-t border-line pt-2 text-xs">
                <span className="font-mono">Call ID: {toolCallId}</span>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export { Tool }
