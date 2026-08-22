# CodexPro 维护者学习指南

这份文档不是发布说明，而是把 2026-08-22 这轮 CodexPro 改造里真正值得长期掌握的工程知识沉淀下来。目标是让维护者不仅知道“现在能用了”，还知道为什么这样设计、以后遇到类似问题怎么判断。

## 1. 先建立一个总模型：连接状态、业务状态、代码状态要分开

这轮改造最核心的认识是：不要把所有“状态”都混成一个 session。

CodexPro 里至少有三类完全不同的状态：

1. **Transport state**：ChatGPT 和 MCP HTTP 服务之间的一次连接/协议状态。
2. **Business state**：当前操作的是哪个 workspace、哪个 task、哪个 job。
3. **Repository state**：Git branch、HEAD、working tree、index、未提交修改。

旧实现把一部分业务行为依赖在 HTTP session 上，例如“某个 session 选中了哪个 workspace”。这会导致 bridge 一重启，内存 transport session 消失，业务上下文也跟着变得不可靠。

现在的规则是：

- HTTP `/mcp` 本身 stateless；
- `workspace_id`、`task_id`、`job_id` 等显式 handle 承载业务上下文；
- Git 状态只交给 Git；
- 运行态持久化数据放仓库外，不把连接生命周期当数据库。

一个通用判断原则：

> 如果某个信息在进程重启后仍然应该成立，它就不应该只存在于 transport session 内存里。

## 2. 为什么最终选择 Stateless MCP，而不是“自动复活 Session”

最初看起来，最直观的修复是：server 重启以后让 client 自动 initialize，或者把旧 session 存进 SQLite/Redis 再恢复。

但继续推演后会发现，保存 transport session 往往是在恢复一个本来就不该持久化的东西。

这轮最终做法是：

- 单一 `/mcp` 使用 MCP 2026 stateless handler；
- 不维护 transport map；
- 不维护 session TTL/capacity/prune；
- 不依赖 `Mcp-Session-Id` 选状态；
- 升级时收到旧 `Mcp-Session-Id` header 只忽略，不用它恢复任何服务端对象。

这个方案的重要收益不是“少一个 session bug”，而是**减少故障模式**：

- bridge 重启不需要 session 恢复；
- 多 client 不需要隔离各自的 selected workspace 内存；
- 无需设计 session GC；
- 无需考虑 session 持久化版本兼容；
- 不会把“连接还活着”和“业务状态正确”混为一谈。

工程上经常有一个反直觉原则：

> 能删除的状态，比能恢复的状态更可靠。

## 3. 显式 Workspace Handle：为什么比“记住当前项目”更稳

旧习惯类似：

```text
open_workspace(A)
read("src/index.ts")
```

第二步隐含依赖“服务端还记得 A”。这种 API 很方便，但跨重启、跨 client、并发时容易出问题。

现在更推荐：

```text
open_workspace(A)
=> workspace_id = ws_xxx

read(workspace_id=ws_xxx, path="src/index.ts")
```

同时保留一条实用规则：

- 省略 `workspace_id` = 使用配置的默认 workspace；
- 非默认项目 = 显式传稳定 `workspace_id`。

稳定 `workspace_id` 由 canonical root 派生，因此同一个项目在 bridge 重启后还是同一个逻辑 workspace。

这类设计可以迁移到很多系统：

- 文件处理任务使用 `job_id`；
- 长任务使用 `task_id`；
- 数据导入使用 `import_id`；
- 部署环境使用 `environment_id`。

本质上都是把“当前选择”变成“显式引用”。

## 4. Direct Tools 和 Agent 的正确分工

这轮真实使用最明显的结论是：**不是所有开发任务都值得启动 Agent。**

推荐分层：

### 第一层：确定性 Direct Tools

适合：

- read/search/edit/apply_patch；
- Git 操作；
- syntax check；
- workspace/work unit；
- 固定格式的服务查询。

特点：输入/输出 schema 明确、失败模式少、速度快、token 成本低。

### 第二层：受控 Bash

适合：

- build；
- test；
- lint；
- typecheck；
- 项目已有脚本。

原则是让 Bash 负责“调用已有确定性工具链”，而不是把所有开发能力重新退化成任意 shell。

### 第三层：Agent

适合：

- 大范围重构；
- 方案探索；
- 复杂代码审查；
- 大量跨文件理解；
- 需要多步推理、无法预先定义完整操作序列的任务。

经验判断：

> 如果任务能被清楚描述成一个稳定的 typed operation，就优先做成 Direct Tool，而不是让 Agent 每次重新推理怎么完成它。

## 5. Git 为什么应该成为一等公民能力

过去大量 Git 操作通过 Bash，容易产生几个问题：

- 安全策略和 Bash schema 不一致；
- partial stage 很难稳定表达；
- `.git/index.lock`、沙箱权限等失败容易被误判成代码问题；
- 模型必须反复拼 Git 命令。

因此新增了：

- `git_switch`
- `git_create_branch`
- `git_stage`
- `git_stage_hunks`
- `git_commit`
- `git_merge`
- `git_stash`
- `git_restore`

这里最有学习价值的是 `git_stage_hunks`。

它不是简单执行 `git apply --cached`，而是：

1. `git apply --reverse --check`：验证 patch 对应的修改确实已经存在于 working tree；
2. `git apply --cached --check`：验证当前 index 能接受这个 patch；
3. `git apply --cached`：只修改 index。

这样能减少“模型构造了一个并不存在于工作区的 patch，却直接写进 index”的风险。

## 6. 确认机制：不要让安全策略和 Tool Schema 打架

曾经出现过一种典型坏设计：

- 服务端说“这个操作需要 confirm”；
- 但工具 schema 根本没有 `confirm` 参数。

这会让客户端永远无法按协议完成操作。

这轮收敛后的原则是：

- 普通、可恢复开发动作直接执行；
- 真正会丢数据的动作才二次确认；
- 需要确认时，schema 本身必须表达确认字段。

例如：

- switch branch：通常不额外确认；
- commit：用户已经明确要求提交时不额外确认；
- stage：不额外确认；
- discard local changes：必须确认；
- `reset --hard` 这一类操作如果未来提供原生工具，也应属于高风险确认。

安全设计不是“确认越多越安全”，而是：

> 高风险动作有清晰阻断，普通动作不要制造无意义摩擦。

## 7. Work Unit：解决“原来就脏”的真实开发场景

AI 开发最麻烦的场景之一，是仓库开始工作前已经有未提交修改。

如果只看任务结束后的 `git status`，无法判断：

- 哪些是用户原来的修改；
- 哪些是本次任务新增；
- 哪个原脏文件被本次任务再次改过；
- 是否修改了任务声明范围之外的文件。

Work Unit 的思路是任务开始时保存：

- branch；
- HEAD；
- dirty files；
- 每个 dirty file 的 fingerprint；
- allowed paths。

任务结束时重新 snapshot，对比得到：

- newly touched files；
- 原脏文件是否再次变化；
- out-of-scope files；
- branch/HEAD 是否变化。

这里没有做“全局锁仓库”，因为多个对话可能同时工作。Work Unit 是审计边界，不是全局互斥锁。

## 8. 运行态数据不要污染源码仓库

`.ai-bridge`、workspace registry、work unit、task state 这类文件容易让 `git status` 变得越来越吵。

这轮确立的方向：

- 能放 Application Support 的运行态状态，不放源码仓库；
- 已完成 work unit 的状态文件及时删除；
- workspace registry 只保留仍然有效的 canonical root；
- handoff 文件保留兼容，但不再让它承担所有开发流程。

macOS 当前主要使用：

```text
~/Library/Application Support/CodexPro/
```

通用原则：

> Source tree 放“应该被版本控制的事实”，runtime directory 放“当前机器运行产生的状态”。

## 9. 可观测性：Health Check 应该回答什么

单纯：

```text
/healthz = 200
```

只能说明进程能响应，不能说明这是哪个进程实例、协议模式是什么。

因此补了：

- `serverEpoch`
- `startedAt`
- `transportMode`
- `toolSchemaVersion`

`serverEpoch` 每次服务进程启动都变化，可以用来判断是否发生过重启。

值得注意：stateless 后没有继续添加 `active_sessions`，因为 transport session 已经不是架构实体。不要为了“可观测性看起来丰富”而监控一个已经不存在的概念。

## 10. 安全边界：升级 SDK 时最容易丢的是“外围保护”

迁移到 MCP SDK v2 时曾发现一个真实回归：旧 HTTP 层的 20MB body limit 没有自动继承到新的 handler。

21MB 请求能够被正常处理，说明协议迁移虽然成功，但原有外围安全约束被绕过。

最终做法是在 Express 层恢复明确 body limit，再把 parsed body 交给 MCP handler。

这个案例非常典型：

> 重构基础设施时，不只验证 happy path，还要重新核对认证、body size、timeout、rate limit、path guard、redaction 等外围安全属性。

## 11. 一套可靠改造应该如何验证

这轮最终建立了几层测试：

### Build

```bash
npm run build
```

验证 TypeScript、SDK API、schema 等基本正确。

### Smoke

覆盖：

- HTTP；
- stateless；
- Git tools；
- workspace；
- skills；
- import；
- handoff；
- release guard。

### Stateless Restart Test

真实：

1. client 连接；
2. 调工具；
3. bridge SIGTERM；
4. bridge 重启；
5. 同一个 legacy client 继续调用；
6. 稳定 `workspace_id` 继续可用。

还验证了携带旧 `Mcp-Session-Id` header 时，新 stateless `/mcp` 会忽略它。

### Git Integration Test

用临时仓库验证：

- partial stage；
- commit；
- stash/pop；
- restore；
- merge；
- destructive restore confirmation；
- work unit。

### Stress + Audit

```bash
npm run stress
npm audit --audit-level=high
```

最后使用：

```bash
npm run release:check
```

作为综合发布级检查。

## 12. 可移植性：不要把“我的机器能跑”写进源码

这轮最后一次提交前，扫描发现部分本地集成代码写死了：

```text
/Users/<local-user>/ServerAdmin/...
```

这种代码在自己的机器上完全正常，但放进 GitHub fork 后就变成不可移植实现。

最终统一成：

- `os.homedir()`；
- `CODEXPRO_CODEX_DIR`；
- `CODEXPRO_SERVER_ADMIN_ROOT`；
- `CODEXPRO_TASK_ROOT`；
- `CODEXPRO_MODEL_POLICY_PATH`；
- 其他 `CODEXPRO_*` override。

值得形成习惯：

> 准备提交到共享仓库前，主动搜索用户名、绝对路径、token、IP、个人服务名、运行态文件。

## 13. 维护 Fork 的正确心智模型

当前本地约定：

```text
origin   = Stephenxu000/codexpro-cn
upstream = rebel0789/codexpro
```

并且：

```text
upstream push URL = no_push
```

含义是：

- `origin` 是你有写权限、承载自己工作的仓库；
- `upstream` 是原项目，只负责 fetch、diff、同步；
- 不要直接在 upstream remote 上做自己的日常 push。

旧 fork 历史由于和当前 upstream 已无共同祖先，已经保存在：

```text
archive/pre-rewrite-main-20260822
```

新的 `main` 以当前 upstream tree 为基线，叠加自己的维护提交。

## 14. 日常同步 Upstream 的 SOP

第一步永远先确认工作区 clean：

```bash
git status
```

然后：

```bash
git fetch upstream --prune
```

看双方差异：

```bash
git rev-list --left-right --count main...upstream/main
```

如果输出类似：

```text
1  0
```

表示你本地 main 比 upstream 多 1 个提交，upstream 没有新提交，不需要同步。

如果 upstream 有新提交，个人维护 fork 推荐：

```bash
git rebase upstream/main
```

前提是你的维护提交数量少、没有多人基于你的 branch 协作。这样历史保持：

```text
upstream commit
upstream commit
你的维护 commit
```

如果 `main` 已被多人共同使用，优先 merge，避免随意重写公共历史。

rebase 后推自己的 origin：

```bash
git push --force-with-lease origin main
```

永远优先 `--force-with-lease`，不要裸 `--force`。

## 15. 什么时候该向 Upstream 提 PR

不是所有本地改造都应该推给原作者。

### 适合贡献 upstream

通常具备这些特点：

- 对其他用户也有明确价值；
- 不依赖你的 ServerAdmin、百度网盘、launchd 标签等个人环境；
- 可以独立测试；
- 改动范围清晰；
- 不强迫原项目接受你的个人架构偏好。

本轮比较有 upstream 价值的候选：

- stateless MCP transport；
- stable explicit `workspace_id`；
- Git first-class tools，尤其 partial stage；
- work unit；
- `skill_search` / inventory cache；
- `verify_changed_js`；
- health metadata；
- request body limit regression fix；
- 去除个人绝对路径、增强可移植性。

### 更适合留在自己的 fork

- 百度网盘专属调用；
- ServerAdmin 特定目录结构；
- 本机 ngrok/dashboard launchd label；
- 特定模型路由策略；
- 只为个人工作流存在的高权限工具。

好的开源贡献不是“把自己 fork 全部 PR 回去”，而是：

> 从自己的真实需求里提炼出通用问题，再提交最小、独立、可验证的通用解法。

## 16. 本轮最重要的能力提升

如果只记住几个点，建议记这六个：

1. **状态要分类**：transport、business、repository 不要混。
2. **能 stateless 就不要恢复 session**。
3. **业务上下文显式 handle 化**。
4. **确定性开发动作做 Direct Tool，Agent 留给复杂推理**。
5. **共享仓库代码禁止硬编码个人环境**。
6. **Fork 的核心不是复制仓库，而是建立 origin / upstream 的长期协作关系**。

这些原则不只适用于 CodexPro，也适用于任何 Agent 工具、内部开发平台、CI/CD 控制层和远程执行系统。
