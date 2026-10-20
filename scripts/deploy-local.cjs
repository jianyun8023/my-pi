// Activate a verified release with a recoverable local transaction.
// Input: a prepared staging directory containing release/, agent/npm and plan.json.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");

const home = os.homedir();
const agent = path.join(home, ".pi/agent");
const base = path.join(home, ".local/share/pi-web-fork");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
};
const hash = file => fs.existsSync(file)
  ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
process.env.PATH = path.dirname(process.execPath) + path.delimiter + process.env.PATH;

async function idle() {
  const response = await fetch("http://127.0.0.1:30141/api/agent/running", { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw Error("Cannot inspect existing Pi Web sessions.");
  const state = await response.json();
  if (state.runningSessionIds.length || state.awaitingInputSessionIds.length) {
    throw Error("Pi Web has active work or a pending approval; retry when idle.");
  }
}

async function stop(pid) {
  const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  const installedLauncher = path.join(path.dirname(process.execPath), "pi-web");
  if (!command.includes("/bin/pi-web.js ") && !command.includes(installedLauncher + " ")) {
    throw Error("Pi Web launcher identity changed.");
  }
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch("http://127.0.0.1:30141/api/agent/running", { signal: AbortSignal.timeout(250) });
    } catch { return; }
    await delay(100);
  }
  throw Error("Previous Pi Web process has not stopped.");
}

function launch(root, log) {
  const fd = fs.openSync(log, "a", 0o600);
  const child = spawn(process.execPath, [path.join(root, "bin/pi-web.js"), "--hostname", "127.0.0.1", "--port", "30141", "--no-open"], {
    cwd: home,
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_WEB_SKIP_VERSION_CHECK: "1" },
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  child.unref();
  return child.pid;
}

async function healthy() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:30141/api/agent/running", { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* Wait for the new listener. */ }
    await delay(150);
  }
  throw Error("New Pi Web did not become healthy.");
}

function launcher() {
  const directory = path.join(agent, "pi-web-run");
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const record = read(path.join(directory, name));
    if (record.port !== 30141) continue;
    try { process.kill(record.pid, 0); return record.pid; } catch { /* Stale run record. */ }
  }
  throw Error("No live Pi Web launcher record for port 30141.");
}

async function activate(backup, state, transaction, journal) {
  const { release, globalPackage, protectedFiles } = state;
  await idle();
  fs.copyFileSync(__filename, path.join(backup, "deploy-local.cjs"));
  await stop(launcher());
  let pid;
  try {
    transaction.apply(journal);
    require(path.join(release, "bin/pi-web-fork-packages.cjs")).verify(agent, release);
    execFileSync(process.execPath, [path.join(agent, "bin/setup-dotfiles.mjs"), "--check"], { stdio: "inherit" });
    for (const [name, before] of Object.entries(protectedFiles)) {
      if (hash(path.join(agent, name)) !== before) throw Error(`${name} unexpectedly changed.`);
    }
    pid = launch(release, path.join(backup, "server.log"));
    await healthy();
    save(path.join(base, "current.json"), { ...read(path.join(base, "current.json")), launcherPid: pid });
    console.log(JSON.stringify({ installed: true, release, backup, pid, url: "http://127.0.0.1:30141" }));
  } catch (error) {
    if (pid) { try { await stop(pid); } catch { /* May already have exited. */ } }
    transaction.rollback(journal);
    launch(globalPackage, path.join(backup, "rollback-server.log"));
    await healthy();
    throw error;
  }
}

async function main() {
  if (process.argv[2] === "--resume") {
    const backup = path.resolve(process.argv[3]);
    const state = read(path.join(backup, "deployment.json"));
    const transaction = require(path.join(state.release, "bin/pi-web-release-state.cjs"));
    const journal = transaction.load(backup);
    if (journal.phase !== "prepared") throw Error("Only a prepared transaction can resume.");
    const npmEntry = journal.entries.find(entry => entry.target === path.join(agent, "npm"));
    const staging = path.dirname(path.dirname(npmEntry.replacement));
    const plan = read(path.join(staging, "plan.json"));
    if (plan.changes.some(change => hash(change.target) !== change.before)) throw Error("Configuration changed since preparation.");
    if (hash(path.join(agent, "npm/package.json")) !== plan.npmManifest || hash(path.join(agent, "npm/package-lock.json")) !== plan.npmLock) {
      throw Error("Extension packages changed since preparation.");
    }
    await activate(backup, state, transaction, journal);
    return;
  }
  if (process.argv[2] === "--rollback") {
    const backup = path.resolve(process.argv[3]);
    const state = read(path.join(backup, "deployment.json"));
    const transaction = require(path.join(state.release, "bin/pi-web-release-state.cjs"));
    const journal = transaction.load(backup);
    if (journal.phase === "rolled_back") return console.log("Already rolled back.");
    await idle();
    await stop(launcher());
    transaction.rollback(journal);
    const pid = launch(state.globalPackage, path.join(backup, "rollback-server.log"));
    await healthy();
    console.log(JSON.stringify({ rolledBack: true, pid }));
    return;
  }

  if (!process.argv[2]) throw Error("Usage: node scripts/deploy-local.cjs <prepared-stage>");
  const staging = path.resolve(process.argv[2]);
  const plan = read(path.join(staging, "plan.json"));
  const globalPackage = path.join(execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim(), "@agegr/pi-web");
  const release = path.join(base, "releases", plan.commit.slice(0, 12));
  if (fs.existsSync(release)) throw Error("Release already exists; inspect before redeploying.");
  for (const change of plan.changes) {
    if (![agent + path.sep, path.join(home, "dotfiles") + path.sep].some(root => change.target.startsWith(root))) {
      throw Error("Unexpected deployment target.");
    }
    if (hash(change.target) !== change.before) throw Error(`Changed since preparation: ${change.target}`);
  }
  if (hash(path.join(agent, "npm/package.json")) !== plan.npmManifest || hash(path.join(agent, "npm/package-lock.json")) !== plan.npmLock) {
    throw Error("The installed extension package tree changed since preparation.");
  }
  await idle();
  const oldPid = launcher();
  const protectedFiles = Object.fromEntries(["auth.json", "models.json", "mcp.json"].map(name => [name, hash(path.join(agent, name))]));
  const backup = path.join(base, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(path.dirname(release), { recursive: true });
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  fs.renameSync(path.join(staging, "release"), release);

  // Make the isolated dependency lock portable to its final runtime directory.
  const runtime = path.join(staging, "agent/npm/permission-fork-runtime");
  const manifest = read(path.join(release, "vendor/permission-bundle.json"));
  const fileReference = value => {
    if (typeof value === "string" && value.startsWith("file:") && value.endsWith(".tgz")) {
      return "file:" + path.relative(path.join(agent, "npm/permission-fork-runtime"), path.join(release, "vendor", path.basename(value)));
    }
    if (Array.isArray(value)) return value.map(fileReference);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fileReference(item)]));
    return value;
  };
  for (const name of ["package.json", "package-lock.json"]) save(path.join(runtime, name), fileReference(read(path.join(runtime, name))));
  require(path.join(release, "bin/pi-web-fork-packages.cjs")).verify(path.join(staging, "agent"), release);

  const globalLink = path.join(staging, "global-package");
  fs.symlinkSync(release, globalLink);
  const pointer = path.join(staging, "current.json");
  save(pointer, {
    sourceRepository: "https://github.com/jianyun8023/pi-web",
    copiedFrom: plan.copiedFrom ?? "home-m4",
    release, backup, globalPackage, commit: plan.commit,
    permissionBundle: manifest.packages, piSdk: manifest.piSdk,
  });
  const changes = [
    { target: path.join(agent, "npm"), replacement: path.join(staging, "agent/npm") },
    ...plan.changes,
    { target: globalPackage, replacement: globalLink },
    { target: path.join(base, "current.json"), replacement: pointer },
  ];
  for (const change of changes) fs.mkdirSync(path.dirname(change.target), { recursive: true });
  const transaction = require(path.join(release, "bin/pi-web-release-state.cjs"));
  const journal = transaction.prepare(backup, changes);
  save(path.join(backup, "deployment.json"), { release, globalPackage, oldPid, protectedFiles });
  fs.copyFileSync(__filename, path.join(backup, "deploy-local.cjs"));
  fs.writeFileSync(path.join(backup, "rollback.cjs"), `process.argv[2]="--rollback";process.argv[3]=__dirname;require("./deploy-local.cjs");\n`, { mode: 0o600 });

  await activate(backup, { release, globalPackage, protectedFiles }, transaction, journal);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
