# Implement Delivery Ticket {{TICKET_NUMBER}}

Work only in the supplied Worktree `{{WORKTREE_PATH}}` on delivery branch `{{SOURCE_BRANCH}}`, based on `{{BASE_SHA}}` for Project Target Branch `{{PROJECT_TARGET_BRANCH}}`. The authoritative ticket is `{{TICKET_REFERENCE}}`.

**DO NOT** try to pull latest code from `main` or `{{PROJECT_TARGET_BRANCH}}`.  

Implement the work described above.  
Use `/tdd` skill where possible, at pre-agreed seams.  
Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, commit only inside the supplied Worktree. Do not push, create or modify a Pull Request, operate CI, merge, or mutate the tracker; those operations belong to the Runner.
