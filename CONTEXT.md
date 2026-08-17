# Automode

Automode is a distinct Pi experience that orchestrates decision-making and workflow progression separately from the user's normal Pi configuration.

## Language

**Automode**:
The separate Pi experience that coordinates the Matt Pocock workflow through configurable levels of human involvement.
_Avoid_: Auto mode, autonomous Pi

**Automode Bridge**:
The minimal `/automode` entrypoint available in normal Pi that leaves the current Pi experience and starts a fresh Automode process for the repository's durable Automode Run at the Git repository root. It does not expose Automode's mode-specific capabilities to the normal session.
_Avoid_: `pi automode`, in-place mode toggle, Automode runtime

**Automode Capability Profile**:
The explicit allowlist of tools and skills available to an Automode Run. The MVP uses a hard-coded, fail-closed profile rather than inheriting arbitrary capabilities from normal Pi; project-specific additions require an explicit allowlist.
_Avoid_: Global skill discovery, inherited Pi setup, general configuration schema

**Automation Stage**:
One independently configurable part of the repository workflow: Auto-Triage, Auto-Grilling, Auto-Implement, or Auto-Review. Its launch baseline comes from the Automation Stage Configuration, while its live behavior comes from process-local Automation Stage Operating State.
_Avoid_: Sub-mode, workflow phase

**Automation Stage Configuration**:
The Full-Auto or Half-Auto baseline selection confirmed when an Automode Run launches. It is serialized across the Automode Bridge process boundary and restored when a Coordinator process starts; the live process may temporarily override individual Stages through their Automation Stage Operating State.
_Avoid_: Stage profile, Automode Capability Profile, current Stage state

**Automation Stage Operating State**:
The process-local `ON`, `DRAINING`, or `OFF` state of one Automation Stage. `DRAINING` stops new dispatches while active Ticket Sessions settle; `OFF` leaves matching work human-controlled. All four Stages may be `OFF`. Operating State resets to the Automation Stage Configuration when the Coordinator process restarts.
_Avoid_: Sub-mode, persisted Stage configuration, dashboard filter

**Auto-Triage**:
The Automation Stage that discovers and processes tracker items marked `needs-triage`.
_Avoid_: Issue intake mode

**Auto-Grilling**:
The Automation Stage that discovers and resolves open `wayfinder:grilling` decision tickets. It does not chart maps or synthesize specifications.
_Avoid_: Automatic planning

**Auto-Implement**:
The Automation Stage that discovers executable tracker work. It follows a prototype-specific procedure for `wayfinder:prototype` tickets and implements `ready-for-agent` tickets through pull-request creation, stopping before review or merge.
_Avoid_: Auto-Review, background coding

**Auto-Review**:
The Automation Stage that discovers eligible pull requests, reviews them independently of implementation, applies warranted fixes, completes a final roundup, and merges when its review policy is satisfied.
_Avoid_: Implementation review step

**Manual Planning Boundary**:
The human-controlled creation of a Wayfinder map, synthesis with `to-spec`, and approved decomposition with `to-tickets`. Automode may process eligible work these actions create but does not perform these three acts automatically.
_Avoid_: Auto-Plan, planning stage

**Automode Stage Skill**:
An extension-owned customization of a native Matt Pocock skill, loaded only when its Automation Stage is enabled. It retains the canonical identity of its native counterpart; disabled stages use the unchanged native skill.
_Avoid_: Full-Auto Skill Suite, global skill

**Automode Run**:
The durable, repository-scoped operating lifetime of Automode under one baseline Automation Stage Configuration. It spans ordinary Coordinator process restarts. The live process may change Automation Stage Operating State, but restart restores the baseline; run retirement and baseline reconfiguration remain undefined.
_Avoid_: Single-ticket session, disposable process execution, Coordinator process

**Automode Run Record**:
The Coordinator-bound durable record that identifies an Automode Run and stores its baseline Automation Stage Configuration plus explicitly allowlisted project skill files. It does not store process-local Automation Stage Operating State. It lives beside the durable Coordinator identity under the Git common directory, so linked worktrees and different Pi homes recover the same launch baseline.
_Avoid_: Automode Capability Profile, current Stage state, `capability-profile.json`

**Automode Coordinator**:
The repository-singleton orchestrator for an Automode Run. At most one live Coordinator process owns the repository at a time; it discovers and claims eligible work, supervises independent Ticket Sessions without a concurrency limit, and reconstructs active work best-effort after restart from tracker, Git, worktree, and Pi session state. It runs in the Main Session and never performs ticket work itself.
_Avoid_: Ticket worker, subagent

**Main Session**:
The repository-scoped coordinator session that hosts the Automode Coordinator for an Automode Run. Its TUI shows compact run statistics, shutdown guidance, and links to the Automode Dashboard. It supervises work but does not stand in for a stage-specific Ticket Session.
_Avoid_: Grilling Session, Review Session, ticket worker, dashboard

**Automode Dashboard**:
The Coordinator-owned repository dashboard served on fixed localhost port `41738` and optionally exposed inside the user's tailnet. It is the comprehensive graphical supervision surface for Stage Candidates, Ticket Session activity, safe run controls, and process-local Automation Stage Operating State. GitHub and the Coordinator remain authoritative; the dashboard is not a workflow database.
_Avoid_: Main Session, Ticket Session, hosted control plane

**Stage Candidate**:
An open issue or pull request recognized by one Automation Stage, whether or not Automode may dispatch it now. A Stage Candidate may be queued, claimed, running, waiting, retrying, blocked, exhausted, or human-owned. If one item matches several Stages, workflow precedence assigns it to one lane.
_Avoid_: Eligible item, active Ticket Session, every repository issue

**Ticket Session Activity View**:
The read-only Automode Dashboard view of one Ticket Session's live structured events and process-local prior-attempt history. It makes background work inspectable without attaching a second Pi process or importing Ticket Session context into the Main Session.
_Avoid_: Resumed session, shared context, interactive Ticket Session

**Ticket Session**:
One durable logical Pi session that owns one eligible tracker ticket or pull request through its applicable Automode Stage Skill. It normally runs in an independent full background Pi process, persists conversation history through native Pi session storage, and may resume in a replacement process without sharing context with other items. It is not a subagent. A stage-specific Ticket Session keeps its stage-specific name, such as Grilling Session or Review Session.
_Avoid_: Work item, Panel Member, shared worker session

**Grilling Session**:
The authoritative Ticket Session for one Auto-Grilling ticket. It runs the Grilling Rounds, receives advisory Panel Answers, makes the final decisions, and advances that ticket; the Automode Coordinator has no decision-making authority.
_Avoid_: Main Session, Automode Coordinator, Panel Member

**Review Session**:
The authoritative Ticket Session for one pull request processed by Auto-Review. It evaluates review findings, applies warranted fixes, and advances the pull request under the Auto-Review procedure.
_Avoid_: Main Session, Automode Coordinator, Reviewer

**Review Panel**:
The three independent Reviewer seats used by Auto-Review. The seats retain the Deliberation Panel's configured harnesses, models, and reasoning levels but receive review-specific prompts, context, and capabilities.
_Avoid_: Deliberation Panel, Codex Cloud review

**Reviewer**:
One independently executed advisory seat in the Review Panel. A Reviewer examines a pull-request head and reports substantiated findings to the authoritative Review Session but cannot advance or merge the pull request.
_Avoid_: Panel Member, Review Session, voter

**Half-Auto Mode**:
An Automode launch mode whose baseline Automation Stage Configuration enables one to three of the four Automation Stages. The live process may temporarily set any Stage `ON`, `DRAINING`, or `OFF`; the launch mode label does not change.
_Avoid_: Assisted mode, manual mode, current Stage state

**Full-Auto Mode**:
An Automode launch mode whose baseline Automation Stage Configuration enables all four Automation Stages. The live process may temporarily set any Stage `ON`, `DRAINING`, or `OFF`; the launch mode label does not change.
_Avoid_: Unattended mode, headless mode, current Stage state

**Deliberation Panel**:
A configurable set of independent Panel Members that produces candidate answers whenever Auto-Grilling is enabled, without members seeing one another's answers.
_Avoid_: Agent swarm, voting committee

**Panel Member**:
One independently executed advisory subagent seat in the Deliberation Panel. A member receives the same Round Context and complete current Grilling Round as its peers, may explore freely within its controlled advisory capabilities, and has no authority to advance queues, dispatch stages, ask the human, or mutate tracker state.
_Avoid_: Worker, voter, nested orchestrator

**Grilling Round**:
The complete frontier of numbered grilling questions asked together. When Auto-Grilling is enabled, every Panel Member answers the whole round rather than one question at a time.
_Avoid_: Individual question, panel question

**Round Context**:
The identical decision history supplied to every Panel Member: all user prompts, prior Grilling Rounds, and the Grilling Session's final answers from those rounds.
_Avoid_: Raw session state, peer answers

**Panel Answer**:
A Panel Member's advisory response to one complete Grilling Round, covering every question in that round. The Grilling Session may continue when at least one Panel Answer succeeds and fails the round only when every configured member fails.
_Avoid_: Vote, final answer
