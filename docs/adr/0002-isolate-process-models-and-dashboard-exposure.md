---
status: accepted
---

# Isolate process models and dashboard exposure

Each `/automode` process owns its Main Session execution profile and dashboard exposure. The launching Pi provider, model, and reasoning configure that process's Main Session. Each new or resumed Ticket Session captures the Main Session's current execution settings at dispatch, while already-running workers keep their settings. Both Panels keep fixed high-reasoning `openai-codex/gpt-6-astra` and `github-copilot/claude-fable-5` seats and add the captured Main Session execution only when its provider/model matches neither seat. Reasoning differences do not create duplicate seats. Execution profiles remain excluded from the durable Automode Run Record. Dashboards prefer loopback port `41738`, use an operating-system-assigned port when occupied, adopt an exact matching Tailscale handler after a crash, add a separate HTTPS handler alongside unrelated configuration, and remove only their owned root handler on clean shutdown. This replaces the fixed-port and globally exclusive Tailscale rules because Automode processes for different repositories must run concurrently without sharing model choices or deleting one another's routes.
