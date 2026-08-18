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
One independently controllable part of the repository workflow: Auto-Triage, Auto-Grilling, Auto-Implement, or Auto-Review. The launch baseline selects its initial process-local operating state; `ON` Stages are handled automatically, while `DRAINING` and `OFF` Stages accept no new work.
_Avoid_: Sub-mode, workflow phase

**Automation Stage Configuration**:
The durable launch baseline containing the Full-Auto or Half-Auto label and the Automation Stages selected when an Automode Run launches. It is serialized across the Automode Bridge process boundary, stored in the Automode Run Record, and remains fixed for that run. It initializes but does not record the live Coordinator process's Stage controls.
_Avoid_: Live Stage state, Stage profile, Automode Capability Profile

**Automation Stage Operating State**:
The process-local `ON`, `DRAINING`, or `OFF` state for one Automation Stage. `ON` permits discovery and dispatch, `DRAINING` permits active Ticket Sessions to settle without new dispatch, and `OFF` leaves matching work human-controlled. All four may be `OFF` in monitor-only mode. A Coordinator restart discards these live values and restores them from the Automation Stage Configuration baseline.
_Avoid_: Durable Stage configuration, Automode Run Record field

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
An extension-owned customization of a native Matt Pocock skill. Every Stage Skill is loaded and attested at startup so its Stage can be enabled process-locally without changing the capability boundary. It retains the canonical identity of its native counterpart.
_Avoid_: Full-Auto Skill Suite, native fallback, global skill

**Automode Run**:
The durable, repository-scoped operating lifetime of Automode under one fixed Automation Stage Configuration baseline. It spans ordinary Coordinator process restarts, while Automation Stage Operating State belongs only to each live Coordinator process. The MVP defines process stopping and best-effort restart recovery, not run retirement or baseline reconfiguration.
_Avoid_: Single-ticket session, disposable process execution

**Automode Run Record**:
The Coordinator-bound durable record that identifies an Automode Run and stores its fixed Automation Stage Configuration baseline, default Reviewer execution profile, and explicitly allowlisted project skill files. It excludes process-local Automation Stage Operating State. It lives beside the durable Coordinator identity under the Git common directory, so linked worktrees and different Pi homes cannot accept divergent run settings.
_Avoid_: Automation Stage Operating State, Automode Capability Profile, stage profile, `capability-profile.json`

**Automode Coordinator**:
The repository-singleton orchestrator for an Automode Run. At most one live Coordinator process owns the repository at a time; it discovers and claims eligible work, supervises independent Ticket Sessions without a concurrency limit, and reconstructs active work best-effort after restart from tracker, Git, worktree, and Pi session state. It runs in the Main Session and never performs ticket work itself.
_Avoid_: Ticket worker, subagent

**Main Session**:
The repository-scoped coordinator session that hosts the Automode Coordinator for an Automode Run. It supervises work but does not stand in for a stage-specific Ticket Session.
_Avoid_: Grilling Session, Review Session, ticket worker

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
The configured set of independent Reviewer seats used by Auto-Review. It always includes a default Pi Reviewer using the provider and model active when `/automode` launches, plus zero or more additional configured seats. The seats retain the Deliberation Panel's execution profiles but receive review-specific prompts, context, and capabilities.
_Avoid_: Deliberation Panel, Codex Cloud review

**Reviewer**:
One independently executed advisory seat in the Review Panel. A Reviewer examines a pull-request head and reports substantiated findings to the authoritative Review Session but cannot advance or merge the pull request.
_Avoid_: Panel Member, Review Session, voter

**Half-Auto Mode**:
The launch preset whose baseline initially selects Auto-Implement and Auto-Review while leaving Auto-Triage and Auto-Grilling unselected. The user may choose any non-empty selection, including all four Automation Stages. The label and baseline remain fixed even when process-local Stage controls change later.
_Avoid_: Assisted mode, manual mode, proper subset

**Full-Auto Mode**:
The launch preset whose baseline selects all four Automation Stages. A Half-Auto baseline with all four selected initializes the same Stage automation behavior; the label records the user's launch selection rather than a different execution mechanism. Process-local controls do not change the label.
_Avoid_: Unattended mode, headless mode

**Deliberation Panel**:
A configurable set of independent Panel Members that produces candidate answers whenever Auto-Grilling is enabled, without members seeing one another's answers. It always includes the default Pi seat captured from the provider and model active when `/automode` launches, plus zero or more additional configured seats.
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
