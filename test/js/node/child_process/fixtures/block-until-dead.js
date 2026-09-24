// Synchronous waits for tests that keep a parent off its event loop until a child is dead, so
// that what the child wrote and its exit are both pending when the parent returns to the loop.
// Node APIs only: the fixtures that use it also run under node.
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");

// Without pidfd_open (gVisor, seccomp filters, kernels before 5.6) bun reaps children on a waiter
// thread, which then posts the exit to the event loop. Tests force that mode with this flag.
const reapedOffLoop = Boolean(process.versions.bun && process.env.BUN_FEATURE_FLAG_FORCE_WAITER_THREAD);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// "Z": dead and not reaped. "gone": reaped. Anything else: alive.
function processState(pid) {
  if (process.platform === "linux") {
    try {
      // "<pid> (<comm>) <state> ..."
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "latin1");
      return stat[stat.lastIndexOf(")") + 2];
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      return "gone";
    }
  }
  const { stdout } = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return stdout.trim()[0] ?? "gone";
}

// A dead child stays a zombie while its parent, which reaps it from its event loop, is blocked
// here. The waiter thread reaps within a moment instead. A zombie that outlasts that moment is
// not going to be reaped off the loop, so it counts as dead too.
function blockUntilDead(pid) {
  const deadline = Date.now() + 30_000;
  let zombieSince;
  for (;;) {
    const state = processState(pid);
    if (state === "gone") return;
    if (state === "Z") {
      zombieSince ??= Date.now();
      if (!reapedOffLoop || Date.now() - zombieSince > 250) return;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for child ${pid} to die`);
    sleepSync(1);
  }
}

// The waiter thread handles exits in spawn order. Once it has reaped a child that was spawned
// after the others, it has posted their exits to the event loop.
function blockUntilExitsArePosted() {
  if (reapedOffLoop) blockUntilDead(spawn("/bin/sh", ["-c", ":"], { stdio: "ignore" }).pid);
}

module.exports = { blockUntilDead, blockUntilExitsArePosted };
