/**
 * This test runs under `bun test` and (via node:test/node:assert) under
 * `node --experimental-strip-types --test`, which checks the expected order against node.
 *
 * libuv runs child-exit callbacks after the other I/O of the poll batch that carried the exit
 * (uv__io_poll runs signal watchers last, kqueue's EVFILT_PROC only flags for uv__wait_children).
 * So what a child wrote before it died reaches its listeners before 'exit' when both are pending
 * at once. The fixture keeps the parent off its event loop until the children are dead, which
 * puts their output and their exits in one batch.
 */
import assert from "node:assert";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const fixture = path.join(import.meta.dirname, "fixtures", "child-process-exit-after-stdio-fixture.js");

const transports = [{ name: "default", env: {} }];
if (process.versions.bun && process.platform === "linux") {
  // Without pidfd_open (gVisor, seccomp filters, kernels before 5.6) bun reaps children on a
  // waiter thread. The flag is only read when BUN_GARBAGE_COLLECTOR_LEVEL is set.
  transports.push({
    name: "waiter thread",
    env: {
      BUN_FEATURE_FLAG_FORCE_WAITER_THREAD: "1",
      BUN_GARBAGE_COLLECTOR_LEVEL: process.env.BUN_GARBAGE_COLLECTOR_LEVEL ?? "0",
    },
  });
}

const runInWorker = `new (require("node:worker_threads").Worker)(process.argv[1], { argv: [process.argv[2]] })`;

for (const { name, env } of transports) {
  describe(`exit notification: ${name}`, { skip: process.platform === "win32" }, () => {
    async function events(scenario, { worker = false } = {}) {
      const { stdout } = await execFileP(
        process.execPath,
        [...(worker ? ["-e", runInWorker] : []), fixture, scenario],
        {
          env: { ...process.env, BUN_DEBUG_QUIET_LOGS: "1", ...env },
        },
      );
      return JSON.parse(stdout);
    }

    // Which child comes first is not fixed, in node either.
    function assertOutputOfBothBeforeExitOfEither(twoChildren) {
      assert.deepStrictEqual([...twoChildren].sort(), ["a:data:a", "a:exit", "b:data:b", "b:exit"]);
      assert.deepStrictEqual(
        twoChildren.map(event => event.split(":")[1]),
        ["data", "data", "exit", "exit"],
      );
    }

    test("'data' of a pipe the child wrote before it died comes before 'exit'", async () => {
      assert.deepStrictEqual(await events("stderr"), ["child:data:last", "child:exit"]);
    });

    test("'data' of stdio[3] comes before 'exit' for a listener added after the child died", async () => {
      assert.deepStrictEqual(await events("lateListenerOnFd3"), ["child:data:last", "child:exit"]);
    });

    test("execSync in that 'data' listener returns before the exit is reported", async () => {
      assert.deepStrictEqual(await events("execSyncBeforeTheExitIsReported"), [
        "child:data:last",
        "execSync:returned",
        "child:exit",
      ]);
    });

    test("the output of every child that died in one batch comes before the exit of any", async () => {
      assertOutputOfBothBeforeExitOfEither(await events("twoChildren"));
    });

    test("the same holds on the event loop of a Worker", async () => {
      assertOutputOfBothBeforeExitOfEither(await events("twoChildren", { worker: true }));
    });

    test("a message a forked child sent before it exited comes before 'exit'", async () => {
      assert.deepStrictEqual(await events("forkMessage"), ["child:message:last", "child:exit"]);
    });
  });
}
