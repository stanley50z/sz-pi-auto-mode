import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  AUTOMATION_STAGE_LABELS,
  AUTOMATION_STAGES,
  AUTOMODE_MODE_LABELS,
  createAutomationStageConfiguration,
  HALF_AUTO_SELECTION_REQUIREMENT,
  isValidHalfAutoSelection,
  type AutomationStage,
  type AutomodeMode,
  type AutomationStageConfiguration,
} from "./stage-configuration.js";

export interface SelectorTheme {
  accent(text: string): string;
  selected(text: string): string;
  text(text: string): string;
  muted(text: string): string;
  dim(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  bold(text: string): string;
}

export interface AutomodeSelector {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

export interface AutomodeSelectorOptions {
  theme: SelectorTheme;
  onChange(): void;
  onDone(result: AutomationStageConfiguration | null): void;
}

function addWrapped(lines: string[], prefix: string, text: string, width: number): void {
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= width) {
    lines.push(truncateToWidth(`${prefix}${text}`, width, ""));
    return;
  }
  const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
  const continuation = " ".repeat(prefixWidth);
  wrapped.forEach((line, index) => lines.push(`${index === 0 ? prefix : continuation}${line}`));
}

export function createAutomodeSelector(options: AutomodeSelectorOptions): AutomodeSelector {
  let mode: AutomodeMode = "full";
  let focus = 0;
  const enabled = new Set<AutomationStage>(AUTOMATION_STAGES);
  let validationMessage: string | undefined;
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;

  function invalidateCache(): void {
    cachedWidth = undefined;
    cachedLines = undefined;
  }

  function refreshAfterInteraction(): void {
    invalidateCache();
    validationMessage = undefined;
    options.onChange();
  }

  function handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      options.onDone(null);
      return;
    }
    if (matchesKey(data, Key.tab)) {
      mode = mode === "full" ? "half" : "full";
      refreshAfterInteraction();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
      focus = (focus - 1 + AUTOMATION_STAGES.length) % AUTOMATION_STAGES.length;
      refreshAfterInteraction();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
      focus = (focus + 1) % AUTOMATION_STAGES.length;
      refreshAfterInteraction();
      return;
    }
    if (matchesKey(data, Key.space)) {
      if (mode === "half") {
        const stage = AUTOMATION_STAGES[focus]!;
        if (enabled.has(stage)) enabled.delete(stage);
        else enabled.add(stage);
        refreshAfterInteraction();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (mode === "half" && !isValidHalfAutoSelection(enabled)) {
        validationMessage = HALF_AUTO_SELECTION_REQUIREMENT;
        invalidateCache();
        options.onChange();
        return;
      }
      options.onDone(createAutomationStageConfiguration(mode, mode === "full" ? AUTOMATION_STAGES : [...enabled]));
    }
  }

  function render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    if (cachedLines && cachedWidth === renderWidth) return cachedLines;
    const lines: string[] = [];
    const border = options.theme.accent("─".repeat(renderWidth));
    lines.push(border);
    addWrapped(lines, " ", options.theme.accent(options.theme.bold("Launch Automode")), renderWidth);
    lines.push("");

    const full = mode === "full"
      ? options.theme.selected(AUTOMODE_MODE_LABELS.full)
      : options.theme.muted(AUTOMODE_MODE_LABELS.full);
    const half = mode === "half"
      ? options.theme.selected(AUTOMODE_MODE_LABELS.half)
      : options.theme.muted(AUTOMODE_MODE_LABELS.half);
    addWrapped(lines, " ", `${full}  ${half}`, renderWidth);
    lines.push("");

    AUTOMATION_STAGES.forEach((stage, index) => {
      const focused = index === focus;
      const active = mode === "full" || enabled.has(stage);
      const prefix = focused ? options.theme.accent("> ") : "  ";
      const state = active ? options.theme.success("enabled") : options.theme.dim("disabled");
      const label = focused
        ? options.theme.accent(AUTOMATION_STAGE_LABELS[stage])
        : options.theme.text(AUTOMATION_STAGE_LABELS[stage]);
      addWrapped(lines, prefix, `${active ? "●" : "○"} ${label} — ${state}`, renderWidth);
    });

    lines.push("");
    const status = mode === "full"
      ? options.theme.success("Full-Auto: all four stages enabled.")
      : isValidHalfAutoSelection(enabled)
        ? options.theme.success(`Half-Auto: ${enabled.size} stage${enabled.size === 1 ? "" : "s"} enabled.`)
        : options.theme.warning(HALF_AUTO_SELECTION_REQUIREMENT);
    addWrapped(lines, " ", validationMessage ? options.theme.warning(validationMessage) : status, renderWidth);
    lines.push("");
    addWrapped(lines, " ", options.theme.dim("Tab mode • ↑↓←→ focus • Space toggle • Enter launch • Esc cancel"), renderWidth);
    lines.push(border);

    cachedWidth = renderWidth;
    cachedLines = lines;
    return cachedLines;
  }

  return {
    render,
    handleInput,
    invalidate: invalidateCache,
  };
}
