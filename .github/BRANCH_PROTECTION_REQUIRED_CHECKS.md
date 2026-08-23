# Required checks for stable promotion

The protected default and release branches must require the `strict-local-gates` check from `.github/workflows/ci.yml`. Promotion of a release commit additionally requires a manually dispatched, protected-environment `protected-real-provider-smoke` run on that exact commit.

Repository configuration is external state. Until an administrator enables these required checks and a run on the implementation commit passes, `current/release-status.json` must remain candidate and `controlledUseAllowed` must remain false.
