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
        <Plus className="size-3.5" /> New Task
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-[12px] border-line bg-surface sm:max-w-md">
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle className="font-display text-[17px]">New Task</DialogTitle>
              <DialogDescription className="text-[12.5px] text-ink-3">
                Creates a GitHub Issue. Title and description then follow GitHub.
              </DialogDescription>
            </DialogHeader>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink">Title</span>
              <input
                name="title"
                autoFocus
                maxLength={MAX_TASK_TITLE_LENGTH}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="h-9 rounded-[6px] border border-line bg-field px-2.5 text-[13px] text-ink outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink">Description</span>
              <textarea
                name="description"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional. Checklist items (- [ ] ...) become Steps."
                className="resize-none rounded-[6px] border border-line bg-field px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
              />
            </label>
            {problem && (
              <p role="alert" className="rounded-[6px] bg-red-tint px-2.5 py-2 text-[12.5px] text-red">
                {problem}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="quiet" size="sm" onClick={() => setOpen(false)}>
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
