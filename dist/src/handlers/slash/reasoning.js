function sessionScope(interaction) {
    const isBotOwnedThread = interaction.channel?.isThread() &&
        interaction.channel.ownerId === interaction.client.user?.id;
    return isBotOwnedThread
        ? { key: interaction.channelId, label: "this thread" }
        : { key: interaction.user.id, label: "your session" };
}
export async function handleReasoning(interaction, sessions) {
    const sub = interaction.options.getSubcommand(true);
    try {
        await interaction.deferReply({ ephemeral: true });
        if (sub === "list") {
            const efforts = await sessions.listReasoningEfforts();
            await interaction.editReply(`**Available reasoning efforts:**\n${efforts.map((effort) => `\`${effort}\``).join(" · ")}`);
        }
        else if (sub === "set") {
            const effort = interaction.options.getString("effort", true);
            const scope = sessionScope(interaction);
            await sessions.setReasoningEffort(scope.key, effort);
            await interaction.editReply(`✅ Reasoning effort switched to \`${effort}\` for ${scope.label}. Takes effect on the next message.`);
        }
        else if (sub === "current") {
            const scope = sessionScope(interaction);
            const effort = await sessions.getCurrentReasoningEffort(scope.key);
            await interaction.editReply(`🧠 Current reasoning effort for ${scope.label}: \`${effort}\``);
        }
    }
    catch (err) {
        console.error(`[/reasoning ${sub}] Error:`, err);
        const action = sub === "list"
            ? "list reasoning efforts"
            : sub === "current"
                ? "get current reasoning effort"
                : "switch reasoning effort";
        const msg = `❌ Failed to ${action}. Please try again.`;
        if (interaction.deferred) {
            await interaction.editReply(msg);
        }
        else {
            await interaction.reply({ content: msg, ephemeral: true });
        }
    }
}
