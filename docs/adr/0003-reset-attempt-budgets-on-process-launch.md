---
status: accepted
---

# Reset attempt budgets on process launch

Each new Automode Coordinator process starts recovered retry, failed, and exhausted work with a fresh five-attempt budget. Recovery still reuses valid Ticket Session history, branches, and worktrees, but an exhausted bookkeeping record cannot make a newly launched Automode process begin in `EXHAUSTED`. This makes process relaunch the explicit operator recovery action while retaining the prior process's diagnostic evidence.
