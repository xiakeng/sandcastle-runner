# Review the implementation

The authoritative review input is this JSON handoff:

{{REVIEW_HANDOFF}}

Work only in the Worktree and delivery branch named by the handoff.   

**DO NOT** try to pull latest code from `main` or `{{PROJECT_TARGET_BRANCH}}`.  


Use the `/code-review` skill to review the works  
If the review reports actionable findings, fix them in the Worktree, commit the fixes, and invoke `/code-review` again. Continue this review-and-fix cycle until the review reports no actionable findings.

Once done, commit only inside the supplied Worktree. Do not push, create or modify a Pull Request, operate CI, merge, or mutate the tracker; those operations belong to the Runner.
