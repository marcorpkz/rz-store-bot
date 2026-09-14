require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    Events,
    SlashCommandBuilder,
    REST,
    Routes,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});

client.once("clientReady", async () => {

    console.log(`Bot online como ${client.user.tag}`);

    const commands = [
        new SlashCommandBuilder()
            .setName("setupcomprar")
            .setDescription("Cria o painel de compra de Robux")
    ].map(command => command.toJSON());

    const rest = new REST({ version: "10" })
        .setToken(process.env.DISCORD_TOKEN);

    try {

        await rest.put(
            Routes.applicationGuildCommands(
                client.user.id,
                process.env.GUILD_ID
            ),
            {
                body: commands
            }
        );

        console.log("Comando /setupcomprar registrado no servidor.");

    } catch (error) {

        console.error(error);

    }

});

client.on(Events.InteractionCreate, async interaction => {

    // =========================================
    // COMANDO /setupcomprar
    // =========================================

    if (
        interaction.isChatInputCommand() &&
        interaction.commandName === "setupcomprar"
    ) {

        const embed = new EmbedBuilder()
            .setColor("#00db0f")
            .setTitle(
                "<:greenrbx:1548088739677470881> Comprar Robux — RZ Store"
            )
            .setDescription(
                "## ‹ ROBUX VIA GRUPO ⇄ RZ STORE ›\n\n" +

                "<:exclamacoes:1548095775873961985> **— REQUISITO PARA RECEBER OS ROBUX**\n" +
                "> <a:animatedarrowgreen:1548150127414480966> É necessário estar em nosso grupo do Roblox antes da entrega.\n" +
                "> <a:animatedarrowgreen:1548150127414480966> Certifique-se de que sua conta está apta para receber os Robux.\n\n" +

                "<:greencart:1548089836647485591> **— COMO FUNCIONA A COMPRA**\n" +
                "> <a:animatedarrowgreen:1548150127414480966> Selecione abaixo a quantidade de Robux desejada.\n" +
                "> <a:animatedarrowgreen:1548150127414480966> Você também pode escolher uma quantidade personalizada.\n" +
                "> <a:animatedarrowgreen:1548150127414480966> Cada **<:greenrbx:1548088739677470881> 100 custa R$ 3,20**.\n\n" +

                "<:pix:1548090281402966107> **— APÓS O PAGAMENTO**\n" +
                "> <a:greenverification:1548192162653536336> O pagamento será confirmado automaticamente.\n" +
                "> <:roblox:1548176792010104923> Após a confirmação, envie seu **nome de usuário do Roblox ou ID**.\n\n" +

                "<:greenrbx:1548088739677470881> **— ENTREGA DOS ROBUX**\n" +
                "> <a:animatedarrowgreen:1548150127414480966> Os Robux serão enviados manualmente pela equipe da RZ Store.\n" +
                "> <a:animatedarrowgreen:1548150127414480966> Em alguns casos, a transferência pode ficar pendente pelo sistema do Roblox.\n\n" +

                "<:interrogacoes:1548096277856649296> **— PRECISOU DE AJUDA?**\n" +
                "> <:sup:1548200025442750505> Nossa equipe estará disponível no seu ticket para ajudar."
            )
            .setImage(
                "https://media.discordapp.net/attachments/1548159183071879228/1548159323501363331/banner.png?ex=6aa8057a&is=6aa6b3fa&hm=6a052829674664f1687c06df6aaac6566c3492f8affed0d0437c965411e89e8c&=&format=webp&quality=lossless&width=2048&height=688"
            )
            .setFooter({
                text: "RZ Store"
            });

        const menu = new StringSelectMenuBuilder()
            .setCustomId("comprar_robux")
            .setPlaceholder("Clique aqui para ver as opções")
            .addOptions(

                new StringSelectMenuOptionBuilder()
                    .setLabel("Quantidade personalizada")
                    .setDescription(
                        "Escolha exatamente quantos Robux deseja"
                    )
                    .setValue("personalizado")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("200 Robux")
                    .setDescription("Preço: R$ 6,40")
                    .setValue("200")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("300 Robux")
                    .setDescription("Preço: R$ 9,60")
                    .setValue("300")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("400 Robux")
                    .setDescription("Preço: R$ 12,80")
                    .setValue("400")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("500 Robux")
                    .setDescription("Preço: R$ 16,00")
                    .setValue("500")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("600 Robux")
                    .setDescription("Preço: R$ 19,20")
                    .setValue("600")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("700 Robux")
                    .setDescription("Preço: R$ 22,40")
                    .setValue("700")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("800 Robux")
                    .setDescription("Preço: R$ 25,60")
                    .setValue("800")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("900 Robux")
                    .setDescription("Preço: R$ 28,80")
                    .setValue("900")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("1.000 Robux")
                    .setDescription("Preço: R$ 32,00")
                    .setValue("1000")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("1.500 Robux")
                    .setDescription("Preço: R$ 48,00")
                    .setValue("1500")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("2.000 Robux")
                    .setDescription("Preço: R$ 64,00")
                    .setValue("2000")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("2.500 Robux")
                    .setDescription("Preço: R$ 80,00")
                    .setValue("2500")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("3.000 Robux")
                    .setDescription("Preço: R$ 96,00")
                    .setValue("3000")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("4.000 Robux")
                    .setDescription("Preço: R$ 128,00")
                    .setValue("4000")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("5.000 Robux")
                    .setDescription("Preço: R$ 160,00")
                    .setValue("5000")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("10.000 Robux")
                    .setDescription("Preço: R$ 320,00")
                    .setValue("10000")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("20.000 Robux")
                    .setDescription("Preço: R$ 640,00")
                    .setValue("20000")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("30.000 Robux")
                    .setDescription("Preço: R$ 960,00")
                    .setValue("30000")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("40.000 Robux")
                    .setDescription("Preço: R$ 1.280,00")
                    .setValue("40000")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("50.000 Robux")
                    .setDescription("Preço: R$ 1.600,00")
                    .setValue("50000")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("100.000 Robux")
                    .setDescription("Preço: R$ 3.200,00")
                    .setValue("100000")
                    .setEmoji({
                        id: "1548088739677470881",
                        name: "greenrbx"
                    })
            );

        const row = new ActionRowBuilder()
            .addComponents(menu);

        await interaction.reply({
            content: "✅ Painel de compra criado!",
            ephemeral: true
        });

        await interaction.channel.send({
            embeds: [embed],
            components: [row]
        });

        return;
    }

    // =========================================
    // MENU DE ROBUX
    // =========================================

    if (
        interaction.isStringSelectMenu() &&
        interaction.customId === "comprar_robux"
    ) {

        const opcao = interaction.values[0];

        // QUANTIDADE PERSONALIZADA
        if (opcao === "personalizado") {

            const modal = new ModalBuilder()
                .setCustomId("modal_quantidade_robux")
                .setTitle("Quantidade personalizada");

            const quantidadeInput = new TextInputBuilder()
                .setCustomId("quantidade_robux")
                .setLabel("Quantos Robux você deseja?")
                .setPlaceholder("Exemplo: 1750")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMinLength(2)
                .setMaxLength(6);

            const row = new ActionRowBuilder()
                .addComponents(quantidadeInput);

            modal.addComponents(row);

            await interaction.showModal(modal);

            return;
        }

        // QUANTIDADES PRONTAS
        const quantidade = Number(opcao);

        const valor = (quantidade / 100) * 3.20;

        const valorFormatado = valor.toLocaleString("pt-BR", {
            style: "currency",
            currency: "BRL"
        });

        const quantidadeFormatada =
            quantidade.toLocaleString("pt-BR");

        const embedConfirmacao = new EmbedBuilder()
            .setColor("#00db0f")
            .setTitle(
                "<:greenrbx:1548088739677470881> Compra de Robux"
            )
            .setDescription(
                `Você selecionou **${quantidadeFormatada} Robux**.\n\n` +
                `<:pix:1548090281402966107> **Valor:** ${valorFormatado}`
            )
            .setFooter({
                text: "RZ Store"
            });

        await interaction.reply({
            embeds: [embedConfirmacao],
            ephemeral: true
        });

        return;
    }

    // =========================================
    // MODAL DE QUANTIDADE PERSONALIZADA
    // =========================================

    if (
        interaction.isModalSubmit() &&
        interaction.customId === "modal_quantidade_robux"
    ) {

        const texto = interaction.fields
            .getTextInputValue("quantidade_robux");

        const quantidade = Number(texto);

        if (
            !Number.isInteger(quantidade) ||
            quantidade < 100
        ) {

            await interaction.reply({
                content:
                    "❌ Digite uma quantidade válida de pelo menos **100 Robux**.",
                ephemeral: true
            });

            return;
        }

        const valor = (quantidade / 100) * 3.20;

        const valorFormatado = valor.toLocaleString("pt-BR", {
            style: "currency",
            currency: "BRL"
        });

        const quantidadeFormatada =
            quantidade.toLocaleString("pt-BR");

        const embedConfirmacao = new EmbedBuilder()
            .setColor("#00db0f")
            .setTitle(
                "<:greenrbx:1548088739677470881> Quantidade personalizada"
            )
            .setDescription(
                `Você selecionou **${quantidadeFormatada} Robux**.\n\n` +
                `<:pix:1548090281402966107> **Valor:** ${valorFormatado}`
            )
            .setFooter({
                text: "RZ Store"
            });

        await interaction.reply({
            embeds: [embedConfirmacao],
            ephemeral: true
        });

        return;
    }

});

client.login(process.env.DISCORD_TOKEN);