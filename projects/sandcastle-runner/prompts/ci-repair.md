# Repair required checks for Pull Request {{PULL_REQUEST_NUMBER}}

Work only in the supplied Worktree `{{WORKTREE_PATH}}` on delivery branch `{{SOURCE_BRANCH}}`, based on `{{BASE_SHA}}` for Project Target Branch `{{PROJECT_TARGET_BRANCH}}`. The authoritative ticket is `{{TICKET_REFERENCE}}` (Delivery Ticket {{TICKET_NUMBER}}), and the existing Pull Request is {{PULL_REQUEST_URL}}.

Failed required checks:

{{FAILED_CHECKS}}

**DO NOT** try to pull latest code from `main` or `{{PROJECT_TARGET_BRANCH}}`.  

Diagnose the failures and make the smallest accepted repair.  
