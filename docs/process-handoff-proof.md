# Isolated Pi process-handoff proof

The `prove:handoff` fixture proves the launch seam required before the Automode Coordinator performs tracker work. That fixture intentionally performs no GitHub access, issue discovery, claim, or mutation; production startup validation is documented separately in `docs/automode-launch.md`.

Run on the pinned Node baseline (`22.19.0` in `.node-version`; `package.json` accepts compatible newer releases). Development pins a Pi SDK only for compilation and tests; `/automode` binds the child to the same Pi package installation that launched the Bridge:

```sh
npm ci
npm test
npm run prove:handoff
```

`prove:handoff` starts a fresh Node/Pi process in the caller's working directory with inherited terminal streams. The production Bridge passes the launching Pi package directory across that boundary and preloads a fail-closed resolver so the Main Session and descendant Ticket Session processes load Pi core, AI, TUI, and shared schema imports from that exact installation rather than this package's development dependencies. On POSIX, the Automode process receives a separate process group so terminal-generated signals reach the waiting bridge once and are forwarded once. Windows retains the inherited console: normal Pi pauses its stdin reader before spawn so only Automode consumes keystrokes; console `Ctrl-C` already reaches both processes and is therefore not re-forwarded, while non-console termination requests use an IPC control channel so cleanup can run instead of calling Windows' forceful `child.kill()`. The bridge exits with the Automode process's status and cannot resume normal Pi.

The Automode process composes Pi through public SDK APIs:

- `ModelRuntime` reads stored credentials from normal Pi's effective credential root (`PI_CODING_AGENT_DIR` when configured, otherwise `~/.pi/agent`); provider credential environment variables remain available as normal credential sources. The effective credential root is passed explicitly, then normal Pi process configuration, session metadata, and `NODE_OPTIONS` are stripped before launch. Transport proxy variables remain available for provider and GitHub connectivity. Mutable model configuration is disabled; Automode resolves its hard-coded execution profiles only from Pi's built-in catalogue plus the reused credential store.
- `SettingsManager`, `DefaultResourceLoader`, the controlled system prompt, and persistent `SessionManager` use a canonical Git-root-keyed `~/.pi/automode/<key>/` root. Launching from a repository subdirectory therefore resumes the same repository storage. Repository `.pi/settings.json` is not loaded.
- ambient extensions, prompt templates, appended prompts, themes, skills, and default tools are disabled in the proof; it loads only its two explicit package-owned proof skills plus the controlled synchronized `/fast` extension. Production project-skill allowlisting is outside this fixture and covered by `docs/automode-launch.md`. Repository `AGENTS.md` or `CLAUDE.md` guidance remains available, while context files above the repository and normal-Pi context files stay excluded.
- `extensionsResult.runtime.getCommands()` is the public command registry used for identity and provenance attestation. Public resource diagnostics are checked too because Pi deduplicates skill-name collisions before exposing the registry. Each required command must be collision-free, report `source: "skill"`, and resolve beneath its package-owned canonical skill root.
- both canonical proof skills are invoked through Pi's native `/skill:<name>` expansion path against a deterministic local proof provider. This performs no network or external model request.

The automated process proof runs through a real pseudoterminal and verifies that the bridge and Automode process have distinct process identities, terminal input reaches the Automode process, termination reaches it, control cannot resume after handoff, normal stored and environment credentials remain visible without exposing their values, normal Pi process configuration stays absent, repository guidance loads without parent-directory context, repository skills cannot replace canonical package skills, ambient resources and appended prompts stay absent, Automode settings win over repository settings, and the session persists outside normal Pi's session root.

## Public-API constraint for launch work

The `/automode` extension must treat handoff as terminal: after the fresh Automode process receives inherited stdio, normal Pi may only forward termination and exit with the Automode process's status. It must not implement an in-process mode toggle, resume the original interactive loop, substitute private Pi internals for the SDK composition above, or broaden resource discovery.

Command attestation must preserve both public checks used here: the command registry proves the winning command's source metadata, while resource diagnostics reveal duplicate skills hidden by registry deduplication. Dropping either check would make launch fail open.
