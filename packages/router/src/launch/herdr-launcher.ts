import { createHash, randomBytes } from "node:crypto";
import { redactCollectorText } from "../collectors/normalizer.js";
import type { AgentId } from "../domain/ids.js";
import type { ReasoningEffort } from "../domain/model-profile.js";
import { buildAgentCommand, herdrAgentKind } from "./agent-command.js";
import { createHerdrClient, type HerdrClient } from "./herdr-client.js";
import { isHerdrEnv } from "./readiness.js";

export function parseHerdrPaneId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const data = JSON.parse(trimmed) as {
      result?: { pane?: { pane_id?: unknown } };
      pane?: { pane_id?: unknown };
    };
    const id = data.result?.pane?.pane_id ?? data.pane?.pane_id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  } catch {
    // Fall back to the first token of plain-text Herdr output.
  }
  return trimmed.split(/\s+/)[0];
}

// Herdr reports failures as JSON ({"error":{"code":"...","message":"..."}}) on stdout or
// stderr depending on the command.
export function herdrError(result: { stdout: string; stderr: string }, action: string): string {
  for (const stream of [result.stdout, result.stderr]) {
    try {
      const data = JSON.parse(stream.trim()) as {
        error?: { code?: unknown; message?: unknown };
      };
      const code = typeof data.error?.code === "string" ? data.error.code : undefined;
      const message = typeof data.error?.message === "string" ? data.error.message : undefined;
      if (code || message) {
        return `${action}: ${[code, message].filter(Boolean).join(": ")}`;
      }
    } catch {
      // Not JSON; try the next stream.
    }
  }
  const stderr = result.stderr.trim();
  return stderr ? `${action}: ${stderr}` : action;
}

// Herdr agent names must be unique among live agents and match [a-z][a-z0-9_-]{0,31}.
// Deriving the name from the launch token keeps each launch distinct and lets a retry reuse it.
export function herdrAgentName(agent: AgentId, launchToken: string): string {
  const suffix = createHash("sha256").update(launchToken).digest("hex").slice(0, 6);
  return `router-${herdrAgentKind(agent)}-${suffix}`;
}

const HANDOFF_TIMEOUT_MS = 30_000;
// A fresh pane's login shell can take several seconds (heavy shell profiles, a loaded machine).
const PANE_BUSY_RETRIES = 10;
const PANE_BUSY_RETRY_MS = 1_000;

// Herdr never reports `opencode mini` as working, so a delivered prompt always looks stalled
// and the agent is often idle again (turn finished) before any later wait. OpenCode echoes
// each submitted prompt into its transcript as a line starting with "›" (an unsent draft sits
// in the input box after "┃" instead), so that echo is the delivery signal for OpenCode.
// Only a "›" at the start of a line marks a submission; one inside the prompt text is content.
const OPENCODE_SUBMITTED_LINE = /^[ \t]*›/gm;
const DELIVERY_PROBE_CHARS = 48;
const DELIVERY_READ_LINES = 400;

/** True when the pane transcript shows `handoff` as a submitted OpenCode prompt. */
export function opencodeShowsSubmittedPrompt(paneText: string, handoff: string): boolean {
  // Compare without whitespace: the TUI wraps and indents long prompts.
  const probe = handoff.replace(/\s+/g, "").slice(0, DELIVERY_PROBE_CHARS);
  if (!probe) {
    return false;
  }
  for (const mark of paneText.matchAll(OPENCODE_SUBMITTED_LINE)) {
    const echoed = paneText.slice(mark.index + mark[0].length).replace(/\s+/g, "");
    if (echoed.startsWith(probe)) {
      return true;
    }
  }
  return false;
}

export interface LaunchResult {
  ok: boolean;
  error?: string;
  paneCreated?: boolean;
  printed?: string;
  launchToken?: string;
  paneId?: string;
  agentName?: string;
}

export async function launchRoutedAgent(input: {
  env: NodeJS.Dict<string>;
  agent: AgentId;
  launchName: string;
  effort: ReasoningEffort;
  handoff: string;
  dryRun: boolean;
  existingLaunchToken?: string;
  existingPaneId?: string;
  herdr?: HerdrClient;
  /** Working directory for a new pane; omitted, Herdr uses the current pane's directory. */
  cwd?: string;
  /** Test seam for the pane-busy retry delay. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<LaunchResult> {
  if (!isHerdrEnv(input.env) && !input.dryRun) {
    return { ok: false, error: "HERDR_ENV=1 is required to launch a pane" };
  }
  const command = buildAgentCommand({
    agent: input.agent,
    launchName: input.launchName,
    effort: input.effort,
  });
  const printed = redactCollectorText(`start ${command.join(" ")}; send handoff: ${input.handoff}`);
  const launchToken =
    input.existingLaunchToken ?? `launch_${Date.now()}_${randomBytes(4).toString("hex")}`;
  if (input.dryRun) {
    return { ok: true, paneCreated: false, printed, launchToken };
  }
  const agentName = herdrAgentName(input.agent, launchToken);
  const herdr =
    input.herdr ??
    createHerdrClient(async () => ({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "herdr command adapter was not injected",
    }));
  let paneId = input.existingPaneId;
  let paneCreated = false;
  if (!paneId) {
    const split =
      input.cwd === undefined
        ? await herdr.splitCurrent()
        : await herdr.splitCurrent({ cwd: input.cwd });
    if (!split.ok) {
      return { ok: false, error: herdrError(split, "herdr pane split failed"), launchToken };
    }
    paneId = parseHerdrPaneId(split.stdout);
    if (!paneId) {
      return { ok: false, error: "herdr pane split did not return a pane id", launchToken };
    }
    paneCreated = true;
  }
  if (!input.existingPaneId) {
    const start = () =>
      herdr.startAgent({
        name: agentName,
        kind: herdrAgentKind(input.agent),
        paneId: paneId as string,
        // Herdr runs the kind's own executable; pass only its native arguments after `--`.
        agentArgs: command.slice(1),
      });
    let started = await start();
    // A pane that was just split may still be starting its shell, and Herdr refuses to start
    // an agent there with agent_pane_busy. Only for a pane we created: retry while it settles.
    const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (
      let attempt = 0;
      paneCreated &&
      !started.ok &&
      attempt < PANE_BUSY_RETRIES &&
      `${started.stdout}${started.stderr}`.includes("agent_pane_busy");
      attempt += 1
    ) {
      await sleep(PANE_BUSY_RETRY_MS);
      started = await start();
    }
    if (!started.ok) {
      const error = herdrError(started, "herdr agent start failed");
      if (paneCreated) {
        // Do not leave an empty shell pane behind for a launch that never started.
        await herdr.closePane(paneId);
        return { ok: false, error, launchToken, paneCreated: false, agentName };
      }
      return { ok: false, error, launchToken, paneId, paneCreated, agentName };
    }
    // `agent start` returns once the agent UI is detected; let startup (MCP, skills) settle
    // first, or a prompt pasted during startup can be dropped.
    const settled = await herdr.waitFor({ target: agentName, timeoutMs: HANDOFF_TIMEOUT_MS });
    if (!settled.ok) {
      return {
        ok: false,
        error: herdrError(settled, "herdr agent wait failed"),
        launchToken,
        paneId,
        paneCreated,
        agentName,
      };
    }
  }
  // Wait only until the agent starts working (or asks a question), not for the whole turn.
  // Herdr returns agent_prompt_stalled when the submission produced no activity.
  const prompted = await herdr.prompt({
    target: agentName,
    text: input.handoff,
    until: ["working", "blocked"],
    timeoutMs: HANDOFF_TIMEOUT_MS,
  });
  if (!prompted.ok) {
    const output = `${prompted.stdout}${prompted.stderr}`;
    // Herdr gives an accepted prompt a fixed 5s to show working or blocked, which a slow
    // agent startup can miss even though it did receive the handoff. Confirm with a second
    // wait before calling the launch failed.
    if (output.includes("agent_prompt_stalled")) {
      if (herdrAgentKind(input.agent) === "opencode") {
        const pane = await herdr.readRecent(paneId, DELIVERY_READ_LINES);
        if (pane.ok && opencodeShowsSubmittedPrompt(pane.stdout, input.handoff)) {
          return { ok: true, paneCreated, printed, launchToken, paneId, agentName };
        }
      }
      const recovered = await herdr.waitFor({
        target: agentName,
        until: ["working", "blocked"],
        timeoutMs: HANDOFF_TIMEOUT_MS,
      });
      if (recovered.ok) {
        return { ok: true, paneCreated, printed, launchToken, paneId, agentName };
      }
    }
    return {
      ok: false,
      error: output.includes("agent_blocked")
        ? "agent is blocked; not resending the handoff"
        : output.includes("agent_prompt_stalled")
          ? `handoff not received by agent ${agentName} in pane ${paneId} (${herdrError(prompted, "").replace(/^: /, "")}); paste the task there or retry`
          : herdrError(prompted, "herdr agent prompt failed"),
      launchToken,
      paneId,
      paneCreated,
      printed,
      agentName,
    };
  }
  return { ok: true, paneCreated, printed, launchToken, paneId, agentName };
}
