#!/usr/bin/env node
import fs from "node:fs";
import tty from "node:tty";
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

/**
 * Questions for a person at the terminal: only when both stdin and stderr
 * are one. Lines are read synchronously from fd 0, which stays blocking
 * because `process.stdin` is not opened; Ctrl-C ends the process as usual.
 */
function terminalQuestions(): ((question: string) => string | null) | undefined {
  if (!tty.isatty(0) || !tty.isatty(2)) return undefined;
  let pending = Buffer.alloc(0);
  let ended = false;
  return (question) => {
    process.stderr.write(question);
    for (;;) {
      const newline = pending.indexOf(10);
      if (newline >= 0) {
        const line = pending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
        pending = pending.subarray(newline + 1);
        return line;
      }
      if (ended) {
        // Ctrl-D after some text ends that text; on an empty line it ends the input.
        const rest = pending.length === 0 ? null : pending.toString("utf8");
        pending = Buffer.alloc(0);
        if (rest === null) process.stderr.write("\n");
        return rest;
      }
      const chunk = Buffer.alloc(1024);
      let read: number;
      try {
        read = fs.readSync(0, chunk, 0, chunk.length, null);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "EAGAIN") {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          continue;
        }
        if (code !== "EOF") throw cause;
        read = 0;
      }
      if (read === 0) ended = true;
      else pending = Buffer.concat([pending, chunk.subarray(0, read)]);
    }
  };
}

process.exitCode = runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdin: process.argv[2] === "gate" ? readStdin() : undefined,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  ask: process.argv[2] === "init" ? terminalQuestions() : undefined,
});
