# Contract harness

This project keeps its designs in `.design/design.mdx` files, checked by `design check`. Before you stop, `design check` must pass with no review findings; the Stop hook `.claude/hooks/design-gate.mjs` enforces it and feeds the report back to you.

- A change to a contract, an implementation or a linked test makes that contract's review stale. Then: `design review` prints the material of every contract in need of a review, with the reviewer's instruction and the verdict format at the end. Read it, judge each invariant as a stranger would, write the verdict as JSON to a file, and run `design review --record <file>`.
- Never lower an assessment to make the check pass, and never remove or soften an invariant for that reason. A `weak` finding is work: fix the test, then review again.
- Locks: a contract or data type marked `@final` or `@extendable` must not change as the lock says. Do not edit `.design/design.lock.json` by hand.
