"""Run with browser-harness; this is live-browser proof, not a DOM test."""

import json
import struct
import tempfile
from pathlib import Path


dashboard_url = os.environ.get("AUTOMODE_DASHBOARD_URL")
if not dashboard_url:
    raise RuntimeError("AUTOMODE_DASHBOARD_URL must be the URL printed by npm run prove:dashboard")

artifact_dir = Path(os.environ.get(
    "AUTOMODE_DASHBOARD_ARTIFACT_DIR",
    str(Path(tempfile.gettempdir()) / "automode-dashboard-browser-proof"),
))
artifact_dir.mkdir(parents=True, exist_ok=True)


def wait_until(predicate, description, timeout=10.0):
    deadline = time.time() + timeout
    last_value = None
    while time.time() < deadline:
        last_value = predicate()
        if last_value:
            return last_value
        wait(0.1)
    raise AssertionError(f"Timed out waiting for {description}; last value: {last_value!r}")


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
        if name_fragment in current["name"]:
            return current
        press_key("Tab")
        wait(0.04)
    raise AssertionError(f"Tab order never reached {name_fragment!r}: {visited!r}")


def set_viewport(width, height, name):
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
        raise AssertionError(f"Could not calibrate the Chrome viewport to {width}x{height}: {metrics}")
    if metrics["scrollWidth"] > metrics["innerWidth"]:
        raise AssertionError(f"Horizontal page overflow at {width}x{height}: {metrics}")
    screenshot = artifact_dir / f"{name}.png"
    capture_screenshot(str(screenshot))
    with screenshot.open("rb") as image:
        image.seek(16)
        screenshot_size = struct.unpack(">II", image.read(8))
    if screenshot_size != (width, height):
        raise AssertionError(f"Screenshot was {screenshot_size}, expected {(width, height)}")
    print(json.dumps({"viewport": f"{width}x{height}", "metrics": metrics, "screenshot": str(screenshot)}))


recording = start_recording(
    "automode-dashboard-pr56-" + time.strftime("%Y%m%d-%H%M%S"),
    title="PR 56 Automode Dashboard responsive and keyboard walkthrough",
)
task_tab_open = False
try:
    print(json.dumps({"recording": str(recording)}))
    new_tab(dashboard_url)
    task_tab_open = True
    wait_for_load()
    wait_for_element("#stage-lanes", timeout=10.0, visible=True)
    wait_until(lambda: has_accessible("heading", "Stage Lanes"), "Stage Lanes heading")
    wait_until(lambda: "Live Coordinator connection" in body_text(), "live Coordinator connection")
    wait_until(lambda: "live activity proof" in body_text(), "live Ticket Session activity")

    for status_name in ("QUEUED", "BLOCKED", "RUNNING", "EXHAUSTED"):
        if status_name not in body_text():
            raise AssertionError(f"Missing representative {status_name} state")
    if "No Stage Candidates" not in body_text():
        raise AssertionError("Missing representative empty Stage Lane")

    set_viewport(1440, 900, "1440x900-stage-lanes")
    set_viewport(1024, 768, "1024x768-stage-lanes")
    set_viewport(390, 844, "390x844-stage-lanes")

    tab_to("Turn off Auto-Grilling")
    capture_screenshot(str(artifact_dir / "390x844-keyboard-focus.png"))
    press_key("Enter")
    wait_until(lambda: has_enabled_button("Turn on Auto-Grilling"), "enabled Auto-Grilling OFF control")
    tab_to("Turn on Auto-Grilling")
    press_key("Enter")
    wait_until(lambda: has_enabled_button("Turn off Auto-Grilling"), "enabled Auto-Grilling ON control")

    tab_to("Inspect #50")
    press_key("Enter")
    wait_until(lambda: has_accessible("dialog", "#50"), "read-only activity drawer")
    wait_until(lambda: "npm test \u2014 live activity proof" in body_text(), "drawer live activity")
    capture_screenshot(str(artifact_dir / "390x844-activity-drawer.png"))
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

    set_viewport(1024, 768, "1024x768-after-keyboard-controls")
    tab_to("Graceful drain")
    press_key("Enter")
    wait_until(lambda: "Lifecycle\nDRAINING" in body_text(), "graceful drain projection")
    capture_screenshot(str(artifact_dir / "1024x768-draining.png"))
    wait_until(lambda: "Disconnected \u00b7 stale snapshot" in body_text(), "disconnected stale state", timeout=12.0)
    capture_screenshot(str(artifact_dir / "1024x768-disconnected.png"))

    print(json.dumps({
        "result": "passed",
        "viewports": ["1440x900", "1024x768", "390x844"],
        "keyboard": ["Stage control", "card inspection", "Escape", "Close", "refresh", "graceful drain"],
        "states": ["active", "queued", "blocked", "draining", "exhausted", "disconnected", "empty"],
    }))
finally:
    stopped_recording = stop_recording()
    print(json.dumps({
        "recordingStopped": str(stopped_recording),
        "recordingDirectory": str(recording_dir()),
    }))
    if task_tab_open:
        close_tab()
