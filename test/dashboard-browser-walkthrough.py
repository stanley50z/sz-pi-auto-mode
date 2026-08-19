"""Run with browser-harness; this is live-browser proof, not a DOM test."""

import json
import os
import queue
import socket
import struct
import subprocess
import tempfile
import threading
import time
from pathlib import Path


PROJECT_ROOT = Path.cwd()
VISUAL_PROOF_MAIN = PROJECT_ROOT / "dist" / "test" / "dashboard-browser-proof-main.js"
BLACK_BOX_PROOF_MAIN = PROJECT_ROOT / "dist" / "test" / "dashboard-browser-black-box-main.js"
VIEWPORTS = ((1440, 900), (1024, 768), (390, 844))
artifact_dir = Path(os.environ.get(
    "AUTOMODE_DASHBOARD_ARTIFACT_DIR",
    tempfile.mkdtemp(prefix="automode-dashboard-browser-proof-"),
))
artifact_dir.mkdir(parents=True, exist_ok=True)


class ProofProcess:
    def __init__(self, entrypoint):
        self.entrypoint = Path(entrypoint)
        self.lines = []
        self.line_queue = queue.Queue()
        self.process = subprocess.Popen(
            [os.environ.get("NODE_BINARY", "node"), str(self.entrypoint)],
            cwd=PROJECT_ROOT,
            env=os.environ.copy(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self.reader = threading.Thread(target=self._read_output, daemon=True)
        self.reader.start()

    def _read_output(self):
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.lines.append(line)
            self.line_queue.put(line)

    def output(self):
        return "".join(self.lines)

    def wait_for_json(self, marker, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                line = self.line_queue.get(timeout=min(0.1, max(0.01, deadline - time.time())))
            except queue.Empty:
                if self.process.poll() is not None:
                    break
                continue
            if line.startswith(marker + " "):
                return json.loads(line[len(marker) + 1:])
        raise AssertionError(
            f"{self.entrypoint.name} did not emit {marker!r}; "
            f"exit={self.process.poll()} output={self.output()!r}"
        )

    def wait(self, timeout):
        try:
            exit_code = self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise AssertionError(
                f"{self.entrypoint.name} did not exit within {timeout}s; output={self.output()!r}"
            ) from error
        self.reader.join(timeout=2.0)
        return exit_code

    def stop(self):
        if self.process.poll() is not None:
            self.reader.join(timeout=2.0)
            return
        try:
            assert self.process.stdin is not None
            self.process.stdin.write("STOP\n")
            self.process.stdin.flush()
            self.process.wait(timeout=10.0)
        except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
            self.process.terminate()
            try:
                self.process.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5.0)
        finally:
            self.reader.join(timeout=2.0)


def wait_until(predicate, description, timeout=10.0):
    deadline = time.time() + timeout
    last_value = None
    while time.time() < deadline:
        last_value = predicate()
        if last_value:
            return last_value
        wait(0.1)
    raise AssertionError(f"Timed out waiting for {description}; last value: {last_value!r}")


def port_is_open():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.settimeout(0.2)
        return connection.connect_ex(("127.0.0.1", 41738)) == 0


def wait_for_port_closed(timeout=10.0):
    wait_until(lambda: not port_is_open(), "port 41738 to close", timeout=timeout)


def body_text():
    return js("document.body.innerText")


def accessible_nodes():
    return cdp("Accessibility.getFullAXTree")["nodes"]


def has_accessible(role, name_fragment):
    for node in accessible_nodes():
        role_value = node.get("role", {}).get("value")
        name = node.get("name", {}).get("value", "")
        if role_value == role and name_fragment in name:
            return True
    return False


def has_enabled_button(name_fragment):
    return js("""(() => [...document.querySelectorAll('button')].some((button) =>
      (button.getAttribute('aria-label') || button.innerText || '').includes(%s) && !button.disabled
    ))()""" % json.dumps(name_fragment))


def active_control():
    return js("""(() => {
      const element = document.activeElement;
      return {
        name: (element?.getAttribute?.("aria-label") || element?.innerText || element?.textContent || "").trim(),
        tag: element?.tagName || "",
        disabled: Boolean(element?.disabled)
      };
    })()""")


def tab_to(name_fragment, limit=24):
    js("document.querySelector('.skip-link').focus()")
    visited = []
    for _ in range(limit):
        current = active_control()
        visited.append(current)
        if current["tag"] in ("A", "BUTTON") and name_fragment in current["name"]:
            return current
        press_key("Tab")
        wait(0.04)
    raise AssertionError(f"Tab order never reached {name_fragment!r}: {visited!r}")


def set_exact_viewport(width, height):
    emulated_width = width
    emulated_height = height
    device_scale_factor = 1
    metrics = None
    for _ in range(3):
        cdp(
            "Emulation.setDeviceMetricsOverride",
            width=emulated_width,
            height=emulated_height,
            deviceScaleFactor=device_scale_factor,
            mobile=width <= 390,
            screenWidth=emulated_width,
            screenHeight=emulated_height,
        )
        wait(0.2)
        metrics = js("""({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          devicePixelRatio: window.devicePixelRatio
        })""")
        if metrics["innerWidth"] == width and metrics["innerHeight"] == height:
            break
        emulated_width = round(emulated_width * width / metrics["innerWidth"])
        emulated_height = round(emulated_height * height / metrics["innerHeight"])
        device_scale_factor = device_scale_factor / metrics["devicePixelRatio"]
    if metrics["innerWidth"] != width or metrics["innerHeight"] != height:
        raise AssertionError(f"Could not calibrate Chrome to {width}x{height}: {metrics}")
    return metrics


def scroll_target_into_view(selector, text_fragment):
    target = js("""(() => {
      const selector = %s;
      const text = %s;
      const element = [...document.querySelectorAll(selector)].find((candidate) =>
        (candidate.innerText || candidate.textContent || '').includes(text)
      );
      if (!element) return null;
      element.scrollIntoView({block: 'center', inline: 'nearest'});
      const rectangle = element.getBoundingClientRect();
      return {
        text: (element.innerText || element.textContent || '').trim(),
        left: rectangle.left,
        right: rectangle.right,
        top: rectangle.top,
        bottom: rectangle.bottom
      };
    })()""" % (json.dumps(selector), json.dumps(text_fragment)))
    if not target:
        raise AssertionError(f"Could not find visual target {text_fragment!r} in {selector!r}")
    wait(0.1)
    return target


def capture_state(state_name, width, height, selector, text_fragment):
    set_exact_viewport(width, height)
    target = scroll_target_into_view(selector, text_fragment)
    metrics = js("""({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      devicePixelRatio: window.devicePixelRatio
    })""")
    if metrics["innerWidth"] != width or metrics["innerHeight"] != height:
        raise AssertionError(f"CSS viewport changed while capturing {state_name}: {metrics}")
    if metrics["scrollWidth"] > metrics["innerWidth"]:
        raise AssertionError(f"Horizontal page overflow for {state_name} at {width}x{height}: {metrics}")
    if target["left"] < -0.5 or target["right"] > width + 0.5:
        raise AssertionError(f"Visual target overflow for {state_name} at {width}x{height}: {target}")
    screenshot = artifact_dir / f"{state_name}-{width}x{height}.png"
    capture_screenshot(str(screenshot))
    with screenshot.open("rb") as image:
        image.seek(16)
        screenshot_size = struct.unpack(">II", image.read(8))
    if screenshot_size != (width, height):
        raise AssertionError(f"Screenshot was {screenshot_size}, expected {(width, height)}")
    evidence = {
        "state": state_name,
        "viewport": f"{width}x{height}",
        "metrics": metrics,
        "target": target["text"],
        "screenshot": str(screenshot),
    }
    print(json.dumps(evidence))
    return evidence


def capture_state_at_all_viewports(state_name, selector, text_fragment):
    return [
        capture_state(state_name, width, height, selector, text_fragment)
        for width, height in VIEWPORTS
    ]


if port_is_open():
    raise RuntimeError("Port 41738 is occupied before the dashboard proof starts")

recording = start_recording(
    "automode-dashboard-pr56-" + time.strftime("%Y%m%d-%H%M%S"),
    title="PR 56 Automode Dashboard black-box chain and visual matrix",
)
proof_processes = []
task_tab_open = False
proof_result = None
try:
    print(json.dumps({"recording": str(recording), "artifacts": str(artifact_dir)}))

    # Deterministic synthetic data is limited to the repeatable nonterminal visual matrix.
    visual_proof = ProofProcess(VISUAL_PROOF_MAIN)
    proof_processes.append(visual_proof)
    visual_ready = visual_proof.wait_for_json("AUTOMODE_DASHBOARD_BROWSER_PROOF", timeout=15.0)
    new_tab(visual_ready["dashboardUrl"])
    task_tab_open = True
    wait_for_load()
    wait_for_element("#stage-lanes", timeout=10.0, visible=True)
    wait_until(lambda: has_accessible("heading", "Stage Lanes"), "Stage Lanes heading")
    wait_until(lambda: "Live Coordinator connection" in body_text(), "live Coordinator connection")
    wait_until(lambda: "live activity proof" in body_text(), "live Ticket Session activity")
    if "Lifecycle\nACTIVE" not in body_text():
        raise AssertionError("Missing representative active lifecycle")

    synthetic_states = (
        ("active", ".card", "RUNNING"),
        ("queued", ".card", "QUEUED"),
        ("blocked", ".card", "BLOCKED"),
        ("exhausted", ".card", "EXHAUSTED"),
        ("empty", ".empty-lane", "No Stage Candidates"),
    )
    for state_name, selector, text_fragment in synthetic_states:
        capture_state_at_all_viewports(state_name, selector, text_fragment)

    set_exact_viewport(390, 844)
    tab_to("Turn off Auto-Grilling")
    capture_screenshot(str(artifact_dir / "keyboard-focus-390x844.png"))
    press_key("Enter")
    wait_until(lambda: has_enabled_button("Turn on Auto-Grilling"), "enabled Auto-Grilling OFF control")
    tab_to("Turn on Auto-Grilling")
    press_key("Enter")
    wait_until(lambda: has_enabled_button("Turn off Auto-Grilling"), "enabled Auto-Grilling ON control")

    tab_to("Inspect #50")
    press_key("Enter")
    wait_until(lambda: has_accessible("dialog", "#50"), "read-only activity drawer")
    wait_until(lambda: "npm test \u2014 live activity proof" in body_text(), "drawer live activity")
    capture_screenshot(str(artifact_dir / "activity-drawer-390x844.png"))
    press_key("Escape")
    wait_until(lambda: not has_accessible("dialog", "#50"), "Escape to close activity drawer")
    if "Inspect #50" not in active_control()["name"]:
        raise AssertionError("Escape did not restore focus to the inspected Stage Candidate")
    press_key("Enter")
    wait_until(lambda: has_accessible("dialog", "#50"), "reopened activity drawer")
    wait_until(lambda: active_control()["name"] == "Close", "drawer close control focus")
    press_key("Enter")
    wait_until(lambda: not has_accessible("dialog", "#50"), "Close button to dismiss activity drawer")
    poll_before_refresh = js("document.querySelector('.supervision-note').innerText")
    tab_to("Refresh snapshot")
    press_key("Enter")
    wait_until(
        lambda: js("document.querySelector('.supervision-note').innerText") != poll_before_refresh,
        "refreshed poll timestamp",
    )

    close_tab()
    task_tab_open = False
    visual_proof.stop()
    if visual_proof.process.returncode != 0:
        raise AssertionError(f"Synthetic visual proof exited {visual_proof.process.returncode}: {visual_proof.output()}")
    wait_for_port_closed()

    # This is the required unsplit product chain: Pi -> TUI OSC-8 URL -> browser -> drain -> exit.
    black_box = ProofProcess(BLACK_BOX_PROOF_MAIN)
    proof_processes.append(black_box)
    black_box_ready = black_box.wait_for_json("AUTOMODE_DASHBOARD_BLACK_BOX_READY", timeout=35.0)
    emitted_dashboard_url = black_box_ready["dashboardUrl"]
    new_tab(emitted_dashboard_url)
    task_tab_open = True
    wait_for_load()
    wait_for_element("#stage-lanes", timeout=10.0, visible=True)
    wait_until(lambda: has_accessible("heading", "Stage Lanes"), "black-box Stage Lanes heading")
    wait_until(lambda: "RUNNING" in body_text(), "black-box running Ticket Session card")
    opened_url = js("window.location.href")
    if opened_url.rstrip("/") != emitted_dashboard_url.rstrip("/"):
        raise AssertionError(
            f"Browser opened {opened_url!r}, not emitted OSC-8 URL {emitted_dashboard_url!r}"
        )

    set_exact_viewport(390, 844)
    tab_to("Inspect #50")
    press_key("Enter")
    wait_until(lambda: has_accessible("dialog", "#50"), "black-box activity drawer")
    wait_until(lambda: "npm test \u2014 live activity proof" in body_text(), "black-box drawer live activity")
    capture_screenshot(str(artifact_dir / "black-box-live-activity-390x844.png"))
    press_key("Escape")
    wait_until(lambda: not has_accessible("dialog", "#50"), "black-box drawer close")

    tab_to("Graceful drain")
    press_key("Enter")
    wait_until(lambda: "Lifecycle\nDRAINING" in body_text(), "black-box graceful drain projection")
    capture_state_at_all_viewports("draining", ".lifecycle", "DRAINING")
    wait_until(
        lambda: "Disconnected \u00b7 stale snapshot" in body_text(),
        "black-box disconnected stale state",
        timeout=55.0,
    )
    capture_state_at_all_viewports("disconnected", ".banner", "Disconnected")

    black_box_exit = black_box.wait_for_json("AUTOMODE_DASHBOARD_BLACK_BOX_EXIT", timeout=15.0)
    black_box_process_exit = black_box.wait(timeout=10.0)
    if black_box_exit != {
        "dashboardUrl": emitted_dashboard_url,
        "processId": black_box_ready["processId"],
        "exitCode": 0,
    }:
        raise AssertionError(f"Unexpected black-box exit evidence: {black_box_exit!r}")
    if black_box_process_exit != 0:
        raise AssertionError(f"Black-box proof launcher exited {black_box_process_exit}: {black_box.output()}")
    wait_for_port_closed()

    proof_result = {
        "result": "passed",
        "blackBox": {
            "emittedOsc8Url": emitted_dashboard_url,
            "browserUrl": opened_url,
            "launchedProcessId": black_box_ready["processId"],
            "launchedProcessExitCode": black_box_exit["exitCode"],
        },
        "viewports": [f"{width}x{height}" for width, height in VIEWPORTS],
        "states": ["active", "queued", "blocked", "draining", "exhausted", "disconnected", "empty"],
        "screenshots": 21,
        "keyboard": ["Stage control", "card inspection", "Escape", "Close", "refresh", "graceful drain"],
        "syntheticLimit": "active/queued/blocked/exhausted/empty visual fixtures only",
    }
    print(json.dumps(proof_result))
finally:
    if task_tab_open:
        close_tab()
    for proof_process in reversed(proof_processes):
        proof_process.stop()
    wait_for_port_closed()
    stopped_recording = stop_recording()
    print(json.dumps({
        "recordingStopped": str(stopped_recording),
        "recordingDirectory": str(recording_dir()),
        "artifacts": str(artifact_dir),
        "resultRecorded": proof_result is not None,
    }))
