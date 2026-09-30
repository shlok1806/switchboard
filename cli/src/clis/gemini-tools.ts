// Gemini CLI's built-in tools, as the Hook Capture and the Proxy Capture read them.

/** Gemini CLI's built-in tools, as the Claude Code tools the Hook Capture knows. */
export const GEMINI_TOOLS: Record<string, { name: string; fields?: Record<string, string> }> = {
  run_shell_command: { name: "Bash" },
  write_file: { name: "Write" },
  replace: { name: "Edit" },
  read_file: { name: "Read", fields: { absolute_path: "file_path" } },
  read_many_files: { name: "Read" },
  glob: { name: "Glob" },
  search_file_content: { name: "Grep" },
  web_fetch: { name: "WebFetch", fields: { prompt: "url" } },
  google_web_search: { name: "WebSearch" },
};
