# AI Assistant Codex SDK

A personal Discord bot backed by [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk). It lets you chat with Codex from Discord channels, DMs, and bot-owned threads while keeping isolated Codex threads per Discord user or thread.

## Features

- `/chat` creates a dedicated Discord thread for a persistent Codex conversation.
- Mentions and configured free-chat channels continue the matching Codex thread.
- `/ask` runs a one-shot prompt in a temporary session.
- Image attachments are forwarded to Codex as local image inputs.
- `workspace` options set the Codex working directory for a session.
- `/model set` stores a per-session model override for the next turn.
- `/reasoning` lists, shows, and changes per-session reasoning effort.
- New Codex threads default to `gpt-5.6-sol` with low reasoning effort.
- `/history`, `/reset`, `/status`, `/servers`, `/leave`, and `/mcp` cover basic bot and session management.

Codex threads are persisted by Codex under `~/.codex/sessions`; this bot stores the Discord key to Codex thread ID mapping under `~/.config/ai-assistant/sessions.json`.

## Quick Install

```bash
# Install directly from GitHub (no cloning required)
npm install -g --install-links github:Rubiss-Projects/ai-assistant-codex-sdk

# Run the setup wizard - creates ~/.ai-assistant/.env
ai-assistant setup

# Start the bot
ai-assistant start

# Optional: install as a systemd service (auto-start on boot)
ai-assistant install-service
```

Update to latest:

```bash
npm install -g --install-links github:Rubiss-Projects/ai-assistant-codex-sdk
# or: ai-assistant update  (prints the command)
```

## Migrating From The Copilot Version

The Discord configuration is the same. Existing values for `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `DISCORD_FREE_CHANNELS`, `DISCORD_ALLOWED_USERS`, and `MCP_INPUT_*` can be reused as-is.

The AI configuration changes:

| Copilot version | Codex version |
| --- | --- |
| `COPILOT_TIMEOUT_MS` | `CODEX_TIMEOUT_MS` |
| GitHub/Copilot auth through `gh` | Codex CLI auth or `OPENAI_API_KEY` |
| Copilot model IDs | Codex/OpenAI model IDs via optional `CODEX_MODEL` or `/model set` overrides |

Replacement flow for a global install:

```bash
# If running as a service
sudo systemctl stop ai-assistant

# Replace the globally installed package
npm install -g --install-links github:Rubiss-Projects/ai-assistant-codex-sdk

# Update ~/.ai-assistant/.env interactively.
# Existing Discord values are preserved as prompts defaults.
ai-assistant setup

# Or edit ~/.ai-assistant/.env manually:
#   rename COPILOT_TIMEOUT_MS to CODEX_TIMEOUT_MS
#   add OPENAI_API_KEY=... unless relying on Codex CLI auth
#   optionally add CODEX_MODEL=... to override gpt-5.6-sol

# Replace guild slash commands with the Codex command set
ai-assistant register

# Refresh the systemd unit if you use it, then start
ai-assistant install-service
sudo systemctl start ai-assistant
```

Users who run the bot manually can skip the `systemctl` and `install-service` commands and run `ai-assistant start` after `ai-assistant register`.

## Requirements

- Node.js 18+
- A Discord application with a bot user
- Codex CLI authentication, or `OPENAI_API_KEY` in the bot environment

## Setup

```bash
git clone git@github.com:Rubiss-Projects/ai-assistant-codex-sdk.git
cd ai-assistant-codex-sdk
npm install
cp .env.example .env
```

Fill in `.env`:

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_APP_ID=your_application_id_here
DISCORD_GUILD_ID=your_test_server_id_here
OPENAI_API_KEY=sk-...
```

`OPENAI_API_KEY` is optional when the Codex CLI is already logged in for the same user that runs the bot.

The bot defaults new Codex threads to `gpt-5.6-sol` with low reasoning effort. Set
`CODEX_MODEL` or use `/model set` to override the model. Use `/reasoning set` to change
reasoning effort for a user session or bot-owned thread.

Register slash commands:

```bash
npm run register
```

Start the bot:

```bash
npm start
```

## Slash Commands

| Command | Description |
| --- | --- |
| `/ask <prompt>` | One-shot Codex prompt with no reusable Discord session history |
| `/chat <message>` | Start or continue a persistent Codex conversation |
| `/reset` | Clear this Discord key's stored Codex thread mapping |
| `/model list` | Show Codex CLI model-cache IDs plus the default model and overrides |
| `/model set <model_id>` | Set a model override for the next turn in this user/thread session |
| `/model current` | Show the effective model for this user/thread session |
| `/reasoning list` | Show supported reasoning effort levels |
| `/reasoning set <effort>` | Set reasoning effort for the next turn in this user/thread session |
| `/reasoning current` | Show the effective reasoning effort for this user/thread session |
| `/status` | Show Codex package/auth environment status |
| `/history [count]` | Show recent in-process user/assistant exchanges |
| `/mcp list` | Show VS Code-style MCP configs visible to the bot |
| `/mcp workspace <path>` | Set the workspace directory used for a session |
| `/servers` | List Discord servers the bot is installed in |
| `/leave <guild_id>` | Remove the bot from a server |

## Development

```bash
npm run build
npm test
```

Project entry points:

- `src/codex.ts`: Codex SDK adapter and session manager
- `src/bot.ts`: Discord client and command routing
- `src/commands.ts`: slash command definitions
- `scripts/register-commands.ts`: command registration script

## Security

Codex can read and modify files and run commands in the configured workspace. Use `DISCORD_ALLOWED_USERS` to restrict access, and only run the bot for Discord users you trust.
