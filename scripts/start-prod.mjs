import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const npx = isWindows ? "npx.cmd" : "npx";
const node = isWindows ? "node.exe" : "node";
const port = process.env.PORT || "3000";

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });

  return child;
}

function waitFor(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command exited with code ${code}`));
      }
    });
  });
}

await waitFor(run(npx, ["prisma", "migrate", "deploy"]));

const poller = run(node, ["scripts/poll-servers-loop.mjs"]);
const next = run(npx, ["next", "start", "-H", "0.0.0.0", "-p", port]);

function shutdown() {
  poller.kill("SIGTERM");
  next.kill("SIGTERM");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await waitFor(next);
