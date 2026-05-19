<!--
═══════════════════════════════════════════════════════════════════════════
For an AI coding agent (Claude Code, Cursor, Aider, etc.) installing this
project for a human user — read this section FIRST.

This bridge is designed to be installed by a user asking their AI agent
"please set up bridgy for me." Follow these steps in order;
ask the user for missing info; do NOT skip any step.

INSTALL CHECKLIST (run sequentially, confirm each before moving on):

1. Verify host OS + Python.
   - Confirm OS is Windows 10/11, macOS, or Linux. If something else, stop.
   - Run `python --version` (or `python3`). REQUIRE 3.11 or higher. If
     missing, point the user at python.org / brew / their package manager.

2. Verify Claude Code CLI is installed and authed.
   - Run `claude --version`. If it fails, install per
     https://docs.claude.com/code (npm install -g @anthropic-ai/claude-code,
     or the platform-specific installer). Wait for the user to confirm.
   - Run `claude login` and have the user authenticate. The bridge spawns
     `claude -p` under the user's account; without auth nothing works.
   - Confirm `~/.claude/.credentials.json` (or %USERPROFILE%\.claude\)
     exists.

3. Clone + install bridge.
   - `git clone https://github.com/tomh751/bridgy.git`
     into a directory the user picks (NOT inside OneDrive / Dropbox /
     iCloud — those break the .crc-passkeys file).
   - `cd bridgy`
   - Run `.\scripts\setup.ps1` (Windows) or `./scripts/setup.sh` (Unix).
     This creates `.venv`, installs `requirements.txt`, copies
     `.env.local.example` → `.env.local`.

4. Configure `.env.local`.
   - Open `.env.local`. AT MINIMUM set:
     * `PROJECTS_ROOT` — absolute path to the parent folder that holds
       the user's projects. Each subfolder = one project visible in the
       picker. Ask the user where their code lives.
     * `WEB_PASSWORD` — minimum 10 characters. Suggest a 3-4 word
       passphrase (e.g. `lake-river-mountain-7`). Do NOT pick this for
       them — let them pick. Write it down somewhere safe (the phone
       will autofill it on Save Password).
   - Don't change anything else unless the user asks. Defaults are sane.

5. Network: install + sign into Tailscale on BOTH laptop and phone.
   - Tailscale is the recommended tunnel. Run https://tailscale.com/download
     on the laptop and have the user install the iOS / Android app on
     their phone. Both must sign into the same tailnet (same Google
     account / GitHub / Microsoft — whatever they use).
   - On the laptop, run `tailscale ip -4` and note the MagicDNS hostname
     (e.g. `desktop-91bnv6v.tail505b08.ts.net`).

6. HTTPS via Tailscale Serve (REQUIRED for iOS mic + passkeys).
   - Run: `tailscale serve --bg --https=8787 http://localhost:8787`
   - Set in `.env.local`:
     * `CRC_HTTPS_URL=https://<that-magicdns-hostname>`
     * `CRC_COOKIE_SECURE=true`
   - Plain HTTP works if HTTPS is genuinely unavailable, but the phone
     loses microphone dictation and Face ID. Don't skip unless asked.

7. Start the bridge.
   - Run `.\scripts\start.ps1` (Windows) or `./scripts/start.sh` (Unix).
   - Confirm output includes `bridge online` and `web UI online`.
   - Verify localhost:8787 responds: `curl -s -o /dev/null -w "%{http_code}\n"
     http://127.0.0.1:8787/login` should return 200.

8. Install the PWA on the phone.
   - Tell the user to open Safari (iOS) or Chrome (Android) and visit
     `https://<their-magicdns-hostname>` from their phone (already on
     the tailnet).
   - They paste the WEB_PASSWORD they set in step 4.
   - iOS: Share → Add to Home Screen. Tap the new tile to launch
     standalone.
   - Android: tap "Install app" in the prompt, or three-dots → Install
     app.

9. Recommended polish.
   - In the PWA menu (⋯), have the user enable Notifications (one tap;
     iOS prompts for permission). This is what makes "run finished"
     pushes work when the PWA is closed.
   - Set up Face ID / passkey: PWA menu → Sign in with Face ID. Now the
     password is only needed at first install.

10. STOP HERE. Do NOT touch `.claude/`, `skills/`, `tools/`, or
    `CLAUDE.md` — those are maintainer-only directories the user does
    NOT need. They are gitignored on the public repo, but if your clone
    came from a fork that included them, leave them alone.

If ANY step fails, STOP and report to the user. Don't improvise around
missing prerequisites — they each have a reason.
═══════════════════════════════════════════════════════════════════════════
-->

# Bridgy

A self-hosted mobile bridge to [Claude Code](https://docs.claude.com/code) running on your laptop.

Use your iPhone (or any phone) to chat with Claude Code running on your Windows / macOS / Linux machine — over Tailscale (or any other tunnel you prefer), no public exposure, your own Claude subscription, no third-party relay. Drive multiple parallel conversations from a multi-tab PWA, watch your laptop's tool calls stream live, hand sessions off between your desktop and your phone.

> ⚠️ **Read [the Security warnings section](#-security-warnings--read-before-running) before exposing this on any network.** A connected client of this bridge can run arbitrary shell commands on your laptop.

## TL;DR — five-minute setup

1. **Install on the laptop**: Python 3.11+, the [Claude Code CLI](https://docs.claude.com/code) (logged in), and pick a tunnel — easiest is [Tailscale](https://tailscale.com/download).
2. **Install on the phone**: the matching [Tailscale app](https://tailscale.com/download) (iOS / Android), signed into the same tailnet. Skip this if you picked a different tunnel from [Connection options](#connection-options) — local Wi-Fi works at home with no install, Cloudflare Tunnel needs only the laptop side.
3. **Clone & install the bridge**:
   - Windows: `git clone <repo>; cd bridgy; .\scripts\setup.ps1`
   - macOS / Linux: `git clone <repo>; cd bridgy; ./scripts/setup.sh`
4. **Edit `.env.local`** — set `PROJECTS_ROOT` (folder holding your projects) and `WEB_PASSWORD` (min 10 chars, use a passphrase).
5. **Start the bridge**: `.\scripts\start.ps1` (Windows) or `./scripts/start.sh` (macOS / Linux).
6. **Open on the phone**: visit your bridge URL → enter the password → install as a PWA:
   - **iOS Safari**: Share → "Add to Home Screen"
   - **Android Chrome**: tap "Install app" prompt (or three-dots menu → Install app)

Everything else (HTTPS for mic + passkeys, alternative tunnels if you don't want Tailscale, environment knobs, security model) is covered in the sections below. **No third-party accounts or API keys beyond your Claude CLI are needed** — VAPID push keys auto-generate locally on first boot.

## Why this exists

The official Claude Code mobile experience is `claude remote-control` (a.k.a. `/rc`), which pairs your laptop's interactive session with Anthropic's mobile app via their relay. It's great — when you want it. But it requires:

- A Pro / Max / Team / Enterprise subscription (no API-key option)
- Anthropic's mobile app and their relay
- One remote session per VSCode window

This project is the alternative for everything `/rc` doesn't cover:

- **Subscription-agnostic** — works with whatever Claude auth you already have (OAuth, API key)
- **Self-hosted** — your laptop, your network, your Tailscale tunnel
- **Custom UI** — a multi-tab PWA modeled on the Claude Code VSCode extension, with your own UX choices (light/dark, model picker, attachments, watcher media, etc.)
- **Parallel projects** — drive different projects from different tabs simultaneously

Both can coexist. Use `/rc` when you want true same-session sync with VSCode; use this bridge for everything else.

## Architecture

```
┌──────────────┐         Tailscale HTTPS         ┌────────────────────┐
│  iPhone PWA  │ ◄────────────────────────────► │  FastAPI + WS      │
│  (Safari →   │                                 │  bridge on laptop  │
│   home tile) │                                 └──────────┬─────────┘
└──────────────┘                                            │
                                                            │ asyncio.create_subprocess_exec
                                                            ▼
                                                  ┌────────────────────┐
                                                  │  claude -p         │
                                                  │  (your local CLI)  │
                                                  └─────────┬──────────┘
                                                            │
                                                            ▼
                                                  ┌────────────────────┐
                                                  │  Your AI projects  │
                                                  │  under PROJECTS_   │
                                                  │  ROOT              │
                                                  └────────────────────┘
```

The bridge spawns `claude -p` per turn and streams its stream-json output back to the phone over WebSocket. If a Claude run writes an image or video into your project, the bridge auto-attaches the file to the chat. The watched subdirectory list is controlled by the `WATCH_FOLDERS` env var — see the [Configuration reference](#configuration-reference) below for the default + how to change it.

## Prerequisites

- **Python 3.11+** on the machine running the bridge
- **Claude Code CLI** installed and logged in (`claude --version` works, `~/.claude/.credentials.json` is populated)
- **A tunnel from your phone to your laptop.** Tailscale is the default and easiest path — install [Tailscale on the laptop](https://tailscale.com/download) **and** the Tailscale app on your phone, sign both into the same tailnet. Don't want a third-party? See [Connection options](#connection-options) below — Cloudflare Tunnel, plain LAN-only, WireGuard / Headscale, ngrok, or an SSH-tunnel-to-VPS all work.
- **A modern phone browser**:
  - **iPhone**: Safari 16.4+ (for full PWA features including Web Push notifications and Face ID)
  - **Android**: Chrome / Edge (Brave works too) — same feature set
- For hands-free dictation: any phone browser with `MediaRecorder` + `getUserMedia` over HTTPS (universal on iOS Safari 14+, modern Chrome, modern Firefox). Audio is captured on the phone and POSTed to the laptop, where local Whisper (`faster-whisper`) transcribes it in memory — no cloud APIs, no audio written to disk. The model auto-downloads to `~/.cache/huggingface` on first use (~140 MB for the default `base.en`); tune via `WHISPER_MODEL` / `WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE` in `.env.local`.

The bridge has been tested on Windows 11 with PowerShell. Launcher scripts for both Windows (`scripts\setup.ps1` / `scripts\start.ps1`) and Unix-likes (`scripts/setup.sh` / `scripts/start.sh`) live in the `scripts/` folder.

### Works with any Claude Code install

The bridge spawns the `claude` CLI as a subprocess — it doesn't depend on a particular IDE. You can have Claude Code installed via:

- The standalone CLI (just `claude` on PATH)
- The VSCode extension
- Google's Antigravity IDE
- A JetBrains plugin
- Any combination of the above

…and the bridge works alongside all of them. The only constraint is that two processes can't hold the **same session jsonl** at the same time — so if VSCode has a Claude conversation open in a project, the phone can READ that session but not write to it until VSCode's panel is closed. Each new chat tab on the phone gets its own session UUID, so day-to-day parallel use is fine.

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/tomh751/bridgy.git
cd bridgy
```

On Windows:

```powershell
.\scripts\setup.ps1
```

On macOS / Linux:

```bash
./scripts/setup.sh
```

Either script creates `.venv`, installs `requirements.txt`, and copies `.env.local.example` to `.env.local`.

### 2. Configure

Open `.env.local` and at minimum set:

```ini
PROJECTS_ROOT=C:\path\to\your\projects        # the folder that contains your projects
WEB_PASSWORD=pick-a-strong-passphrase         # min 10 chars; use a passphrase, not a single word
```

Avoid putting `PROJECTS_ROOT` inside a cloud-sync folder (OneDrive / Dropbox / iCloud) — the bridge stores a passkey credentials file there and you don't want that synced. Everything else has sensible defaults — see [`.env.local.example`](.env.local.example) for the full reference (watcher folders, resource caps, optional HTTPS URL).

### 3. Set up HTTPS (optional but recommended)

iOS PWAs need HTTPS for the microphone API and Web Authentication (passkeys). The bridge itself **does not terminate TLS** — put a TLS proxy in front of it. The simplest path is [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve):

```bash
tailscale serve --bg --https=8787 http://localhost:8787
```

This exposes the bridge at `https://your-laptop.tailXXXX.ts.net:8787` with a valid cert. Once that's running:

```ini
CRC_HTTPS_URL=https://your-laptop.tailXXXX.ts.net:8787
CRC_COOKIE_SECURE=true
```

The `CRC_HTTPS_URL` lets the bridge's HTML auto-redirect HTTP visits to the HTTPS URL. `CRC_COOKIE_SECURE=true` ensures the auth cookie is only sent over HTTPS.

If you skip this, plain HTTP works on Tailscale (the tunnel encrypts everything anyway) but the phone misses mic + passkeys.

### 4. Start the bridge

Windows:

```powershell
.\scripts\start.ps1
```

macOS / Linux:

```bash
./scripts/start.sh
```

You'll see:

```
bridge online — projects_root=... web=on (web-only build)
web UI online: http://0.0.0.0:8787
```

### 5. Install the PWA on the phone

**iPhone (iOS Safari):**

1. Open Safari and visit `https://your-laptop.tailXXXX.ts.net:8787` (the Tailscale MagicDNS hostname, or whatever public URL your tunnel hands you).
2. Type the `WEB_PASSWORD` you set in step 2.
3. Tap the Share button → **Add to Home Screen**.
4. Launch from the home tile — it opens in standalone mode (no Safari chrome).
5. Optional but recommended: in the app's ☰ menu, tap **Notifications** to flip the toggle on. iOS will prompt for permission once; after that you'll get a push every time Claude finishes a task, even with the PWA fully closed.

**Android (Chrome / Edge):**

1. Open Chrome and visit `https://your-laptop.tailXXXX.ts.net:8787`.
2. Type the `WEB_PASSWORD` you set in step 2.
3. Chrome usually shows an **"Install app"** prompt right away. If not, open the three-dots menu → **Install app** (or **Add to Home screen**).
4. Launch from the home icon — it opens in standalone mode (no Chrome chrome).
5. Same as iOS: open the app's ☰ menu, tap **Notifications**, allow when prompted.

You're done. Pick a project from the topbar, type a prompt, and Claude runs it on your laptop with output streaming live to the phone.

## Connection options

The bridge is a normal FastAPI server listening on `WEB_PORT` (default 8787). It just needs to be reachable from your phone. **You don't have to use Tailscale.** Any of the options below works; pick the one that fits your tolerance for setup and your privacy preferences.

| Option | Setup effort | Cost | Notes |
|---|---|---|---|
| **Same Wi-Fi only** | Zero | Free | Use `http://<laptop-LAN-IP>:8787` from the phone. Find the IP via `ipconfig` (Windows) or `ifconfig` / `ip addr` (Unix). Mic + passkeys need HTTPS, which plain LAN doesn't provide — fine for testing, limited for daily use. |
| **Tailscale** (recommended) | 5 min | Free for personal use | Install on phone + laptop, sign into the same tailnet, use MagicDNS hostname. Add `tailscale serve --bg --https=8787 http://localhost:8787` for valid HTTPS. Mesh handles roaming networks automatically. |
| **Cloudflare Tunnel (`cloudflared`)** | ~10 min | Free | Run `cloudflared tunnel --url http://localhost:8787` on the laptop. Cloudflare hands you a public `*.trycloudflare.com` URL (or a custom domain). Set `CRC_HTTPS_URL` to that URL and you're done. Best non-VPN option. |
| **ngrok** | ~5 min | Free tier OK; paid for stable URLs | `ngrok http 8787` → public URL. The bouncing free-tier URL means you re-enter it on every restart, so it's better for one-off demos than daily use. |
| **WireGuard / Headscale** | 30–60 min | Free + cheap VPS | Self-hosted VPN. Headscale is a drop-in open-source replacement for Tailscale's coordination server. Most "you own the entire path" option. |
| **SSH reverse tunnel to a VPS** | 30 min | ~$4/month VPS | `ssh -R 8787:localhost:8787 user@vps`, then point your phone at `https://vps.example.com` (with nginx + Let's Encrypt). Maximum control, more moving parts. |

Whichever you pick: **always set `WEB_PASSWORD` to a strong passphrase**, and **set `CRC_COOKIE_SECURE=true` if you have any HTTPS terminator in front of the bridge** (Tailscale Serve, cloudflared, nginx, etc.). The bridge's auth model assumes the network is the first wall; the password is the second.

## Configuration reference

See [`.env.local.example`](.env.local.example) for the complete annotated config. Common knobs:

| Variable | Default | Purpose |
|---|---|---|
| `PROJECTS_ROOT` | required | Parent folder; each subfolder = a project. Don't point at a cloud-sync folder. |
| `WEB_HOST` | `0.0.0.0` | Listen interface. Use `127.0.0.1` for local-only (no LAN exposure). |
| `WEB_PORT` | `8787` | Port for the PWA. |
| `WEB_PASSWORD` | required | Login password for the phone. Min 10 chars; use a passphrase. |
| `WORKSPACE_ROOT_LOCK` | `true` | When `true` (default), the workspace picker cannot browse outside `PROJECTS_ROOT`. Set to `false` to opt into the wider "browse the whole laptop" UX — that widens the attack surface of an authenticated session. |
| `CRC_HTTPS_URL` | empty | Public HTTPS URL for auto-redirect (e.g. Tailscale Serve URL). |
| `CRC_COOKIE_SECURE` | `false` | Set `true` when fronting with HTTPS (Tailscale Serve, cloudflared, etc.). |
| `CLAUDE_CMD` | `claude` | Path / shell name for your Claude CLI. |
| `CLAUDE_MODEL` | empty | Model override (`claude-opus-4-7`, `claude-sonnet-4-6`, etc.) — empty = CLI default. |
| `CLAUDE_DEFAULT_PERMISSION_MODE` | `auto` | `auto` (bypass), `plan`, or `edits`. `auto` = arbitrary code execution by anyone who can log in. |
| `LAN_IP` | auto-detected | Override the IP the bridge tells Claude when starting dev servers. |
| `WATCH_FOLDERS` | `assets,output,screenshots` | Folders inside each project that the watcher monitors for new media. |
| `MAX_MEDIA_MB` | `20` | Per-file cap for watcher uploads. |
| `MAX_CONCURRENT_RUNS` | `6` | Global ceiling on simultaneous claude subprocesses. |

## ⚠️ Security warnings — read before running

This bridge **can run arbitrary code on your laptop**. Read every item below before you start it on any non-isolated machine. The auth model is a single shared password + an HMAC-signed cookie, designed for the **single-user, trusted-network** case.

### Trust model

- **Whoever can authenticate to this bridge can run arbitrary shell commands on the machine running it.** The default `CLAUDE_DEFAULT_PERMISSION_MODE=auto` passes `--dangerously-skip-permissions` to Claude Code, which auto-approves every tool call including Bash. If you don't want that, set the env to `plan` (read-only) or `edits` (auto-accept file edits, stall on bash) — but understand the bridge is not a sandbox.
- **The auth model is a single shared password.** Pick a strong one (the bridge enforces a 10-character minimum, but you should use a passphrase) and don't reuse it from another account.
- The bridge stores a FIDO2 passkey credentials file (`.crc-passkeys.json`) inside `PROJECTS_ROOT`. **Don't put `PROJECTS_ROOT` inside OneDrive / Dropbox / iCloud** — those files end up in cloud sync.

### Network exposure

- **The supported transport is [Tailscale](https://tailscale.com/).** Tailscale puts the bridge on a private mesh network with magic DNS, encrypted tunneling, and ACLs based on identity (not IP). The default `WEB_HOST=0.0.0.0` binds to every interface — Tailscale's ACL keeps non-tailnet machines out.
- **If you don't use Tailscale, set `WEB_HOST=127.0.0.1`** for local-only access, or expose the bridge through a VPN. The brute-force rate limit (5 attempts per IP per minute, 500ms delay) is not enough to defend against a LAN attacker who can rotate IPs.
- **Never expose `WEB_PORT` directly on the public internet.** Even with HTTPS, the bridge isn't designed for hostile traffic.

### HTTPS and cookies

- Plain HTTP works on Tailscale (the tunnel itself encrypts), but the phone misses mic + passkeys (both require Secure context).
- If you put a TLS proxy in front of the bridge (Tailscale Serve, cloudflared, caddy), **set `CRC_COOKIE_SECURE=true`** so the auth cookie is HTTPS-only.
- The auth cookie is HMAC-signed using a key derived from `WEB_PASSWORD`. Changing the password instantly invalidates every outstanding cookie.

### What lives where

- `.env.local` — your secrets. Gitignored. Never commit.
- `*.key`, `*.pem`, `*.crt`, `*.cer` — TLS certs (if you generate them for a local proxy). Gitignored. The `.key` is your private key.
- `.crc-passkeys.json` — FIDO2 public-key credentials, stored at `<PROJECTS_ROOT>/.crc-passkeys.json`. Gitignored. Personally identifying — treat it like a session cookie.
- `<PROJECTS_ROOT>/.web-uploads/<project>/` — every image or file you attach via the phone is saved here, centralized under a single top-level `.web-uploads/` folder with one subfolder per project (e.g. `<root>/.web-uploads/my-project/5a5899ad_screenshot.png`). The bridge serves these on demand via `/media/<token>` (6h tokens, regenerated on every replay). Files are NOT auto-deleted — that's what lets your chat history still show the attachments after you close and reopen the PWA. Manage from inside the PWA via **Menu → Manage uploads** (per-project size breakdown + selective or bulk delete with confirm dialog), or delete files manually from disk (the chip will render as a greyed-out "no longer on disk" placeholder afterwards). Migration: any legacy `<project>/.web-uploads/` from before this layout is moved automatically on bridge boot.

If you find yourself running this on a public IP, **stop** and put it behind a VPN first.

## Legal & Anthropic terms of service

This project is an open-source self-hosted wrapper around the Claude Code CLI. It does **not** resell, redistribute, or relay Claude itself — every Claude run executes on the user's own machine, under the user's own Anthropic account. Anthropic ships their own first-party equivalent ([Remote Control in Claude Code](https://code.claude.com/docs/en/remote-control)), so the use case is explicitly supported by them.

That said, if you fork this and run it for other people — even for free — there are a few clauses in Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), and [Acceptable Use Policy](https://www.anthropic.com/legal/aup) that you and your users need to respect. By using this software, you and any users you grant access to agree to the following:

1. **Bring your own Anthropic account.** Each user must authenticate the Claude Code CLI on their own machine with their own Anthropic credentials (Pro / Max / Team / Enterprise OAuth, or their own `ANTHROPIC_API_KEY`). Sharing one account's credentials across multiple users is prohibited by Anthropic's Consumer Terms ("You may not share your Account login information, Anthropic API key, or Account credentials with anyone else"). This bridge's architecture keeps credentials on each user's own laptop precisely so this stays clean — do not undermine that by setting up a shared `ANTHROPIC_API_KEY`.
2. **Comply with Anthropic's Acceptable Use Policy.** Your use of Claude through this bridge is bound by [Anthropic's AUP](https://www.anthropic.com/legal/aup). Don't use it to generate prohibited content, don't use it to evade a Claude account ban, and don't use it from a region where Anthropic's [Supported Regions Policy](https://www.anthropic.com/supported-countries) prohibits Claude access.
3. **No model training on conversations.** This bridge does not log conversations server-side beyond what Claude Code itself writes to `~/.claude/projects/`. If you fork it and add server-side logging, you must NOT use those logs to train, fine-tune, or distill any AI model — that's explicitly prohibited by the AUP ("Utilization of inputs and outputs to train an AI model without prior authorization").
4. **No automated abuse.** Don't use the bridge as a bot farm, don't script bulk content generation through it, don't coordinate multiple accounts through one deployment to evade Claude's safety guardrails or rate limits.
5. **Abuse reporting.** Misuse of Claude itself should be reported to Anthropic at `usersafety@anthropic.com`. Bugs or abuse of this bridge should be reported via the project's GitHub issues.
6. **No warranty.** This is open-source software under MIT. The maintainers take no responsibility for how you or your users use Claude through it. Compliance with Anthropic's terms is each operator's individual responsibility.

**For maintainers / forkers:** the audit that produced this section concluded that the single-user-on-own-laptop design is unambiguously fine, and that a future multi-user cloud relay design (documented in [CLAUDE.md](CLAUDE.md)) is also fine **provided each user's `claude -p` runs under their own Anthropic account on their own machine**. The moment you proxy one account's credentials on behalf of multiple users, you're in violation of the Consumer Terms. Don't do that.

## How it works

Highlights:

- **One transport, with a clean extension point.** `bridge/sink.py` defines a `RunSink` protocol; today the only implementation is `WebSink` (FastAPI WebSocket). The session manager is transport-agnostic — if you wanted to add a CLI client, a Discord bot, or an MCP channel, you'd write a new `RunSink` and the rest of the bridge wouldn't care.
- **Streaming output.** The bridge runs claude with `--output-format stream-json --include-partial-messages` and forwards delta text to the phone token-by-token. Tool calls are surfaced as compact "IN/OUT" cards.
- **Multi-tab.** Each tab is its own claude session (its own UUID, its own `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` on disk). Switch between them like browser tabs; the bridge keeps separate state per tab.
- **Live sync from VSCode.** While VSCode is running a session, the phone can READ that session as it streams — useful as a second-screen view from a different room. (You can't WRITE from the phone into VSCode's running session — that's a `claude.exe` jsonl-lock limitation. Hand off by closing VSCode's Claude panel, then phone takes over.)
- **PWA cache + version handshake.** The WebSocket `hello` frame includes an `asset_version` string; the client compares to its baked-in version and surfaces a "tap to reload" banner if they diverge. Necessary escape hatch from iOS standalone PWA caching.

## Roadmap

These are deferred but planned. PRs welcome.

- **Model picker** — per-tab choice across Claude models (and eventually local providers like Ollama)
- **Interactive AskUserQuestion** — convert the runner from `claude -p` (one-shot) to interactive mode so the phone can answer mid-run prompts
- **MCP Channels integration** — for true bidirectional sync with VSCode's running session (channels is Anthropic's officially-documented two-way bridge mechanism, currently research preview)
- **Light theme**
- **Cloud-hosted relay** — eventual direction so users without Tailscale can use this. Significant rearchitecture (laptop-agent + cloud bridge + multi-user accounts)

## Using local models (Ollama, LM Studio, etc.)

The bridge runs `claude.exe`, and `claude.exe` is built for Anthropic's API. There's no built-in support for routing it to a local model. But it CAN be done via a translation proxy that pretends to be Anthropic.

The standard trick:

1. Run a proxy that exposes an OpenAI-compatible API translated to Anthropic's API shape. The most-used options are [LiteLLM](https://github.com/BerriAI/litellm) and [claude-code-proxy](https://github.com/1rgs/claude-code-proxy).
2. Point the proxy at your local model server (Ollama at `http://localhost:11434`, LM Studio at `http://localhost:1234`, vLLM, etc.).
3. Set environment variables BEFORE starting the bridge so the spawned `claude.exe` talks to the proxy instead of Anthropic:

   ```ini
   # In .env.local
   ANTHROPIC_BASE_URL=http://localhost:4000     # your proxy's URL
   ANTHROPIC_API_KEY=anything-non-empty         # most proxies don't actually check
   CLAUDE_MODEL=llama-3.1-70b-instruct          # whatever model name your proxy expects
   ```

The bridge passes these through to `claude.exe`. Claude Code never knows it's not talking to Anthropic; the proxy translates each request to your local backend. The model picker in the UI is still hardcoded to Anthropic model names — for proxy-routed local models, leave the picker on **Auto** and let `CLAUDE_MODEL` decide.

⚠️ Quality varies. Local models below ~70B parameters typically don't do well with agentic tool calling (Bash, Edit, MultiEdit). Plan for some prompt-tuning, or use this for read-mostly workflows.

## Contributing

Open an issue first if you're planning something substantial. PRs that just polish the UI or tighten the docs are welcome without a heads-up.

A few conventions:
- Python 3.11+, async everywhere, no blocking subprocess calls
- Type-hint public functions
- No `print()` — use `logging.getLogger(__name__)`
- Don't add comments that explain WHAT the code does; only WHY when it's non-obvious

## License

[MIT](LICENSE). Do whatever you want with this; just keep the copyright notice in copies.

### Runtime dependencies

This project's own source is MIT. Some runtime dependencies have their own licenses you should be aware of:

- **`pywebpush`** — [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/). File-level copyleft: if you ship modified copies of pywebpush's own files you must publish those modifications under MPL-2.0. Using it as a dependency in your own MIT-licensed code is fine.
- **`webauthn`** — BSD-3-Clause. Permissive; no copyleft obligations.
- **`fastapi`**, **`uvicorn`**, **`watchfiles`**, **`httpx`**, **`python-multipart`**, **`python-dotenv`** — all MIT/BSD.
- **`faster-whisper`** — MIT. The Whisper model weights themselves are MIT (OpenAI's choice). `ctranslate2` (Whisper's runtime) is MIT.

Adding new dependencies? Check the license of anything you pull in and re-evaluate this list.

Claude and Claude Code are products of [Anthropic](https://anthropic.com). This project is not affiliated with Anthropic.
