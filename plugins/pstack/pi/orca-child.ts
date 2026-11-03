import { execFile } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BRIDGE_DIR_ENV, BRIDGE_EXIT, BRIDGE_HELLO, CLOSE, INBOX, OUTBOX } from "./bridge-protocol.ts";
import { alive, type Child, type ChildExit, lineSplitter, RpcReader } from "./child.ts";
import type { OrcaTarget } from "./config.ts";

const POLL_MS = 250;
// From the terminal opening to the bridge saying hello: pi's own startup,
// extensions and MCP servers included.
const START_TIMEOUT_MS = 90_000;
const LAUNCH_TIMEOUT_MS = 30_000;

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// A pi with its full TUI, in a visible Orca terminal tab the user can watch and
// type into. It speaks the same RPC lines as a hidden child, through two files
// it shares with the bridge extension loaded into it: the runner appends
// commands to the inbox, the bridge appends pi's events to the outbox. The
// tab outlives pi, so its scrollback stays to read once the agent has ended.
export class OrcaChild extends RpcReader implements Child {
  pid: number | undefined;
  handle?: string;
  readonly exited: Promise<ChildExit>;
  private readonly inbox: string;
  private readonly outbox: string;
  private readonly exitGraceMs: number;
  private readonly onStarted?: (pid: number) => void;
  private readonly lines = lineSplitter((line) => this.onBridgeLine(line));
  private offset = 0;
  private exitCode: number | null = null;
  private poll?: NodeJS.Timeout;
  private closeTimer?: NodeJS.Timeout;
  private startTimer?: NodeJS.Timeout;
  private resolveExit!: (exit: ChildExit) => void;
  private done = false;

  constructor(
    command: string,
    args: string[],
    opts: { cwd: string; env?: NodeJS.ProcessEnv; exitGraceMs: number; onActivity?: () => void; onStarted?: (pid: number) => void; dir: string; title: string; orca: OrcaTarget },
    prompt: string,
  ) {
    super(opts.onActivity);
    this.exitGraceMs = opts.exitGraceMs;
    this.onStarted = opts.onStarted;
    mkdirSync(opts.dir, { recursive: true });
    this.inbox = join(opts.dir, INBOX);
    this.outbox = join(opts.dir, OUTBOX);
    writeFileSync(this.inbox, "", { mode: 0o600 });
    writeFileSync(this.outbox, "", { mode: 0o600 });
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    // The prompt waits in the inbox until the bridge reads it.
    this.sendPrompt(prompt);

    const env = Object.entries({ ...opts.env, [BRIDGE_DIR_ENV]: opts.dir })
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${quote(value)}`);
    const shell = `cd ${quote(opts.cwd)} && env ${env.join(" ")} ${[command, ...args].map(quote).join(" ")}`;
    const launch = ["terminal", "create", "--worktree", opts.orca.worktree, "--title", opts.title, "--command", shell, "--json"];
    execFile(opts.orca.cli, launch, { timeout: LAUNCH_TIMEOUT_MS }, (error, stdout, stderr) => {
      let handle: string | undefined;
      try {
        handle = JSON.parse(stdout)?.result?.terminal?.handle;
      } catch {}
      if (error || !handle) {
        this.fail(`Orca could not open a terminal for the agent: ${(error?.message ?? "") + stderr + stdout}`.trim());
        return;
      }
      this.handle = handle;
      this.startTimer = setTimeout(() => this.fail(`pi did not start in Orca terminal ${handle} within ${START_TIMEOUT_MS / 1000}s.`), START_TIMEOUT_MS).unref();
    });
    this.poll = setInterval(() => this.read(), POLL_MS).unref();
  }

  protected write(line: string): void {
    appendFileSync(this.inbox, line);
  }

  private read(): void {
    let fd: number | undefined;
    try {
      fd = openSync(this.outbox, "r");
      const chunk = Buffer.alloc(64 * 1024);
      for (let n; (n = readSync(fd, chunk, 0, chunk.length, this.offset)) > 0; this.offset += n) this.lines.write(chunk.subarray(0, n));
    } catch {
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    // A pi killed outright never writes its exit line.
    if (this.pid !== undefined && !this.done && !alive(this.pid)) this.finish();
  }

  private onBridgeLine(line: string): void {
    let parsed: { type?: unknown; pid?: unknown; code?: unknown } = {};
    try {
      parsed = JSON.parse(line);
    } catch {}
    if (parsed.type === BRIDGE_HELLO && typeof parsed.pid === "number") {
      clearTimeout(this.startTimer);
      this.pid = parsed.pid;
      this.onStarted?.(parsed.pid);
    } else if (parsed.type === BRIDGE_EXIT) {
      this.exitCode = typeof parsed.code === "number" ? parsed.code : null;
      this.finish();
    } else this.onLine(line);
  }

  private fail(message: string): void {
    this.errorMessage = message;
    this.finish();
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.open = false;
    clearInterval(this.poll);
    clearTimeout(this.closeTimer);
    clearTimeout(this.startTimer);
    this.lines.end();
    this.dropPending();
    this.resolveExit({ exitCode: this.exitCode, settled: this.settled, finalText: this.finalText, errorMessage: this.errorMessage, stderr: "" });
  }

  // The bridge shuts pi down once idle. One that does not is ended.
  close(): void {
    if (!this.endInput()) return;
    this.closeTimer = setTimeout(() => this.terminate(this.exitGraceMs), this.exitGraceMs).unref();
  }

  end(graceMs: number): void {
    this.endInput();
    clearTimeout(this.closeTimer);
    this.terminate(graceMs);
  }

  private endInput(): boolean {
    if (!this.open) return false;
    this.open = false;
    this.write(`${JSON.stringify({ type: CLOSE })}\n`);
    return true;
  }

  // The pi process alone, not a group: in an interactive shell its group may be
  // the launcher's. Pi stops the bash command it has running on SIGTERM.
  private terminate(graceMs: number): void {
    if (this.pid === undefined) {
      if (!this.done) this.fail("The agent was stopped before pi started in its Orca terminal.");
      return;
    }
    this.signal("SIGTERM");
    setTimeout(() => this.signal("SIGKILL"), graceMs).unref();
  }

  signal(signal: NodeJS.Signals): void {
    if (this.pid === undefined || this.done || !alive(this.pid)) return;
    try {
      process.kill(this.pid, signal);
    } catch {}
  }
}
