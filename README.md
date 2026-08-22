<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="CodexPro logo">
</p>

<h1 align="center">CodexPro</h1>

<p align="center">
  Give ChatGPT local coding tools for repos you explicitly allow.
</p>

<p align="center">
  <a href="https://github.com/Stephenxu000/codexpro-cn/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Stephenxu000/codexpro-cn/ci.yml?branch=main&style=flat-square"></a>
  <a href="https://github.com/Stephenxu000/codexpro-cn/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/Stephenxu000/codexpro-cn?style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro"><img alt="Upstream" src="https://img.shields.io/badge/upstream-rebel0789%2Fcodexpro-181717?style=flat-square"></a>
</p>

## What it is

This repository is a personal maintenance fork of [rebel0789/codexpro](https://github.com/rebel0789/codexpro). Upstream attribution and the original license are preserved; `upstream` is used for read-only synchronization while this repository carries local development and operational improvements.

CodexPro is a local MCP server. It connects **your ChatGPT session** to **your machine** and **repos you allow**.

ChatGPT can read, search, edit, review, verify, import attachments, and write handoff plans. It stays inside those roots.

It is not a hosted SaaS product, model proxy, quota bypass, account pool, or remote shell service.

## Install

Needs:

- Node.js 20+
- A ChatGPT account that can create custom MCP plugins
- An HTTPS URL to your machine for ChatGPT web (tunnel or Tailscale Funnel)

For this maintenance fork, install from source so the local CLI matches this repository:

```bash
git clone https://github.com/Stephenxu000/codexpro-cn.git
cd codexpro-cn
npm install
npm run build
npm link
codexpro setup
```

`npm install -g codexpro` installs the upstream npm release, not this fork.

## Connect in ChatGPT

1. `Settings -> Security and login` → turn **Developer mode** on (keep CSP enforcement on).
2. `Settings -> Plugins` → Plugins tab → **+** beside Search plugins.
3. Create a plugin named `CodexPro`.
4. Connection: **Server URL** → paste the URL CodexPro copied.
5. Authentication: **No Authentication / None** (change this if the form defaults to OAuth).

CodexPro auth is the token already in that URL. Do not share the URL.

| Open Plugins and click `+` | Complete the New Plugin form |
| --- | --- |
| ![Open Plugins and click the plus button](docs/images/chatgpt-plugins-add.png) | ![Complete the New Plugin form](docs/images/chatgpt-plugin-details.png) |

Daily use from the same repo:

```bash
codexpro start
```

If plugin creation fails, run `codexpro connection-test` and check whether ChatGPT requests reach the local server.

## What ChatGPT can do

With workspace write mode (the normal agent setup):

- read, search, and inspect the repo
- edit with `write`, `edit`, or guarded `apply_patch`
- import ChatGPT attachments with `import_file`
- run allowlisted checks with `bash`
- review diffs with `show_changes`
- write plans under `.ai-bridge`
- export a context bundle for chats that cannot call tools

## Multiple projects

One CodexPro process can allow more than one repo:

```bash
codexpro settings set --project ~/code/web --project ~/code/api
codexpro settings show
codexpro start
```

Ask ChatGPT to `open_workspace` on an allowed project. It returns a stable `workspace_id`; pass that id explicitly on later calls for non-default projects. `open_current_workspace` returns to the launch repo.

For two ChatGPT accounts or hard isolation, run two CodexPro processes on different ports and Server URLs.

## HTTP transport

CodexPro uses the MCP 2026 stateless HTTP model on the single `/mcp` endpoint:

- `/mcp` does not create, persist, or restore transport sessions. Bridge restarts therefore do not require reviving a session.
- A stale legacy `Mcp-Session-Id` request header is ignored during upgrade compatibility; it never selects server state.
- Non-default project state is carried explicitly with stable handles such as `workspace_id`, `task_id`, and `job_id`. Omitting `workspace_id` resolves to the configured default workspace.
- `workspace_id` is derived from the canonical project root and persisted outside the repository, so the same logical workspace can be resolved after bridge restarts.

## Commands

```bash
codexpro setup
codexpro start
codexpro start --root /path/to/repo
codexpro doctor
codexpro connection-test
codexpro settings
codexpro inspect
codexpro review
```

Useful modes:

```bash
codexpro start --no-bash
codexpro start --tool-mode minimal
codexpro start --tool-mode full
codexpro start --mode handoff
codexpro start --mode pro
codexpro start --headless
```

Opt-in tool cards:

```bash
CODEXPRO_TOOL_CARDS=1 codexpro start
```

## Public HTTPS options

ChatGPT web needs HTTPS:

```bash
codexpro start --tunnel cloudflare          # quick demo URL (changes)
codexpro ngrok --hostname your.ngrok-free.dev
codexpro stable --hostname codexpro.example.com --tunnel-name codexpro
codexpro tailscale --hostname your-device.your-tailnet.ts.net
codexpro start --tunnel none                # local only
```

Keep a stable token for stable hostnames:

```bash
mkdir -p ~/.codexpro
openssl rand -hex 32 > ~/.codexpro/http-token
chmod 600 ~/.codexpro/http-token
```

Prefer `Authorization: Bearer <token>` when the client supports headers. The `?codexpro_token=` query form is a personal compatibility fallback.

## Safety defaults

- Public tunnels require a CodexPro HTTP token (min 24 bytes)
- Writes stay hidden unless write mode is `workspace`
- Safe bash is the default
- Blocked paths cover `.env`, keys, `.git`, build caches, and similar
- Attachment import only accepts ChatGPT Apps SDK file objects from approved HTTPS hosts

Read [SECURITY.md](SECURITY.md) before exposing a tunnel.

## Update

This maintenance fork does not update through the upstream npm package. Fetch upstream first, inspect the relationship, and only rebase when upstream has new commits:

```bash
git status
git fetch upstream --prune
git rev-list --left-right --count main...upstream/main
```

When upstream has new commits:

```bash
git rebase upstream/main
npm install
npm run release:check
git push --force-with-lease origin main
```

## Development

```bash
npm install
npm run build
npm run smoke
npm run stress
npm run release:check
```

This maintenance fork is marked `private: true`; publishing the upstream `codexpro` npm package from this repository is intentionally disabled.

## Docs

- [Maintainer learning guide (Chinese)](docs/maintainer-guide-zh.md)
- [Fork / upstream / PR workflow (Chinese)](docs/open-source-workflow-zh.md)
- [Upstream website](https://rebel0789.github.io/codexpro/)
- [FAQ](FAQ.md)
- [Security](SECURITY.md)
- [Stable URL guide](DOMAIN_SETUP.md)
- [Changelog](CHANGELOG.md)
- [Contributors](CONTRIBUTORS.md)
