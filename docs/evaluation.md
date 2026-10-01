# How Cage was evaluated

Two questions, two experiments:

1. **Review and drift.** When a change has slipped defects past the tests, does Cage help a reviewing agent find them?
2. **Implementing changes.** When an agent implements a ticket, does Cage make the result more correct, or its tests stronger?

Both ran in October 2026 against cage-ts 0.2.0.

## Subject

One module of a production TypeScript service: NestJS, Drizzle ORM, PostgreSQL, Vitest. The module mirrors organizations and memberships from an identity provider through signed webhooks and is used by an authentication guard and two other modules. Its design was written by an agent with the `cage-design` skill from the existing code: three contracts, nineteen rules (invariants), each linked to unit or e2e tests. The service's code is private; the cases are not published.

## Tools

| Tool | Used for |
| --- | --- |
| [`claude plugin eval`](https://code.claude.com/docs/en/plugin-evals.md) (Claude Code) | Runs every case in a fresh, isolated, non-interactive session, once with the Cage plugin loaded and once without it (`--ablation with-without`); builds each workspace with a scaffold script; records traces, turns and cost. A variant without any design ran the same cases under an empty plugin. |
| Claude Sonnet 5.5 | The agent under test in every session. |
| Claude Sonnet 5.5 as judge | Decides whether a review reports a given defect: one question per defect, three votes, majority. |
| Vitest + PostgreSQL 16 (Docker) | Hidden behavioural tests: e2e specs written for each ticket, run against a real database after the session, on the kept workspace. Each was checked to fail on the unchanged code and to pass on a reference fix. |
| [Stryker Mutator](https://stryker-mutator.io/) 10, Vitest runner | Mutation score of the code the agent changed: only the production lines the agent added or changed are mutated, and the tests run are the module's unit and e2e specs plus every spec file the agent touched, against the real database. |
| `cage check` | As a detector of its own, with no model. |

Two limits of the runner shaped the method. It has no graders that run code, so the hidden tests and Stryker ran after the eval, outside the agent's sandbox. And the agent's sandbox cannot reach a database, so in every variant the agent could run unit tests but not e2e tests; the prompts said so.

## Experiment 1: review and drift

**Seeded defects.** Eight defects that keep every test green, in four variants of two defects each, plus a clean copy with no defect. Each variant is committed as one commit, “accounts: tidy webhook handling and tests”, on top of the module, together with the same harmless edits (a log message, a comment, a test renamed):

| Kind | Defect |
| --- | --- |
| Bug hidden by a weak test | An organization update no longer writes its image. |
| Bug hidden by a weak test | Soft delete lost its `where`: deleting one organization marks every account deleted. |
| Crooked test | “404, nothing written” no longer checks that nothing was written. |
| Crooked test | “returns the row when found” asserts only `toBeDefined()`, which `null` passes. |
| Crooked test | The update test no longer checks the updated name. |
| Disabled test | The webhook-signature test is skipped. |
| Code drifted from the design | Removing a membership that is not there throws, where the design promises a repeated delete is harmless; the unit test follows the code. |
| Design drifted from the code | The design promises a soft delete of memberships; the code and its test hard-delete. |

**Variants.** With Cage (plugin and design); the design in the repository but no Cage; no design (the design document, its tags and the configuration removed). Two runs per variant and per defect set.

**Prompt**, the same everywhere: the last commit was made by another agent; review the module as it is now — do the tests check what they claim, does the code still do what it should, for the module and for the code that relies on it; do not change code or tests; end with a list of findings.

**Grading.** For each run and each seeded defect, a judge reads everything the reviewer wrote and answers whether it reports that defect. On the clean copy the same eight questions measure false alarms. The runner's built-in judge reads only the final message; with Cage the Stop hook asked the reviewers to record a verdict, several declined (they had been asked to change nothing), and their findings ended up in an earlier message. All runs were therefore judged on all their messages, with one rubric for every variant.

**Results.**

| | With Cage | Design, no Cage | No design |
| --- | --- | --- | --- |
| Seeded defects found | **100%** | 88% | 79% |
| Bugs hidden by weak tests | 100% | 100% | 100% |
| Crooked or disabled tests | 100% | 75% | 63% |
| Drift between design and code | 100% | 100% | 100% of what is detectable without a design |
| False alarms on the clean copy | 0% | 0% | 0% |
| Cost of a review | +39% | baseline | −16% |
| Time of a review | +39% | baseline | −5% |

The difference is one defect: the update test that stopped checking the name was found in 100% of the reviews with Cage and in none of the others. `cage check` had reported `test "organization.updated — updates, no duplicate" … changed` as a stale review, and the reviewer went to that test.

`cage check` alone, with no model, pointed at the changed test or implementation of every seeded defect, and at the contract whose design changed. It cannot tell a defect from a harmless edit: on the clean copy it reported the changed parts too.

## Experiment 2: implementing changes

**Tickets.** Three, each with a trap:

- Requests in an organization deleted at the identity provider must be refused. The obvious fix — hide deleted organizations from the lookup — makes the authentication guard re-create the organization from the provider, which the design's rules and its list of callers show.
- A membership deleted at the provider must not come back through a late or repeated event, while re-inviting the user with a new membership must work.
- Membership events for a deleted organization must be acknowledged without effect, while events for one not mirrored yet must still be refused so that the provider redelivers them.

**Variants.** The same three as above. Three runs per variant and ticket.

**Grading.** The hidden behavioural tests of the ticket; the module's own tests and the typecheck as the agent left them; the mutation score of the changed code; cost and time from the runner.

**Results.**

| | With Cage | Design, no Cage | No design |
| --- | --- | --- | --- |
| Runs that passed every hidden test | 89% | 100% | 100% |
| Hidden tests passed | 97% | 100% | 100% |
| Module tests and typecheck green afterwards | 100% | 100% | 100% |
| Mutation score of the changed code | 66% | 66% | 48% |
| Cost of a task | +35% | baseline | −35% |
| Time of a task | +31% | baseline | −10% |
| Runs where the Stop hook returned work | 0% | — | — |

Every variant avoided the guard trap. With Cage the agents kept to its rules on their own — a review was recorded wherever a contract's material had changed — so the Stop hook never had to send anything back. A pilot with three easier tickets, one run per variant, gave the same picture: every hidden test passed in both variants, at +58% cost with Cage.

## Reading the numbers

- Cage pays off in review: every seeded defect found, and the one that only Cage found was found because a stale review named the test that had changed.
- On a single implementation task a strong model does not get more correct with Cage, and costs about a third more.
- The design document in the repository goes with stronger tests (mutation score 66% against 48%), with or without the plugin.

## Limits

- One module, one model, two or three runs per variant: the differences are signals, not significant results.
- The defects and tickets were written by the same people who built Cage, and the judges are models.
- Agents could not run e2e tests in their sandbox; in practice they usually can.
- Implementation tasks were single sessions on a clean repository; drift that builds up over many sessions was not measured.
