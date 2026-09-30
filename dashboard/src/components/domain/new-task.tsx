import { useState, type FormEvent } from "react";
import { Plus } from "@/components/pixel-icon";
import { toast } from "sonner";
import { MAX_TASK_TITLE_LENGTH } from "@shared/index";
import { Button } from "@/components/atoms/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useStore } from "@/data/store";
import { go } from "@/lib/router";

/** Create a Task from the Dashboard. The Channel creates the GitHub Issue first (ADR 0001). */
export function NewTaskButton() {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  if (!store.source.capabilities.createTask) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setProblem("A Task needs a title.");
    setBusy(true);
    const result = await store.source.createTask({ title: title.trim(), description: description.trim() || undefined });
    setBusy(false);
    if (!result.ok) return setProblem(result.reason);
    toast.success(`Created #${result.task.number} and its GitHub Issue`);
    setOpen(false);
    setTitle("");
    setDescription("");
    setProblem(undefined);
    go({ view: "task", number: result.task.number });
  };

  return (
    <>
      <Button variant="accent" size="sm" onClick={() => setOpen(true)} className="gap-1">
        <Plus /> New Task
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>New Task</DialogTitle>
              <DialogDescription>
                Creates a GitHub Issue. Title and description then follow GitHub.
              </DialogDescription>
            </DialogHeader>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold">Title</span>
              <input
                name="title"
                autoFocus
                maxLength={MAX_TASK_TITLE_LENGTH}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="bevel-in h-8 bg-card px-2 text-[13px] text-card-foreground outline-none focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] coarse:h-11 coarse:text-[16px]"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold">Description</span>
              <textarea
                name="description"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional. Checklist items (- [ ] ...) become Steps."
                className="bevel-in resize-none bg-card px-2 py-1.5 font-mono text-[12.5px] text-card-foreground outline-none placeholder:text-faint focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] coarse:text-[16px]"
              />
            </label>
            {problem && (
              <p role="alert" className="text-[12.5px] font-semibold text-red">
                {problem}
              </p>
            )}
            <DialogFooter>
              <Button type="button" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="accent" size="sm" disabled={busy}>
                {busy ? "Creating" : "Create Task"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
