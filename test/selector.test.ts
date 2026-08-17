import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createAutomodeSelector, type SelectorTheme } from "../src/selector.js";

const plainTheme: SelectorTheme = {
  accent: (text) => text,
  selected: (text) => `[${text}]`,
  text: (text) => text,
  muted: (text) => text,
  dim: (text) => text,
  success: (text) => text,
  warning: (text) => text,
  bold: (text) => text,
};

function selector() {
  let result: unknown;
  let renders = 0;
  return {
    component: createAutomodeSelector({
      theme: plainTheme,
      onChange: () => { renders += 1; },
      onDone: (value) => { result = value; },
    }),
    result: () => result,
    renders: () => renders,
  };
}

test("selector starts in focused Full-Auto with all stages visible", () => {
  const view = selector();
  const output = view.component.render(40).join("\n");

  assert.match(output, /\[Full-Auto\]/);
  assert.match(output, /> .*Auto-Triage/);
  assert.match(output, /Auto-Grilling/);
  assert.match(output, /Auto-Implement/);
  assert.match(output, /Auto-Review/);
  assert.match(output, /all four stages enabled/i);
});

test("Half-Auto defaults to Auto-Implement and Auto-Review only", () => {
  const view = selector();
  view.component.handleInput("\t");
  const output = view.component.render(80).join("\n");

  assert.match(output, /Auto-Triage.*disabled/);
  assert.match(output, /Auto-Grilling.*disabled/);
  assert.match(output, /Auto-Implement.*enabled/);
  assert.match(output, /Auto-Review.*enabled/);

  view.component.handleInput("\r");
  assert.deepEqual(view.result(), {
    mode: "half",
    stages: ["auto-implement", "auto-review"],
  });
});

test("Tab changes mode, arrows move focus, and Space only toggles Half-Auto stages", () => {
  const view = selector();
  view.component.handleInput(" ");
  assert.match(view.component.render(80).join("\n"), /all four stages enabled/i);

  view.component.handleInput("\t");
  view.component.handleInput("\x1b[B");
  view.component.handleInput(" ");
  const output = view.component.render(80).join("\n");

  assert.match(output, /\[Half-Auto\]/);
  assert.match(output, /> .*Auto-Grilling/);
  assert.match(output, /Auto-Grilling.*enabled/);
  assert.ok(view.renders() >= 3);
});

test("Half-Auto launches with all four stages and visibly rejects an empty selection", () => {
  const allFour = selector();
  allFour.component.handleInput("\t");
  allFour.component.handleInput(" ");
  allFour.component.handleInput("\x1b[B");
  allFour.component.handleInput(" ");
  allFour.component.handleInput("\r");
  assert.deepEqual(allFour.result(), {
    mode: "half",
    stages: ["auto-triage", "auto-grilling", "auto-implement", "auto-review"],
  });

  const invalidZero = selector();
  invalidZero.component.handleInput("\t");
  invalidZero.component.handleInput("\x1b[B");
  invalidZero.component.handleInput("\x1b[B");
  invalidZero.component.handleInput(" ");
  invalidZero.component.handleInput("\x1b[B");
  invalidZero.component.handleInput(" ");
  invalidZero.component.handleInput("\r");
  assert.equal(invalidZero.result(), undefined);
  assert.match(invalidZero.component.render(80).join("\n"), /requires at least one/i);
});

test("Escape cancels and minimum-size rendering keeps every label and control readable", () => {
  const view = selector();
  view.component.handleInput("\x1b");
  assert.equal(view.result(), null);

  const minimumTerminal = { columns: 32, rows: 20, piReservedRows: 2 };
  const lines = view.component.render(minimumTerminal.columns);
  const readableText = lines.join(" ").replace(/\s+/g, " ");
  assert.ok(lines.length <= minimumTerminal.rows - minimumTerminal.piReservedRows);
  for (const line of lines) assert.ok(visibleWidth(line) <= minimumTerminal.columns, line);
  for (const requiredText of [
    "Full-Auto",
    "Half-Auto",
    "Auto-Triage",
    "Auto-Grilling",
    "Auto-Implement",
    "Auto-Review",
    "Tab mode",
    "↑↓←→ focus",
    "Space toggle",
    "Enter launch",
    "Esc cancel",
  ]) {
    assert.match(readableText, new RegExp(requiredText));
  }

  const invalid = selector();
  invalid.component.handleInput("\t");
  invalid.component.handleInput("\x1b[B");
  invalid.component.handleInput("\x1b[B");
  invalid.component.handleInput(" ");
  invalid.component.handleInput("\x1b[B");
  invalid.component.handleInput(" ");
  invalid.component.handleInput("\r");
  const invalidLines = invalid.component.render(minimumTerminal.columns);
  assert.ok(invalidLines.length <= minimumTerminal.rows - minimumTerminal.piReservedRows);
  for (const line of invalidLines) assert.ok(visibleWidth(line) <= minimumTerminal.columns, line);
  assert.match(invalidLines.join(" ").replace(/\s+/g, " "), /Half-Auto requires at least one Automation Stage/);
});
