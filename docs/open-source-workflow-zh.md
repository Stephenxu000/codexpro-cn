# 从公司仓库到开源协作：Fork、Upstream、PR 实战指南

如果你平时只在公司仓库里工作，习惯是：有权限就直接 `pull`、建分支、`push`、提内部 MR/PR。开源项目最大的区别，不是 Git 命令变了，而是**权限边界、仓库所有权和协作关系变了**。

这份文档用当前 CodexPro fork 作为实际例子。

## 1. Fork 到底是什么

Fork 可以理解为：

> 在自己的 GitHub 账号下，创建一个与原项目有关联、但你拥有写权限的独立仓库。

当前关系：

```text
原作者：rebel0789/codexpro
             ↑
          upstream
             |
本地工作区 --+
             |
           origin
             ↓
你的仓库：Stephenxu000/codexpro-cn
```

注意：

- Fork 不是“复制一份以后就断绝关系”；
- Fork 的价值正是可以持续跟踪原项目，同时保留自己的改造；
- 你不能因为 fork 了，就认为原项目变成你的；LICENSE、来源、作者信息仍然要保留。

## 2. origin 和 upstream 是什么

Git 本身并不认识“fork”这个词，它只认识 remote。

常见约定：

```text
origin   = 自己拥有写权限的 fork
upstream = 原作者仓库
```

当前 CodexPro：

```bash
git remote -v
```

应看到类似：

```text
origin    https://github.com/Stephenxu000/codexpro-cn.git
upstream  https://github.com/rebel0789/codexpro.git
```

为了降低误操作风险，当前还额外配置：

```text
upstream push URL = no_push
```

因此：

```bash
git push upstream main
```

会失败。

这是故意的。原项目只负责同步，不作为自己的推送目标。

## 3. 为什么公司仓库里感觉“没这些禁忌”

公司里通常已经替你做好了权限模型：

- 仓库属于公司；
- 你是组织成员；
- 有 branch permission；
- CI、Code Review、Merge Rules 已经统一配置；
- 大家操作的是同一个 canonical repo。

开源项目里，你通常不是 maintainer，没有原仓库写权限。

因此标准流程变成：

```text
upstream
   ↓ fetch
你的本地仓库
   ↓ push
origin fork
   ↓ Pull Request
upstream
```

PR 是“请求原项目接受你的提交”，不是“把你的 fork merge 回去”。

## 4. 日常开发最推荐的分支模型

即使你一个人维护 fork，也建议不要每个功能都直接在 `main` 上开发。

例如要贡献一个 Git partial stage 改进：

```bash
git switch main
git fetch upstream --prune
git rebase upstream/main
git switch -c feat/git-stage-hunks
```

开发、测试、提交：

```bash
git add ...
git commit -m "feat: add safe partial staging"
git push -u origin feat/git-stage-hunks
```

如果只是自己使用，到这里就可以。

如果想贡献给原作者，就从：

```text
Stephenxu000/codexpro-cn:feat/git-stage-hunks
```

向：

```text
rebel0789/codexpro:main
```

创建 Pull Request。

## 5. 一个好的开源 PR 应该长什么样

一个高质量 PR 往往具备：

### 问题清楚

不要只写：

> improve git

而要写：

> Git operations currently rely on generic Bash. Partial staging cannot be expressed safely and consistently under the existing confirmation policy.

### 范围小

不要把：

- stateless；
- 百度网盘；
- 本机 launchd；
- Git tools；
- UI；

全部塞进一个 PR。

最好一件事一个 PR。

### 能复现

说明旧行为怎么失败。

### 有测试

最好给测试证明：

- 旧场景能复现；
- 新场景通过；
- 没破坏已有行为。

### 不夹带个人环境

不应该出现：

```text
/Users/yourname/...
你自己的 token
你家的 NAS 路径
你自己的百度配置
```

## 6. 你的 Fork 应该怎么长期定位

当前 CodexPro fork 更适合定位成：

> **个人长期使用的 maintenance fork，同时作为向 upstream 提炼通用贡献的实验场。**

而不是马上把它当成一个“我要重新做一套 CodexPro 产品”的独立发行版。

原因：

1. 原项目还在维护；
2. 你现在最有价值的是使用反馈和真实开发场景；
3. 自己独立维护整个生态成本很高；
4. 很多本地增强是个人环境专属，不适合成为公共产品默认能力。

推荐分三层管理改动：

### A. Upstream 可贡献层

通用、干净、可测试的改进。

目标：最终尽量 PR 回 upstream。

### B. Maintenance Fork 层

原作者暂时不接受、但你长期需要的通用增强。

保留在 `codexpro-cn`。

### C. Local Integration 层

只属于自己的：

- ServerAdmin；
- 百度网盘；
- 家庭服务器；
- 特定 launchd label；
- 私人模型策略。

这类最好通过配置、plugin 或独立 adapter 隔离，尽量不要深度侵入核心代码。

## 7. 怎么同步原作者更新

### 第一步：确认自己没有未提交修改

```bash
git status
```

### 第二步：抓 upstream

```bash
git fetch upstream --prune
```

### 第三步：看差异

```bash
git rev-list --left-right --count main...upstream/main
```

例如：

```text
1 0
```

含义：

- main 有 1 个 upstream 没有的提交；
- upstream 没有新提交。

不需要处理。

如果是：

```text
1 3
```

说明：

- 你有 1 个自己的提交；
- upstream 新增 3 个提交。

如果这个 fork 主要是你一个人维护，可以：

```bash
git rebase upstream/main
```

然后：

```bash
git push --force-with-lease origin main
```

### 为什么不是 `git pull upstream main`

因为 `pull` 实际是 fetch + merge/rebase，但过程不够显式。

维护 fork 时更推荐：

```text
fetch → inspect → 决定 rebase/merge
```

先看清楚，再改变历史。

## 8. Rebase 和 Merge 怎么选

### 个人维护 fork

推荐 rebase。

因为你希望自己的改造像补丁一样一直叠在 upstream 最新主线后面：

```text
A -- B -- C upstream
           \
            X 你的维护提交
```

upstream 更新 D、E 后 rebase：

```text
A -- B -- C -- D -- E upstream
                     \
                      X' 你的维护提交
```

历史很容易理解。

### 多人共享 branch

优先 merge。

因为 rebase 会重写 commit SHA，如果其他人已经基于旧 SHA 开发，会增加协作成本。

## 9. 为什么要用 `--force-with-lease`

Rebase 后 commit SHA 会变，普通 push 会被拒绝。

这时不要使用：

```bash
git push --force
```

应该使用：

```bash
git push --force-with-lease
```

区别：

- `--force`：不管远端发生什么，都覆盖；
- `--force-with-lease`：只有远端仍是你预期的状态时才覆盖。

它相当于：

> “如果从我上次看到它以后没人动过，我才允许改写。”

## 10. 为什么这次旧 main 要先 Archive

这次发现你的旧 fork `main` 和当前 upstream 已经**没有共同祖先**。

这通常意味着：

- 原作者重写过历史；
- fork 来源发生过迁移；
- 或你的 fork 很久以前来自另一条历史。

这种情况下直接 merge 会生成非常难看的 unrelated histories。

更稳妥的处理：

1. 先把旧 `main` 保存为远端 archive branch；
2. 新 `main` 对齐当前 upstream；
3. 再叠加当前真正要维护的改造。

当前旧历史保存在：

```text
archive/pre-rewrite-main-20260822
```

Archive 的意义不是让你以后继续开发，而是提供历史追溯和恢复点。

## 11. 什么改动应该先留自己用，再考虑贡献

可以按三个问题判断：

### 问题 1：这个问题别人也会遇到吗？

如果只有你的 Mac mini + ServerAdmin 会遇到，优先留自己的 fork。

### 问题 2：可以脱离你的环境独立测试吗？

如果可以，贡献价值明显增加。

### 问题 3：能不能把 PR 压到一个清楚的问题？

如果需要解释十个不同系统才能说明这个 PR 做什么，通常还没拆干净。

## 12. 当前这轮改造怎么拆成潜在 Upstream PR

不要提交当前 `7adb7c8` 整个大 commit 给 upstream。

更合理的候选拆分：

### PR 1：Stateless MCP transport

包括：

- MCP SDK v2；
- single stateless `/mcp`；
- stale session header compatibility；
- restart regression；
- body limit fix。

### PR 2：Stable workspace identity

包括：

- stable `workspace_id`；
- default workspace rule；
- registry outside source tree；
- restart test。

### PR 3：First-class Git tools

包括：

- switch；
- branch；
- stage；
- stage hunks；
- commit；
- merge；
- stash；
- restore；
- confirmation semantics。

### PR 4：Work Unit

独立提交 baseline / changed paths / out-of-scope audit。

### PR 5：Small deterministic developer utilities

如：

- `skill_search`；
- skill cache；
- `verify_changed_js`；
- health metadata。

这样原作者可以逐个接受、拒绝、讨论，而不是面对一个 3000 行大 PR。

## 13. 第一次参与开源，建议从“小 PR”开始

不要第一次就拿 stateless 大架构改造练手。

建议先选择：

1. 一个文档错误；
2. 一个小测试补强；
3. 一个明确 bug；
4. 一个小型 utility。

例如这轮的 `verify_changed_js` 或某个 body-limit regression test，都比一次 3000 行 PR 更适合作为第一次贡献。

你会先学到：

- 如何看 CONTRIBUTING；
- 如何和 maintainer 沟通；
- 如何根据 review 修改 commit；
- CI 不通过时怎么处理；
- 什么叫 scope creep；
- 什么样的描述 maintainer 最容易 review。

## 14. 开源里最重要的不是“代码写得比原作者好”

开源协作更看重：

- 尊重现有设计；
- 先理解为什么现在这样；
- 给出复现和证据；
- 改动范围克制；
- 接受 maintainer 不采用你的方案；
- 愿意根据 review 调整。

你可以认为：

> 公司开发强调“把业务做完”，开源贡献还多了一层“让陌生维护者愿意长期承担这段代码”。

这是很重要的工程能力。

## 15. 现在你应该怎么使用这个 Fork

短期建议：

- 日常自己继续用 `codexpro-cn`；
- 保持 upstream 定期 fetch；
- 不急着把自己的 fork 做成独立品牌；
- 每次出现通用问题时，记录“是否值得 upstream PR”；
- 真准备贡献时，从当前大改造里切出一个小而独立的 branch。

长期如果出现以下情况，再考虑真正独立维护：

- upstream 长期停更；
- 你的方向与 upstream 明显分叉；
- 已经有其他用户依赖你的 fork；
- 你愿意承担 issue、release、security、兼容和文档维护。

否则，maintenance fork + upstream contribution 通常是性价比最高的方式。
