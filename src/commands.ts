import { SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask Codex a one-shot question (no session history)")
    .addStringOption((opt) =>
      opt
        .setName("prompt")
        .setDescription("Your question or prompt")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("workspace")
        .setDescription("Path to a workspace directory to load .vscode/mcp.json from (e.g. /mnt/e/Docker)")
        .setRequired(false)
    )
    .addAttachmentOption((opt) =>
      opt
        .setName("image")
        .setDescription("An image for Codex to analyze as context")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Chat with Codex using persistent session history")
    .addStringOption((opt) =>
      opt
        .setName("message")
        .setDescription("Your message")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("workspace")
        .setDescription("Path to a workspace directory to load .vscode/mcp.json from (e.g. /mnt/e/Docker)")
        .setRequired(false)
    )
    .addAttachmentOption((opt) =>
      opt
        .setName("image")
        .setDescription("An image for Codex to analyze as context")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Clear your Codex session history"),

  new SlashCommandBuilder()
    .setName("servers")
    .setDescription("List all servers this bot is currently installed in"),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Remove this bot from a server")
    .addStringOption((opt) =>
      opt
        .setName("guild_id")
        .setDescription("The server ID to leave (get IDs from /servers)")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("List available models or switch the model for your session")
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List all available models")
    )
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Switch to a different model (takes effect on your next message)")
        .addStringOption((opt) =>
          opt
            .setName("model_id")
            .setDescription("Model ID to switch to (e.g. gpt-5.1-codex-max)")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("current").setDescription("Show the current model for your session")
    ),
  new SlashCommandBuilder()
    .setName("reasoning")
    .setDescription("List or change the reasoning effort for your session")
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List available reasoning effort levels")
    )
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Change reasoning effort (takes effect on your next message)")
        .addStringOption((opt) =>
          opt
            .setName("effort")
            .setDescription("Reasoning effort level")
            .setRequired(true)
            .addChoices(
              { name: "Minimal", value: "minimal" },
              { name: "Low", value: "low" },
              { name: "Medium", value: "medium" },
              { name: "High", value: "high" },
              { name: "Extra high", value: "xhigh" }
            )
        )
    )
    .addSubcommand((sub) =>
      sub.setName("current").setDescription("Show the current reasoning effort for your session")
    ),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show Codex auth status and CLI version"),

  new SlashCommandBuilder()
    .setName("history")
    .setDescription("Show your recent conversation history")
    .addIntegerOption((opt) =>
      opt
        .setName("count")
        .setDescription("Number of exchanges to show (default: 5, max: 20)")
        .setMinValue(1)
        .setMaxValue(20)
    ),

  new SlashCommandBuilder()
    .setName("mcp")
    .setDescription("Manage MCP servers for your session")
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List all MCP servers")
    )
    .addSubcommand((sub) =>
      sub
        .setName("workspace")
        .setDescription("Set the workspace directory to load .vscode/mcp.json from")
        .addStringOption((opt) =>
          opt
            .setName("path")
            .setDescription("Workspace directory path, e.g. /mnt/e/Docker")
            .setRequired(true)
        )
    ),
];

export type CommandName =
  | "ask"
  | "chat"
  | "reset"
  | "servers"
  | "leave"
  | "model"
  | "reasoning"
  | "status"
  | "history"
  | "mcp";
