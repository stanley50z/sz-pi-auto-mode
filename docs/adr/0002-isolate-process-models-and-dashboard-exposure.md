---
status: accepted
---

# Isolate process models and dashboard exposure

Each `/automode` process owns its Main Session execution profile and dashboard exposure. The launching Pi model configures only that process's Main Session; Review Panels use the fixed high-reasoning `openai-codex/gpt-5.6-sol` and `github-copilot/claude-fable-5` seats, and execution profiles are excluded from the durable Automode Run Record. Dashboards prefer loopback port `41738`, use an operating-system-assigned port when occupied, adopt an exact matching Tailscale handler after a crash, add a separate HTTPS handler alongside unrelated configuration, and remove only their owned root handler on clean shutdown. This replaces the fixed-port and globally exclusive Tailscale rules because Automode processes for different repositories must run concurrently without sharing model choices or deleting one another's routes.
