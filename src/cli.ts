#!/usr/bin/env node
import { runCli } from "./main.ts";

process.exitCode = runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
