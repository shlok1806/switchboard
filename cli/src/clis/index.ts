// The agent CLIs `switchboard run` knows, by the name the Person types.

import type { CliAdapter } from "./adapter";
import { claude } from "./claude";
import { codex } from "./codex";
import { gemini } from "./gemini";

export const ADAPTERS: Record<string, CliAdapter> = { claude, codex, gemini };
