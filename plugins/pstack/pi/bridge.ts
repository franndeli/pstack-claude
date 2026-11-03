import { appendFileSync, closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { BRIDGE_DIR_ENV, BRIDGE_EXIT, BRIDGE_HELLO, CLOSE, INBOX, OUTBOX } from "./bridge-protocol.ts";
import { lineSplitter } from "./child.ts";

const POLL_MS = 200;

type Command = { id?: string; type?: string; message?: string };

// Loaded into an agent's pi that runs with its TUI in an Orca terminal. It
// stands in for `--mode rpc`: commands come from the inbox file and pi's
// events go to the outbox file, in the shapes the runner reads from a hidden
// child's stdio.
export default function bridge(pi: ExtensionAPI): void {
  const dir = process.env[BRIDGE_DIR_ENV];
  if (!dir) return;
  const outbox = join(dir, OUTBOX);
  const inbox = join(dir, INBOX);
  const emit = (line: object) => appendFileSync(outbox, `${JSON.stringify(line)}\n`);
  const respond = (command: Command, success: boolean, error?: string) =>
    command.id && emit({ type: "response", id: command.id, command: command.type, success, ...(error ? { error } : {}) });

  let ctx: ExtensionContext | undefined;
  let offset = 0;
  let poll: NodeJS.Timeout | undefined;

  const handle = (command: Command) => {
    if (!ctx) return;
    try {
      if (command.type === "prompt" && command.message) {
        pi.sendUserMessage(command.message);
        respond(command, true);
      } else if (command.type === "steer" && command.message) {
        // An idle pi has settled: the runner counts the steer as not taken and
        // resumes the agent with it once this pi exits.
        if (!ctx.isIdle()) pi.sendUserMessage(command.message, { deliverAs: "steer" });
        respond(command, true);
      } else if (command.type === "abort") {
        ctx.abort();
        respond(command, true);
      } else if (command.type === CLOSE) {
        ctx.shutdown();
      } else respond(command, false, `unsupported command: ${command.type}`);
    } catch (e) {
      respond(command, false, (e as Error).message);
    }
  };
  let batch: Command[] = [];
  const lines = lineSplitter((line) => {
    try {
      batch.push(JSON.parse(line));
    } catch {}
  });
  const read = () => {
    const fd = openSync(inbox, "r");
    try {
      const chunk = Buffer.alloc(64 * 1024);
      for (let n; (n = readSync(fd, chunk, 0, chunk.length, offset)) > 0; offset += n) lines.write(chunk.subarray(0, n));
    } finally {
      closeSync(fd);
    }
    const commands = batch;
    batch = [];
    // A runner that stopped the agent before this pi started left the prompt
    // and the close together: the task must not run.
    const stoppedFirst = commands.some((command) => command.type === CLOSE);
    for (const command of commands) if (!(stoppedFirst && command.type === "prompt")) handle(command);
  };

  process.on("exit", (code) => emit({ type: BRIDGE_EXIT, code }));
  pi.on("session_start", (_event, c) => {
    ctx = c;
    if (poll) return;
    emit({ type: BRIDGE_HELLO, pid: process.pid });
    poll = setInterval(read, POLL_MS);
  });
  pi.on("session_shutdown", () => {
    clearInterval(poll);
    poll = undefined;
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") emit({ type: "message_end", message: event.message });
  });
  pi.on("tool_execution_start", (event) => emit({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }));
  pi.on("tool_execution_end", (event) => emit({ type: "tool_execution_end", toolCallId: event.toolCallId }));
  pi.on("agent_settled", () => emit({ type: "agent_settled" }));
}
