// hookmux generated this opencode plugin; `hookmux sync` rewrites it.
// Do not edit by hand: the next `hookmux sync` or `hookmux add` overwrites it.
//
// opencode has no command hooks, so this file stands in for one: it turns
// each opencode plugin hook into a hookmux payload, runs the launcher below
// as a short-lived process, and applies the JSON answer it prints. Every
// launcher call is wrapped so a crash, a timeout, a non-zero exit or garbage
// output all count as "no answer" rather than breaking opencode's own turn.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const LAUNCHER = "@LAUNCHER_JSON@";
const EVENTS = "@EVENTS_JSON@";
const TIMEOUT_MS = "@TIMEOUT_MS@";

/** opencode's built-in tool ids that hookmux's host adapter also maps; kept here only for the payload's own `tool_name`. */
const CANONICAL_TOOL_NAMES = {
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  read: "Read",
  apply_patch: "Edit",
};

function newId(prefix) {
  return `${prefix}_hookmux_${randomUUID().replaceAll("-", "")}`;
}

/** Runs the launcher once; resolves the parsed answer, or null for anything that is not a clean, parseable answer. */
function callHookmux(canonicalEvent, payload) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(LAUNCHER, ["--host", "opencode", "--event", canonicalEvent], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // Decoded as text so a multi-byte character split across chunks is not garbled.
    child.stdout.setEncoding("utf8");
    // A launcher that exits without reading stdin (no engine installed yet) makes the
    // write below fail with EPIPE; unhandled, that stream error would crash opencode.
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || out.trim() === "") {
        finish(null);
        return;
      }
      try {
        finish(JSON.parse(out));
      } catch {
        finish(null);
      }
    });
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      finish(null);
    }
  });
}

async function toast(client, message) {
  if (!client?.tui?.showToast) return;
  try {
    await client.tui.showToast({ body: { message, variant: "info" } });
  } catch {
    // No user-visible route for this notice; dropping it still keeps the turn going.
  }
}

function pushSyntheticText(output, sessionID, messageID, text) {
  output.parts.push({ id: newId("prt"), sessionID, messageID, type: "text", text, synthetic: true });
}

function contextOf(answer) {
  return answer && typeof answer.context === "string" && answer.context ? answer.context : null;
}

/**
 * `session.created`, read through the generic `event` hook. Records subagent
 * sessions (so their prompts count as the system's) and starts the
 * session.start call. Its context is held for that session's first
 * `chat.message` below, since `event` itself has no output to set.
 */
function makeSessionCreatedHandler(ctx) {
  return async ({ event }) => {
    try {
      if (event?.type !== "session.created") return;
      const info = event.properties?.info;
      if (!info?.id) return;
      if (info.parentID) ctx.subagentSessions.add(info.id);
      if (!EVENTS.includes("session.start")) return;
      const pending = callHookmux("session.start", {
        session_id: info.id,
        cwd: ctx.directory,
        hook_event_name: "event",
        origin: info.parentID ? "system" : "user",
      });
      // Stored before the first await: opencode runs this hook synchronously when it
      // publishes session.created (core/src/event.ts notify), so the entry exists before
      // the session's first chat.message even when the answer arrives later.
      ctx.pendingContext.set(info.id, pending.then(contextOf));
      const answer = await pending;
      if (answer && typeof answer.notice === "string" && answer.notice) await toast(ctx.client, answer.notice);
    } catch {
      // session.created is read-only from hookmux's side; never let it break startup.
    }
  };
}

/** `chat.message`: reads the submitted prompt text and may add a synthetic context part. */
function makeChatMessageHandler(ctx) {
  return async (hookInput, output) => {
    try {
      const sessionID = hookInput.sessionID;
      // Taken synchronously, so only the session's first chat.message delivers it.
      const sessionStart = ctx.pendingContext.get(sessionID) ?? null;
      ctx.pendingContext.delete(sessionID);
      const messageID = output.message?.id ?? hookInput.messageID ?? newId("msg");
      const prompt = output.parts
        .filter((part) => part?.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => part.text)
        .join("\n\n");
      // Session-start context is still delivered when no plugin listens to prompt.submit.
      const promptAnswer = EVENTS.includes("prompt.submit")
        ? callHookmux("prompt.submit", {
            session_id: sessionID,
            cwd: ctx.directory,
            hook_event_name: "chat.message",
            prompt,
            origin: ctx.subagentSessions.has(sessionID) ? "system" : "user",
          })
        : null;
      const [answer, startContext] = await Promise.all([promptAnswer, sessionStart]);
      if (startContext) pushSyntheticText(output, sessionID, messageID, startContext);

      if (!answer) return;
      if (typeof answer.context === "string" && answer.context) {
        pushSyntheticText(output, sessionID, messageID, answer.context);
      }
      if (typeof answer.notice === "string" && answer.notice) await toast(ctx.client, answer.notice);
    } catch {
      // Adding context is a bonus for this turn, never a reason to fail the user's prompt.
    }
  };
}

/** `tool.execute.before`: the one hook whose deny must reach opencode as a thrown error. */
function makeToolBeforeHandler(ctx) {
  return async (hookInput, output) => {
    let answer = null;
    try {
      if (!EVENTS.includes("tool.before")) return;
      answer = await callHookmux("tool.before", {
        session_id: hookInput.sessionID,
        cwd: ctx.directory,
        hook_event_name: "tool.execute.before",
        tool_name: CANONICAL_TOOL_NAMES[hookInput.tool] ?? hookInput.tool,
        tool_input: output.args,
      });
      // Not awaited, so a slow toast can never hold up the tool call or its deny.
      if (answer && typeof answer.notice === "string" && answer.notice) void toast(ctx.client, answer.notice);
    } catch {
      answer = null;
    }
    // Denying is the one effect that must reach opencode as a thrown error,
    // so it stays outside the try/catch above.
    if (answer && typeof answer.block === "string" && answer.block) throw new Error(answer.block);
  };
}

/** `tool.execute.after`: may append context to the tool's own output text. */
function makeToolAfterHandler(ctx) {
  return async (hookInput, output) => {
    try {
      if (!EVENTS.includes("tool.after")) return;
      const answer = await callHookmux("tool.after", {
        session_id: hookInput.sessionID,
        cwd: ctx.directory,
        hook_event_name: "tool.execute.after",
        tool_name: CANONICAL_TOOL_NAMES[hookInput.tool] ?? hookInput.tool,
        tool_input: hookInput.args,
        tool_response: output.output,
      });
      if (!answer) return;
      if (typeof answer.notice === "string" && answer.notice) await toast(ctx.client, answer.notice);
      if (typeof answer.context === "string" && answer.context && typeof output.output === "string") {
        output.output = `${output.output}\n\n${answer.context}`;
      }
    } catch {
      // Appending context after the tool ran is a bonus; the tool result still stands.
    }
  };
}

export default async function hookmuxPlugin(input) {
  const ctx = {
    client: input?.client,
    directory: input?.directory ?? process.cwd(),
    // Subagent session ids (session.created carries parentID for them), so a
    // prompt inside one is marked origin "system" instead of the user's.
    subagentSessions: new Set(),
    // Session id to a promise of the context hookmux returned for session.created
    // (or null), held until that session's first chat.message because the
    // `event` hook has no output.
    pendingContext: new Map(),
  };
  return {
    event: makeSessionCreatedHandler(ctx),
    "chat.message": makeChatMessageHandler(ctx),
    "tool.execute.before": makeToolBeforeHandler(ctx),
    "tool.execute.after": makeToolAfterHandler(ctx),
  };
}
