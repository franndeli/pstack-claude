// OrcaChild against a fake `orca` CLI that runs the terminal command in the
// background, and a scripted child that speaks the bridge's file protocol.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OrcaChild } from "../../plugins/pstack/pi/orca-child.ts";

const dir = mkdtempSync(join(tmpdir(), "pstack-orca-child-"));

// Runs --command in a detached shell, as Orca's tab would, and prints a receipt.
const fakeOrca = join(dir, "orca");
writeFileSync(
  fakeOrca,
  `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --command) cmd="$2"; shift 2;; *) shift;; esac; done
sh -c "$cmd" > /dev/null 2>&1 &
echo '{"ok":true,"result":{"terminal":{"handle":"term_fake","surface":"visible"}}}'
`,
);
chmodSync(fakeOrca, 0o755);

// A pi that answers through the bridge files: hello, a reply to the prompt and
// a settle, then exit on close. A steer before the settle is taken into the reply.
const fakePi = join(dir, "fake-pi.mjs");
writeFileSync(
  fakePi,
  `import { appendFileSync, readFileSync } from "node:fs";
const dir = process.env.PSTACK_BRIDGE_DIR;
const emit = (o) => appendFileSync(dir + "/out.jsonl", JSON.stringify(o) + "\\n");
emit({ type: "bridge_hello", pid: process.pid });
process.on("exit", (code) => emit({ type: "bridge_exit", code }));
let seen = 0, prompt, steer;
const delay = Number(process.env.FAKE_DELAY_MS || 0);
setInterval(() => {
  const lines = readFileSync(dir + "/in.jsonl", "utf8").split("\\n").filter(Boolean);
  for (const line of lines.slice(seen)) {
    const c = JSON.parse(line);
    if (c.type === "close") process.exit(0);
    if (c.type === "steer") steer = c.message;
    if (c.id) emit({ type: "response", id: c.id, command: c.type, success: true });
    if (c.type === "prompt") { prompt = c.message; setTimeout(() => {
      emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "true" } });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: [prompt, steer].filter(Boolean).join(" + ") }] } });
      emit({ type: "agent_settled" });
    }, delay); }
  }
  seen = lines.length;
}, 20);
`,
);

const launch = (name, prompt, extra = {}) =>
  new OrcaChild(process.execPath, [fakePi], {
    cwd: dir,
    exitGraceMs: 2000,
    dir: join(dir, name),
    title: "agent · test",
    orca: { cli: fakeOrca, worktree: "id:fake" },
    ...extra,
  }, prompt);

test("a visible child takes its prompt from the inbox, reports its pid, and ends with its reply once settled", async () => {
  let started;
  const child = launch("plain", "hello", { onStarted: (pid) => (started = pid) });
  const exit = await child.exited;
  expect(exit).toMatchObject({ settled: true, finalText: "hello", errorMessage: "", exitCode: 0 });
  expect(started).toBeNumber();
  expect(child.pid).toBe(started);
  expect(child.handle).toBe("term_fake");
  expect(child.activity?.tool?.name).toBe("bash");
});

test("a steer before the settle is taken into the run", async () => {
  const child = launch("steer", "task", { env: { FAKE_DELAY_MS: "600" } });
  const { taken } = await child.steer("more");
  expect(taken).toBe(true);
  expect((await child.exited).finalText).toBe("task + more");
});

test("an Orca CLI that cannot open a terminal fails the run without waiting for a start", async () => {
  const child = new OrcaChild(process.execPath, [fakePi], {
    cwd: dir,
    exitGraceMs: 1000,
    dir: join(dir, "nocli"),
    title: "t",
    orca: { cli: join(dir, "missing-orca"), worktree: "id:fake" },
  }, "p");
  const exit = await child.exited;
  expect(exit.settled).toBe(false);
  expect(exit.errorMessage).toContain("Orca could not open a terminal");
});

test("a child stopped before pi started never runs its prompt", async () => {
  const child = launch("early-stop", "never");
  child.end(500);
  const exit = await child.exited;
  expect(exit.settled).toBe(false);
  expect(readFileSync(join(dir, "early-stop", "in.jsonl"), "utf8")).toContain('"type":"close"');
});
