// Codex's built-in tools, as the Hook Capture and the Proxy Capture read them.

/** Codex's tool names that mean a shell command. */
export const SHELL_TOOLS = new Set(["shell", "local_shell", "exec_command", "container.exec", "unified_exec"]);

/** The command a shell tool call runs. */
export function shellCommand(input: Record<string, unknown>): string | undefined {
  const command = input.command ?? input.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command)) {
    const parts = command.map(String);
    // ["bash", "-lc", "<script>"]: the script is the command.
    if (parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0] ?? "") && parts[1]?.endsWith("c")) return parts[2];
    return parts.join(" ");
  }
  return undefined;
}

/** The files one apply_patch changes, with the lines it adds and removes in each. */
export function patchFiles(patch: string): { path: string; added: string[]; removed: string[]; kind: string }[] {
  const files: { path: string; added: string[]; removed: string[]; kind: string }[] = [];
  let current: (typeof files)[number] | null = null;
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      current = { path: (header[2] ?? "").trim(), added: [], removed: [], kind: header[1] ?? "Update" };
      files.push(current);
      continue;
    }
    if (current === null || line.startsWith("***") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return files;
}
