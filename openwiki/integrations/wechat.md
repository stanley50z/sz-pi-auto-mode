# Integrations: personal WeChat

The README lists a **personal WeChat channel** as a planned capability. The stated goal is to extract only OpenClaw's personal-WeChat channel integration so a Pi session can be accessed through personal WeChat.

## Current state

This is only a planned integration. No implementation files, API contracts, or message flow docs were present in the inspected repository evidence.

## Design implication

Because the goal is to expose a Pi session through a personal chat surface, this integration is likely to need clear boundaries around:

- authentication or account association
- message transport between WeChat and the Pi session
- session routing and identity mapping
- how much of the underlying Pi workflow state is visible through chat

## What future documentation should capture

When implementation starts, this page should be expanded with:

- the adapter boundary and responsibilities
- event/message flow in both directions
- any rate limits, retries, or delivery guarantees
- operational constraints specific to the WeChat channel

## Evidence

- [`README.md`](../../README.md)