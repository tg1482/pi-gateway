# pi-gateway (WIP)

Unified messaging gateway for Pi sessions across Discord + Slack.

## Goals

- pi-discord style architecture (extension + detached daemon)
- route-scoped persistent Pi sessions
- one session per route key (thread/channel/message mode)
- durable route queues + journaled transport context
- transport adapters (Discord, Slack)

## Current status

This is an initial working skeleton. It includes:

- `/gateway` Pi command (`setup`, `start`, `stop`, `status`, `logs`, `open-config`)
- detached daemon supervisor
- route registry + queue + journal on disk
- Discord adapter (mentions + DMs)
- Slack adapter (mentions + DMs via Socket Mode)
- per-route session execution roots under `~/.pi/agent/pi-gateway/workspaces`
- inbound attachment download + prompt context injection
- route memory files: `MEMORY.md` + `MEMORY_DAILY/YYYY-MM-DD.md`

## Install locally

```bash
cd ~/dev/pi-gateway
npm install
```

Then install in Pi:

```bash
pi install ~/dev/pi-gateway
```

Restart Pi, then:

```text
/gateway setup
/gateway start
```

## Config path

`~/.pi/agent/pi-gateway/config.json`

## Production daemon startup (Hetzner / server)

Use the provided startup script so API keys + defaults are loaded consistently.

```bash
cd /opt/pi-gateway
./scripts/gateway-daemon.sh start
./scripts/gateway-daemon.sh status
./scripts/gateway-daemon.sh logs 200
```

The startup script loads env files in this order:

1. `/opt/momster/.env`
2. `/opt/pi-gateway/.env`
3. `<workspace>/.env` (default workspace: `/root/.pi/agent/pi-gateway`)

Optional model default override:

```bash
export PI_GATEWAY_DEFAULT_MODEL="anthropic/claude-sonnet-4-5"
```

You can also install a systemd service:

```bash
cd /opt/pi-gateway
./scripts/install-systemd.sh
systemctl status pi-gateway
```

## Notes

- This is intentionally transport-agnostic in core runtime.
- It is built to evolve into fully declarative routing/session policies.
