#!/usr/bin/env node
// A stand-in for `gemini` in the end-to-end tests. See fake-agent.mjs.
import { runFake } from "./fake-agent.mjs";

await runFake("gemini");
