import fs from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Reuse the gateway's existing credentials in memory. Magpie owns their storage.
// Jev stays a classifier; it does not replace the chat model or permission policy.
export default function magpieJev(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const config = JSON.parse(fs.readFileSync(path.join(agentDir, "magpie-jev.json"), "utf8"));
  const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
  const gateway = models.providers?.magpie;
  if (!gateway?.baseUrl || !gateway?.apiKey || typeof config.model !== "string" || !config.model.trim()) {
    throw new Error("Jev requires the existing Magpie provider and magpie-jev.json model route.");
  }

  const baseUrl = new URL(gateway.baseUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error("Unsupported Magpie gateway URL.");
  }

  const provider = "magpie-jev";
  const modelId = config.model;
  pi.on("session_start", async (_event, ctx) => {
    const catalog = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
    const native = ctx.modelRegistry.getProvider("typesafe");
    if (!catalog || !native?.classify) {
      throw new Error("Pi's built-in Jev classifier is missing; Pi 1.3.0 is required.");
    }
    pi.registerProvider(provider, {
      name: "Jev via Magpie",
      baseUrl: baseUrl.toString(),
      apiKey: gateway.apiKey,
      headers: gateway.headers,
      models: [{
        type: "classifier",
        id: modelId,
        name: "Jev · Magpie",
        api: catalog.api,
        input: catalog.input,
        contextWindow: catalog.contextWindow,
        cost: catalog.cost,
      }],
      classifiers: {
        [catalog.api]: { classify: (model, context, options) => native.classify!(model, context, options) },
      },
    });
  });

  pi.registerCommand("jev", {
    description: "查看 Jev 权限分类配置；/jev check 执行一次最小连通性检查",
    handler: async (args, ctx) => {
      const model = ctx.modelRegistry.findOfType("classifier", provider, modelId);
      if (!model) {
        ctx.ui.notify("Jev 未注册，请 /reload 后重试。", "error");
        return;
      }
      if (args.trim() !== "check") {
        let review: { classifier?: { model?: string }; model?: string } = {};
        try { review = JSON.parse(fs.readFileSync(path.join(agentDir, "extensions/pi-auto-review/config.json"), "utf8")); } catch { /* Optional reviewer configuration. */ }
        const status = review.classifier?.model === `${provider}/${modelId}`
          ? `权限审核已启用 Jev 分类，必要时交给 ${review.model}。`
          : "权限审核尚未启用此 Jev 路由。";
        ctx.ui.notify(`Jev: ${provider}/${modelId}\n${status}\n/jev check 检查连接；也可通过 codemode 的 models.classify() 调用。`, "info");
        return;
      }
      const start = Date.now();
      const result = await ctx.modelRegistry.classify(model, {
        state: { message: "Two plus two equals four." },
        questions: {
          correct: {
            type: "bool",
            instructions: "Is the arithmetic statement correct?",
            criteria: { true: "Correct", false: "Incorrect" },
          },
        },
      }, { signal: AbortSignal.timeout(20_000) });
      if (result.stopReason !== "stop") {
        ctx.ui.notify(`Jev 连接失败：${result.errorMessage ?? "未知错误"}`, "error");
        return;
      }
      ctx.ui.notify(`Jev 已连通（${Date.now() - start} ms）：${JSON.stringify(result.answers)}`, "info");
    },
  });
}
