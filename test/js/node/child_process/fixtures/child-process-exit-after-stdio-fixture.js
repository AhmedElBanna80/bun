// The parent process of child-process-exit-after-stdio.test.ts. It runs the scenario named by its
// argument and prints the order of the events it saw as JSON. It uses node APIs only, so it also
// runs under node.
//
// In each scenario the parent stays off its event loop until the children are dead. What they
// wrote and their exits are then all pending when the parent returns to its loop, and all of it
// arrives in one poll batch.
"use strict";
const { execSync, fork, spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { blockUntilDead, blockUntilExitsArePosted } = require("./block-until-dead.js");

if (process.argv[2] === "forkChild") {
  process.send("last", () => process.exit(0));
  return;
}

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "exit-after-stdio-"));
process.on("exit", () => fs.rmSync(tmpdir, { recursive: true, force: true }));

let goFiles = 0;

// A child that waits for its go-file, writes `text` to `fd`, and exits.
function writer(fd, text, stdio) {
  const goFile = path.join(tmpdir, `go-${goFiles++}`);
  const script = `while [ ! -e "$0" ]; do sleep 0.01; done; printf %s "$1" >&${fd}`;
  const child = spawn("/bin/sh", ["-c", script, goFile, text], { stdio });
  child.release = () => fs.writeFileSync(goFile, "");
  return child;
}

function record(events, name, child, stream) {
  stream.on("data", chunk => events.push(`${name}:data:${chunk}`));
  child.on("exit", () => events.push(`${name}:exit`));
}

// One after the other, let each child write and die while this process stays off its event loop.
async function whileOffTheLoop(children) {
  setTimeout(() => {
    for (const child of children) {
      child.release();
      blockUntilDead(child.pid);
    }
    blockUntilExitsArePosted();
  }, 0);
  await Promise.all(children.map(child => once(child, "close")));
}

const scenarios = {
  // A child writes to its stderr and exits while the parent reads that pipe.
  async stderr() {
    const events = [];
    const child = writer(2, "last", ["ignore", "ignore", "pipe"]);
    record(events, "child", child, child.stderr);
    await whileOffTheLoop([child]);
    return events;
  },

  // A child writes to a pipe above the standard three and exits before the parent looks at it.
  async lateListenerOnFd3() {
    const events = [];
    const child = spawn("/bin/sh", ["-c", "printf last >&3"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    blockUntilDead(child.pid);
    blockUntilExitsArePosted();
    record(events, "child", child, child.stdio[3]);
    await once(child, "close");
    return events;
  },

  // The same, and the 'data' listener runs another child to completion before the exit is
  // reported. That wait has its own event loop in bun, which must leave this exit alone.
  async execSyncBeforeTheExitIsReported() {
    const events = [];
    const child = spawn("/bin/sh", ["-c", "printf last >&3"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    blockUntilDead(child.pid);
    blockUntilExitsArePosted();
    child.stdio[3].on("data", chunk => {
      events.push(`child:data:${chunk}`);
      events.push(`execSync:${execSync("echo returned", { encoding: "utf8" }).trim()}`);
    });
    child.on("exit", () => events.push("child:exit"));
    await once(child, "close");
    return events;
  },

  // Two children die one after the other, and the parent sees both in one batch: the output of
  // both arrives before the exit of either.
  async twoChildren() {
    const events = [];
    const a = writer(1, "a", ["ignore", "pipe", "ignore"]);
    const b = writer(1, "b", ["ignore", "pipe", "ignore"]);
    record(events, "a", a, a.stdout);
    record(events, "b", b, b.stdout);
    await whileOffTheLoop([a, b]);
    return events;
  },

  // A forked child sends a message and exits.
  async forkMessage() {
    const events = [];
    const child = fork(__filename, ["forkChild"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    child.on("message", message => events.push(`child:message:${message}`));
    child.on("exit", () => events.push("child:exit"));
    blockUntilDead(child.pid);
    blockUntilExitsArePosted();
    await once(child, "close");
    return events;
  },
};

scenarios[process.argv[2]]().then(events => console.log(JSON.stringify(events)));
