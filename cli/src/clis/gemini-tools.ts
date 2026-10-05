// Gemini CLI's built-in tools, as the Hook Capture and the Proxy Capture read them.

/** Gemini CLI's built-in tools, as the Claude Code tools the Hook Capture knows. */
export const GEMINI_TOOLS: Record<string, { name: string; fields?: Record<string, string> }> = {
  // Its working directory is `dir_path` (`directory` in older versions), read as Claude Code's shell `workdir`.
  run_shell_command: { name: "Bash", fields: { dir_path: "workdir", directory: "workdir" } },
  write_file: { name: "Write" },
  replace: { name: "Edit" },
  read_file: { name: "Read", fields: { absolute_path: "file_path" } },
  read_many_files: { name: "Read" },
  glob: { name: "Glob" },
  search_file_content: { name: "Grep" },
  web_fetch: { name: "WebFetch", fields: { prompt: "url" } },
  google_web_search: { name: "WebSearch" },
};
