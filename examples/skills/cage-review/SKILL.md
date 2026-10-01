---
name: cage-review
description: Review the contracts of a cage project — judge whether the tests really check what each invariant promises — and record the verdict so that `cage check` is clean. Use when `cage check` or the Stop hook reports REVIEW_MISSING, REVIEW_STALE or REVIEW_WEAK, or when asked to review a design.
---

# cage-review

`cage check` sees that a test is *tagged* with an invariant. It cannot see whether the test *checks* it. That is this review: read the design, the code and the tests of a contract together and say, per invariant, whether the tests would catch a broken promise. The verdict is recorded against a fingerprint of the material; `cage check` then requires a fresh one.

## Steps

1. `cage review` prints the material of every contract that needs a review (no verdict yet, or the material changed since). `cage review Name` for one contract; `--format json` for the same with a JSON Schema of the verdict.
2. Read the whole packet before judging: the design (business rules and invariants), the implementations, the test files, the diagnostics, and the list of files that are **not loaded** — open those in the repository; if you cannot, the assessment for what depends on them is `insufficient-context`, not a guess.
3. For every invariant, with the tests tagged `@covers` for it in front of you, answer:
   - Does the test exercise the behaviour the invariant is about, or the right external scenario?
   - Would it fail if exactly this promise were broken, and only then?
   - Do the assertions observe the right result, order or effect — not just "no error was thrown"?
   - Do mocks or stubs stand in for the very guarantee the test claims to check?
   - Are the relevant errors, boundaries, concurrency and retries covered?
   - For a rule about the whole interface: is the interaction of methods checked?
   - Does the implementation do more than the invariant says (an extra condition the tests never touch)?
4. Write the verdict as JSON in the shape the packet ends with: one entry per contract with its `fingerprint` copied from the packet, and one finding per invariant — `assessment` is `adequate`, `weak`, `unrelated` or `insufficient-context`; `reason` says why; `evidence` is `file:line` of the test or code the judgement rests on; `suggestedChange` is what would make it adequate, or null. A contract without invariants gets one finding with `invariant: null`.
5. `cage review --record <file>`. It refuses a verdict for other material (the fingerprint changed: review again), an unknown invariant, or an invariant left unassessed.
6. `cage check`: every finding that is not `adequate` is reported at the invariant. A `weak` or `unrelated` finding is work: fix the test (or the design, if the invariant is unobservable), then review again — the fix changes the material, so the next `cage review` includes it.

## Rules

- You judge as a stranger would, also when you wrote the code or the tests under review. The verdict is recorded and read by others.
- `adequate` needs evidence: name the test and what it asserts. "The test exists" is not evidence.
- Never lower an assessment, remove or soften an invariant, or edit `.cage/review.json` by hand to make the check pass.
- Do not run the project's tests to decide; this is a reading of what the tests would prove, not whether they pass today.
