import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const home = os.homedir();
const agent = path.join(home, ".pi/agent");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
let failures = 0;
async function check(name, action) {
  try { console.log(`OK ${name}: ${await action()}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}

await check("Pi CLI", () => {
  const version = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
  if (version !== "1.3.0") throw Error(`Expected 1.3.0, found ${version}`);
  return version;
});
await check("扩展版本", () => {
  const settings = read(path.join(agent, "settings.json"));
  for (const item of settings.packages) {
    if (typeof item !== "string" || !item.startsWith("npm:")) continue;
    const spec = item.slice(4), split = spec.lastIndexOf("@");
    const name = spec.slice(0, split), version = spec.slice(split + 1);
    const installed = read(path.join(agent, "npm/node_modules", name, "package.json"));
    if (installed.version !== version) throw Error(`${name}: expected ${version}, found ${installed.version}`);
  }
  return `${settings.packages.length} configured packages`;
});
await check("Web / 权限 fork", () => {
  const current = read(path.join(home, ".local/share/pi-web-fork/current.json"));
  const pkg = read(path.join(current.release, "package.json"));
  const sdks = Object.entries(pkg.dependencies).filter(([name]) => name.startsWith("@earendil-works/"));
  if (sdks.some(([, version]) => version !== "1.3.0")) throw Error("Web SDK versions do not match CLI 1.3.0");
  if (fs.realpathSync(current.globalPackage) !== fs.realpathSync(current.release)) throw Error("Global Web launcher points to another release");
  require(path.join(current.release, "bin/pi-web-fork-packages.cjs")).verify(agent, current.release);
  return `${pkg.version}, SDK 1.3.0, release ${current.commit.slice(0, 12)}, hashes verified`;
});
await check("主模型 / 审核模型", () => {
  const settings = read(path.join(agent, "settings.json"));
  const reviewer = read(path.join(agent, "extensions/pi-auto-review/config.json"));
  if (reviewer.classifier?.model !== "magpie-jev/home-m4/typesafe/jev-latest") throw Error("Jev permission classification is not enabled");
  return `${settings.defaultProvider}/${settings.defaultModel}; classifier ${reviewer.classifier.model} (threshold ${reviewer.classifier.minConfidence}); reviewer ${reviewer.model} (reasoning ${reviewer.reasoning})`;
});
await check("Jev 适配器", () => {
  const config = read(path.join(agent, "magpie-jev.json"));
  if (digest(path.join(project, "extensions/magpie-jev.ts")) !== digest(path.join(agent, "extensions/magpie-jev.ts"))) {
    throw Error("Installed adapter differs from this workspace");
  }
  const tools = read(path.join(agent, "settings.json")).defaultTools ?? [];
  if (!tools.includes("+codemode") && !tools.includes("codemode")) throw Error("codemode is not explicitly enabled");
  return `magpie-jev/${config.model}`;
});
await check("Pi Web", async () => {
  const result = await fetch("http://127.0.0.1:30141/api/agent/running", { signal: AbortSignal.timeout(3000) });
  if (!result.ok) throw Error(`HTTP ${result.status}`);
  const state = await result.json();
  return `${state.runningSessionIds.length} active, ${state.awaitingInputSessionIds.length} awaiting input`;
});

// Opt-in: one tiny billable classification, using the existing local gateway key.
if (process.argv.includes("--jev")) {
  await check("Jev 实际请求", async () => {
    const gateway = read(path.join(agent, "models.json")).providers.magpie;
    const config = read(path.join(agent, "magpie-jev.json"));
    if (typeof gateway.apiKey !== "string" || gateway.apiKey.startsWith("!")) {
      throw Error("Use /jev check in Pi to resolve command-based credentials");
    }
    const key = gateway.apiKey.replace(/\$\{([A-Za-z_][A-Za-z_0-9]*)\}|\$([A-Za-z_][A-Za-z_0-9]*)/g,
      (_, a, b) => process.env[a || b] || "");
    const start = Date.now();
    const response = await fetch(gateway.baseUrl.replace(/\/$/, "") + "/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: config.model,
        state: { message: "Two plus two equals four." },
        questions: { correct: { type: "noul", instructions: "Is the arithmetic statement correct?" } },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw Error(`Gateway returned HTTP ${response.status}`);
    const result = await response.json();
    const probability = result.answers?.correct?.noul;
    if (typeof probability !== "number" || probability < 0.9 || probability > 1) throw Error("Unexpected classification result");
    return `${result.model}, p=${probability}, ${Date.now() - start} ms`;
  });
}
process.exitCode = failures ? 1 : 0;
