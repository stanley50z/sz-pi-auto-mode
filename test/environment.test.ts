import assert from "node:assert/strict";
import test from "node:test";
import { createAutomodeEnvironment } from "../src/environment.js";

test("shares credential environment without inheriting normal Pi process configuration", () => {
  const { environment, normalAgentDir } = createAutomodeEnvironment({
    PATH: "runtime-path",
    HOME: "/home/proof",
    ANTHROPIC_API_KEY: "credential",
    PI_CODING_AGENT_DIR: "/normal/config",
    PI_CODING_AGENT_SESSION_DIR: "/normal/sessions",
    PI_PACKAGE_DIR: "/normal/packages",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "1",
    PI_SESSION_ID: "normal-session",
    PI_EXPERIMENTAL: "1",
    PI_CLEAR_ON_SHRINK: "1",
    PI_TIMING: "1",
    PI_TUI_WRITE_LOG: "normal-tui.log",
    HTTP_PROXY: "http://normal-proxy",
    HTTPS_PROXY: "http://normal-secure-proxy",
    ALL_PROXY: "socks5://normal-proxy",
    NO_PROXY: "localhost,127.0.0.1",
    NODE_OPTIONS: "--require normal-config.js",
  });

  assert.equal(normalAgentDir, "/normal/config");
  assert.equal(environment.PATH, "runtime-path");
  assert.equal(environment.HOME, "/home/proof");
  assert.equal(environment.ANTHROPIC_API_KEY, "credential");
  assert.equal(environment.AI_AGENT, "pi");
  assert.equal(environment.PI_CODING_AGENT, "true");
  assert.equal(environment.PI_CODING_AGENT_DIR, undefined);
  assert.equal(environment.PI_CODING_AGENT_SESSION_DIR, undefined);
  assert.equal(environment.PI_PACKAGE_DIR, undefined);
  assert.equal(environment.PI_OFFLINE, undefined);
  assert.equal(environment.PI_TELEMETRY, undefined);
  assert.equal(environment.PI_SESSION_ID, undefined);
  assert.equal(environment.PI_EXPERIMENTAL, undefined);
  assert.equal(environment.PI_CLEAR_ON_SHRINK, undefined);
  assert.equal(environment.PI_TIMING, undefined);
  assert.equal(environment.PI_TUI_WRITE_LOG, undefined);
  assert.equal(environment.HTTP_PROXY, "http://normal-proxy");
  assert.equal(environment.HTTPS_PROXY, "http://normal-secure-proxy");
  assert.equal(environment.ALL_PROXY, "socks5://normal-proxy");
  assert.equal(environment.NO_PROXY, "localhost,127.0.0.1");
  assert.equal(environment.NODE_OPTIONS, undefined);
});
