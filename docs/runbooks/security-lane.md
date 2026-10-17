# Runbook: security lane

1. **Intake.** An advisory arrives (OSV, Renovate, a GitHub advisory or a private report). Open a private security advisory or a `type:security` issue.
2. **Patch the dependency.** Assess whether the vulnerable code is reachable. Then:
   - apply a pnpm override;
   - add an exact `minimumReleaseAge` exclusion, logged in the ADR-027 exclusion log with code-owner sign-off.
3. **Rebuild.** Rebuild **every** bundled artefact (the image now; desktop packages from M2), then re-run the gates and E2E.
4. **Release.** Ship a patch release with notes, and publish an advisory if users are affected.

Semantic-correctness bugs, such as a wrong registry cell, follow this lane too.
