import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";

// Separate processes, alternating order, and exact output equality. This runs
// read-only checks; it neither executes project tests nor changes review records.
const { values } = parseArgs({ options: {
  baseline: { type: "string" }, candidate: { type: "string", default: "dist/cli.js" },
  root: { type: "string", default: "." }, samples: { type: "string", default: "3" },
} });
const samples = Number(values.samples);
assert.ok(values.baseline, "usage: node scripts/benchmark.mjs --baseline /path/to/old/dist/cli.js --root /path/to/project [--samples 3]");
assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 20, "samples must be an integer from 1 to 20");
const root = path.resolve(values.root);
const paths = { baseline: path.resolve(values.baseline), candidate: path.resolve(values.candidate) };
const measurements = { baseline: [], candidate: [] };
let reference;
for (let sample = 0; sample < samples; sample++) {
  for (const name of sample % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
    const start = performance.now();
    const run = spawnSync(process.execPath, [paths[name], "check", "--root", root, "--format", "json", "--max-diagnostics", "all"], {
      input: "", encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
    });
    const seconds = (performance.now() - start) / 1000;
    if (run.error) throw run.error;
    assert.equal(run.signal, null, `${name} terminated by ${run.signal}`);
    assert.ok(run.status === 0 || run.status === 1, `${name}: ${run.stderr || run.stdout}`);
    JSON.parse(run.stdout); // An empty or non-report output is never a speedup.
    const current = { status: run.status, stdout: run.stdout, stderr: run.stderr };
    if (reference) assert.deepEqual(current, reference, `${name}: output changed; do not report a speedup for different checks`);
    else reference = current;
    measurements[name].push(seconds);
    process.stderr.write(`${name} ${sample + 1}/${samples}: ${seconds.toFixed(3)} s\n`);
  }
}
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const baseline = median(measurements.baseline), candidate = median(measurements.candidate);
console.log(JSON.stringify({
  node: process.version, root, samples, seconds: measurements,
  median: { baseline, candidate }, speedup: baseline / candidate,
  reductionPercent: 100 * (1 - candidate / baseline),
  identicalOutput: true, exitCode: reference.status,
  outputSha256: createHash("sha256").update(reference.stdout).digest("hex"),
}, null, 2));
