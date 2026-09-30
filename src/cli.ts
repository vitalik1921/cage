#!/usr/bin/env node
import fs from "node:fs";
import { runCli } from "./main.ts";

/** The hook's input, when something is piped in. */
function readStdin(): string | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return undefined;
  }
}

process.exitCode = runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdin: process.argv[2] === "gate" ? readStdin() : undefined,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
