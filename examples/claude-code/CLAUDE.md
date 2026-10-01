# Contract harness

This project keeps its designs in `*.cage.mdx` files, checked by `cage check`. Before you stop, `cage check` must pass with no review findings; the Stop hook (`cage gate`) enforces it and feeds the report back to you.

- A change to a contract, an implementation or a linked test makes that contract's review stale. Then: `cage review` prints the material of every contract in need of a review, with the reviewer's instruction and the verdict format at the end. Read it, judge each invariant as a stranger would, write the verdict as JSON to a file, and run `cage review --record <file>`.
- Never lower an assessment to make the check pass, and never remove or soften an invariant for that reason. A `weak` finding is work: fix the test, then review again.
- Locks: a contract or data type marked `@final` or `@extendable` must not change as the lock says. Do not edit `.cage/lock.json` by hand.
- Exported code of a designed module that nothing marks `@implements` is reported (`NOT_DESIGNED`): describe its contract in the design, or list the file in the module's `.cageignore` when it needs no design. Whether this blocks you is the project's `"coverage"` setting.
