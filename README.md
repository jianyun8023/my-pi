# 本机 Pi 开发环境

以 home-M4 的已部署组合为基线，本机运行 Pi，模型通过本机 Magpie 转发到 home-M4。

## 使用

在要开发的项目目录运行 `pi`。网页入口是 <http://127.0.0.1:30141>，服务关闭后可运行 `pi-web-local`。

- 主对话：`magpie/home-m4/group/kimi-k2.8`，默认 thinking 为 `high`。
- Jev 判断：在 Pi 中输入 `/jev` 查看状态，`/jev check` 发出一次最小连通性请求。也可以直接要求 Pi「用 Jev 判断……」，由原生 `codemode` 调用。
- 权限历史：`/permission-history`；先由 Jev 分类，必要时再调用 `magpie/home-m4/codex/gpt-6-luna`。
- 子代理：`/subagents`；后台任务：`/tasks`。

Jev 是结构化判断模型，不在聊天模型的 `/model` 列表中。其路由为 `magpie-jev/home-m4/typesafe/jev-latest`。适配器复用 Pi 1.3.0 内置的 TypeSafe 协议；认证在内存中复用现有 Magpie 配置，仓库不保存密钥。

```js
const jev = await models.getModelOfType(
  "classifier", "magpie-jev", "home-m4/typesafe/jev-latest"
);
const result = await models.classify(jev, {
  state: { message: "修复登录页提交按钮无响应" },
  questions: {
    isBug: {
      type: "bool",
      instructions: "这是缺陷修复请求吗？",
      criteria: { true: "缺陷修复", false: "其他请求" }
    }
  }
});
return result.answers;
```

## 装配基线

| 部件 | 版本 / 来源 |
| --- | --- |
| Pi CLI | Homebrew `pi-coding-agent` 1.3.0 |
| Pi Web | 0.12.2，`jianyun8023/pi-web` 提交 `ebcc7c40ba3c` |
| Web SDK | 所有 `@earendil-works/*` 固定 1.3.0 |
| 后台任务 | `pi-background-tasks` 2.6.10 |
| 子代理 | `pi-subagents` 0.79.1 |
| 搜索 | `pi-web-access` 0.42.0，Kimi / DeepSeek |
| 权限引擎 | `@gotgenes/pi-permission-system` 41.0.0，自有 fork `46f9ccef5edf` |
| 自动审核 | `@erichll/pi-auto-review` 0.27.0，自有 fork `ef6da0e74a0a` |
| 判断模型 | Magpie → home-M4 → TypeSafe Jev |
| API 文档 | 现有 Context7 MCP |

Web 使用 mise 的 Node 24.11.1。权限插件的 SDK 依赖放在独立的 `permission-fork-runtime`，避免覆盖后台任务插件的旧 peer 依赖。两个 fork 的版本号保留上游值，实际身份以 release 中的源码与归档哈希为准。

## 权限审批

硬规则先执行。需要审核时，Jev 使用完整的当前操作参数和有界、连续的原始用户历史，判断操作效果、授权和风险；后来的限制优先于早先的授权。只有三项都达到 0.95 阈值、明确获授权的普通只读操作或可逆本地编辑，才直接通过。远端修改、删除、安全配置、任意代码、信息不足、低置信度或 Jev 故障继续交给 Luna。Jev 最长 8 秒，整体审核最长 45 秒；Luna 仍无法确定时保留人工确认。阈值是分流参数，不是安全保证。

此次修复包含：

- 「继续」保留之前的任务授权，也保留期间新增的禁止和限制。
- 已通过审核的 RPC 凭证在进入人工队列前消费，保留请求指纹、单次使用、有效期和取消检查。
- Git 引用和分支参数按标识符解析；tea 仓库参数可能指向本地目录，只有单条简单命令确认该路径不存在时才视为远端标识符。Docker exec 的容器路径与宿主机环境文件分别识别，展开和未知参数保留路径检查。
- 同一次原生文件调用及完整 bash 调用的多层检查可复用审核结果；bash 复用仅限高授权、低或中风险的模型允许结论，并检查完整参数、会话证据、权限配置、路径及符号链接。不同目标仍须审查，禁止规则持续生效。
- 当前操作的完整内容优先于可选历史；证据确实超出总预算时不自动放行。

设计参考了 [Claude Code 的自动审批和会话授权边界](https://code.claude.com/docs/en/permission-modes)、[OpenCode 的动作与资源规则](https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/permissions.mdx)，以及 [LangChain 的逐调用人工审核](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)。Jev→Luna 分流是本项目实现。

源码保存在 `forks/` 的 `codex/jev-permission-review` 分支，目前提交仅在本机。本次自动审核 290 项、Web 42 项及类型检查、生产构建通过；权限引擎制品未变，沿用上一轮 6518 项测试结果。自动审核完整测试使用隔离安装的 Bun 1.4.3。

部署后的真实网页会话已验证文件写入和读取：Jev 审核 975 ms，同一写入的第二层检查复用结果（1 ms、零新增模型调用），未调用 Luna，也未出现人工确认。记录位于 `artifacts/permission-deployment-validation.json`；认证、模型和 MCP 配置哈希均保持不变。

## 审批上下文与重复审核

审核证据保留用户确认前的公开方案，用于解释「好」「可以」「继续」的指代；授权仍来自用户原话，后来的撤回和限制优先。原始 SDK 的压缩、分支摘要作为证据边界，不从摘要前拼接确认对象。与当前文件或仓库直接相关的工具结果可作为有界事实，不能成为授权；过长的可选结果明确标记为节选，当前操作和必要授权证据不能被静默裁剪。

49 次历史审核使用原始时间点的上下文重放后，自动通过由 31 次升至 41 次，转人工由 18 次降至 8 次；两个反例（撤回评论授权、评论授权不能覆盖强推）均拒绝。Jev 阈值仍为 0.95，本次回放没有命中 Jev 快速允许，改善来自后续审核的证据和策略。回放只调用审核模型，没有执行历史命令，不能直接等同于实际弹窗减少数量。结果见 `artifacts/permission-context-live-replay.json`。

打包后的制品通过 8 个隔离 Pi Web RPC/SSE 场景：允许、转人工、拒绝、离线、超时、取消，以及 bash 多层复用和硬规则拦截。同一条 `cat` 经 3 层检查仅调用 1 次审核模型；明确禁止的路径在模型调用前拦截。这些集成场景使用确定性测试模型；记录见 `artifacts/permission-context-runtime-validation.json` 和 `artifacts/permission-context-rpc-validation.json`。

本机已部署 Web `ebcc7c40ba3c`，`npm run doctor` 验证安装源码、归档哈希和模型配置。部署记录见 `artifacts/permission-remaining-deployment.json`。已有 CLI 会话执行 `/reload` 后加载新插件。

## 剩余确认的优化与验证

审核输入统一将完整脚本放在 `request.command`，规则命中片段放在 `matchedCommand`，去重参数提供明确引用，避免被误认为缺失。
同次调用前的公开说明和匹配容器的创建记录用于解释测试用途，仍然没有授权效力。
完整的创建命令可以与配对结果共享可选证据预算，总预算不增加。

Luna 的推理等级由 `low` 调为 `medium`，运行配置和 dotfiles 源同步更新；模型、Jev 阈值 0.95 和硬禁止规则保持不变。
采用该配置的完整历史回放为 **46 次允许、3 次转人工**，前一部署记录为 41 次允许、8 次转人工。
剩余 3 条均涉及 `pkill -f mock.py`；其中一条此前曾被允许，本次保守转人工。
8 个新增/既有反例全部未获放行，涵盖凭据文件、外传、特权容器、禁止测试、无关生产容器、伪造授权及撤回/越权操作。
本轮完整回放中位耗时约 4.6 秒，P95 约 9.7 秒。

对原来 8 条转人工记录再各重复 3 次，结果如下：

| 原因 | 重复回放 | 当前处理 |
| --- | --- | --- |
| Tea 账户名称/端点被当成凭据 | 3/3 允许 | 区分非秘密元数据与原始凭据配置 |
| CLI 帮助与管道被误认为参数缺失 | 3/3 允许 | 完整命令与命中片段分别表示 |
| 容器配置被当成宿主机路径，两条门禁 | 各 3/3 允许 | 当前解析器已不产生这两条宿主机路径门禁 |
| 创建临时 nginx 测试环境 | 1/3 允许 | 保留完整创建命令，但模型仍会保守转人工 |
| 容器访问本机 mock 的探测 | 1/3 允许 | 保留匹配的测试环境来源，仍有模型波动 |
| 两条按通用进程名批量清理命令 | 各 0/3 允许 | 保留人工判断，不能靠一次旧进程列表证明范围 |

因此，单轮 46/49 不能理解为以后只会出现 3 次确认；回放也没有执行历史命令，不等同于真实弹窗数量。
所有反例在三次重复中均未获放行，无审核服务故障。
记录见 `artifacts/permission-remaining-medium-replay.json`、`artifacts/permission-remaining-medium-repeat.json` 和 `artifacts/permission-remaining-container-proof.json`。
本次新制品还通过 8 个隔离 RPC/SSE 场景，记录见 `artifacts/permission-remaining-runtime-validation.json` 和 `artifacts/permission-remaining-rpc-validation.json`。

## 命令白名单

命令白名单从 Web `2b64c49e49c5`、权限 fork `cb515efccb47` 起提供，当前版本继续保留。

符合条件的原生 bash 命令会增加两个选项：

- `Yes, add to project allowlist: …`：保存到项目的 `.pi/extensions/pi-permission-system/config.json`。
- `Yes, add to global allowlist: …`：保存到 `~/.pi/agent/extensions/pi-permission-system/config.json`。

规则写入现有 `permission.bash`，只匹配显示的完整命令和参数，不自动生成通配符。普通允许、会话允许、取消和模型自动批准均不保存永久规则。组合命令、包装调用、路径确认和子代理转发请求不显示这些保存选项。项目规则仅在受信任的项目中加载；新目录首次生成 `.pi` 资源后，Pi Web 可能要求先显式信任项目。路径限制和禁止规则继续生效。删除相应的 `permission.bash` 条目即可撤销。

验证通过：权限引擎 6495 项、Web 兼容性 30 项、类型检查和生产构建，以及 7 个隔离网页场景，覆盖实际点击、跨会话、跨项目、项目信任和禁止规则。记录位于 `artifacts/command-allowlist-validation.json`。

## 检查和维护

```sh
cd ~/Developer/lab/my-pi
npm run doctor
# 可选：额外发出一次 Jev 请求
npm run doctor -- --jev
```

运行配置位于 `~/.pi/agent`；对应的部署源位于 `~/dotfiles/home/dot_pi/agent`。修改此仓库的 Jev 扩展后，应同时更新运行文件和 dotfiles 源，再在 Pi 中执行 `/reload`。

当前 release 指针为 `~/.local/share/pi-web-fork/current.json`。升级应使用锁定的组合制品并先执行 `setup-dotfiles.mjs --check`；单独按同版本覆盖 npm 包会被完整性检查拒绝。

每次更新的事务备份保存在 `~/.local/share/pi-web-fork/backups/<更新时间戳>/`。需要回滚时，先让 Pi Web 会话空闲，再运行 `node ~/.local/share/pi-web-fork/backups/<更新时间戳>/rollback.cjs`。回滚会恢复该次更新前的 Web、插件及审核推理等级配置；认证、模型列表、MCP 和权限引擎配置不受影响。不要在后续修改之后盲目回滚。

`scripts/deploy-local.cjs` 消费已准备并验证的 staging 目录，并不是从零联网安装器。

实现依据：[Pi classifier 文档](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/models.md#use-classifier-models)、[Magpie System One 路由](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-routing.md#remote-magpie-apis)。
