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
    ChannelType,
    PermissionFlagsBits
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

                "<:exclamacoes:1548095775873961985> **— POLÍTICA DE ESTORNO**\n" +
                "> <a:animatedarrowgreen:1548150127414480966> Após a entrega dos Robux, **não será possível realizar estorno**, pois os Robux enviados não podem ser devolvidos à RZ Store.\n" +
                "> <a:animatedarrowgreen:1548150127414480966> Ao realizar a compra, você declara estar ciente desta condição, ressalvados eventuais direitos previstos em lei.\n" +
                "> <a:animatedarrowgreen:1548150127414480966> O estorno será realizado apenas se não tivermos estoque para o envio do Robux\n\n" +

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
                    .setDescription("Escolha exatamente quantos Robux deseja")
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
        await interaction.message.edit({
    components: interaction.message.components.map(row => row.toJSON())
});

        // =========================================
        // QUANTIDADE PERSONALIZADA
        // =========================================

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


        // =========================================
        // QUANTIDADES PRONTAS
        // =========================================

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


        // BOTÕES
        const botoes = new ActionRowBuilder()
            .addComponents(

                new ButtonBuilder()
                    .setCustomId(`confirmar_compra_${quantidade}`)
                    .setLabel("Confirmar compra")
                    .setEmoji("✅")
                    .setStyle(ButtonStyle.Success),

                new ButtonBuilder()
                    .setCustomId("cancelar_compra")
                    .setLabel("Cancelar")
                    .setEmoji("✖️")
                    .setStyle(ButtonStyle.Danger)

            );


        await interaction.reply({
            embeds: [embedConfirmacao],
            components: [botoes],
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


        // BOTÕES
        const botoes = new ActionRowBuilder()
            .addComponents(

                new ButtonBuilder()
                    .setCustomId(`confirmar_compra_${quantidade}`)
                    .setLabel("Confirmar compra")
                    .setEmoji("✅")
                    .setStyle(ButtonStyle.Success),

                new ButtonBuilder()
                    .setCustomId("cancelar_compra")
                    .setLabel("Cancelar")
                    .setEmoji("✖️")
                    .setStyle(ButtonStyle.Danger)

            );


        await interaction.reply({
            embeds: [embedConfirmacao],
            components: [botoes],
            ephemeral: true
        });

        return;
    }


    // =========================================
    // BOTÕES
    // =========================================

    if (interaction.isButton()) {

        // =========================================
        // CONFIRMAR COMPRA
        // =========================================

        if (
    interaction.customId.startsWith(
        "confirmar_compra_"
    )
) {

    const quantidade = Number(
        interaction.customId.replace(
            "confirmar_compra_",
            ""
        )
    );

    const valor = (quantidade / 100) * 3.20;

    const quantidadeFormatada =
        quantidade.toLocaleString("pt-BR");

    const valorFormatado =
        valor.toLocaleString("pt-BR", {
            style: "currency",
            currency: "BRL"
        });

    const guild = interaction.guild;

    const ticketExistente = guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildText &&
    channel.parentId === process.env.CATEGORY_TICKETS_ID &&
    (
        channel.topic?.includes(`rzstore-user:${interaction.user.id}`) ||
        channel.topic?.includes(`ID: ${interaction.user.id}`)
    )
);

if (ticketExistente) {

    const embedTicketExistente = new EmbedBuilder()
        .setColor("#00db0f")
        .setTitle("⚠️ Você já possui um ticket aberto")
        .setDescription(
            `Você já tem uma compra em andamento.\n\n` +
            `Acesse seu ticket: ${ticketExistente}\n\n` +
            `Finalize ou feche esse ticket antes de iniciar outra compra.`
        )
        .setFooter({
            text: "RZ Store"
        });

    await interaction.update({
        embeds: [embedTicketExistente],
        components: []
    });

    return;
}

    const nomeUsuario = interaction.user.username
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 15);

    try {

        const ticket = await guild.channels.create({

            name: `compra-${nomeUsuario}`,

            type: ChannelType.GuildText,

            parent: process.env.CATEGORY_TICKETS_ID,

            topic: `RZ Store | rzstore-user:${interaction.user.id} | Compra de ${interaction.user.tag}`,

            permissionOverwrites: [

                // @everyone não vê
                {
                    id: guild.roles.everyone.id,
                    deny: [
                        PermissionFlagsBits.ViewChannel
                    ]
                },

                // CLIENTE
                {
                    id: interaction.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks
                    ]
                },

                // EQUIPE
                {
                    id: process.env.STAFF_ROLE_ID,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.ManageMessages
                    ]
                }

            ]

        });

        const embedTicket = new EmbedBuilder()
            .setColor("#00db0f")
            .setTitle(
                "<:greencart:1548089836647485591> Novo pedido — RZ Store"
            )
            .setDescription(
                `Olá ${interaction.user}! Seu ticket de compra foi criado com sucesso.\n\n` +

                `### <:greenrbx:1548088739677470881> Detalhes do pedido\n` +
                `> **Cliente:** ${interaction.user}\n` +
                `> **Quantidade:** ${quantidadeFormatada} Robux\n` +
                `> <:pix:1548090281402966107> **Valor:** ${valorFormatado}\n\n` +

                `### ⏳ Status\n` +
                `> Aguardando pagamento.\n\n` +

                `Em breve o pagamento via PIX será gerado neste canal.`
            )
            .setFooter({
                text: "RZ Store"
            })
            .setTimestamp();

        const botaoFecharTicket = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId("fechar_ticket")
                    .setLabel("Fechar ticket")
                    .setEmoji("🔒")
                    .setStyle(ButtonStyle.Danger)
            );

        await ticket.send({
            content: `${interaction.user} <@&${process.env.STAFF_ROLE_ID}>`,
            embeds: [embedTicket],
            components: [botaoFecharTicket]
        });

        const embedCriado = new EmbedBuilder()
            .setColor("#00db0f")
            .setTitle("✅ Ticket criado!")
            .setDescription(
                `Seu pedido foi confirmado.\n\n` +
                `<:greenrbx:1548088739677470881> **${quantidadeFormatada} Robux**\n` +
                `<:pix:1548090281402966107> **${valorFormatado}**\n\n` +
                `Acesse seu ticket: ${ticket}`
            )
            .setFooter({
                text: "RZ Store"
            });

        await interaction.update({
            embeds: [embedCriado],
            components: []
        });

    } catch (error) {

        console.error("Erro ao criar ticket:", error);

        await interaction.update({
            content:
                "❌ Ocorreu um erro ao criar seu ticket. Entre em contato com a equipe.",
            embeds: [],
            components: []
        });

    }

    return;
}



        // =========================================
        // CANCELAR COMPRA
        // =========================================

        if (
            interaction.customId === "cancelar_compra"
        ) {

            const embedCancelado = new EmbedBuilder()
                .setColor("#ff0000")
                .setTitle(
                    "❌ Compra cancelada"
                )
                .setDescription(
                    "A compra foi cancelada.\n\n" +
                    "Você pode selecionar outra quantidade no painel quando quiser."
                )
                .setFooter({
                    text: "RZ Store"
                });

            await interaction.update({
                embeds: [embedCancelado],
                components: []
            });

            return;
        }


        // =========================================
        // FECHAR TICKET
        // =========================================

        if (
            interaction.customId === "fechar_ticket"
        ) {

            if (
                !interaction.member.roles.cache.has(
                    process.env.STAFF_ROLE_ID
                )
            ) {

                await interaction.reply({
                    content:
                        "❌ Apenas a equipe da RZ Store pode fechar este ticket.",
                    ephemeral: true
                });

                return;
            }

            const confirmarFechamento = new ActionRowBuilder()
                .addComponents(

                    new ButtonBuilder()
                        .setCustomId("confirmar_fechar_ticket")
                        .setLabel("Sim, fechar")
                        .setEmoji("✅")
                        .setStyle(ButtonStyle.Danger),

                    new ButtonBuilder()
                        .setCustomId("cancelar_fechar_ticket")
                        .setLabel("Cancelar")
                        .setEmoji("✖️")
                        .setStyle(ButtonStyle.Secondary)

                );

            await interaction.reply({
                content:
                    "⚠️ **Tem certeza que deseja fechar este ticket?**\n\n" +
                    "O canal será apagado.",
                components: [confirmarFechamento],
                ephemeral: true
            });

            return;
        }


        // =========================================
        // CONFIRMAR FECHAMENTO DO TICKET
        // =========================================

        if (
            interaction.customId === "confirmar_fechar_ticket"
        ) {

            if (
                !interaction.member.roles.cache.has(
                    process.env.STAFF_ROLE_ID
                )
            ) {

                await interaction.reply({
                    content:
                        "❌ Apenas a equipe da RZ Store pode fechar este ticket.",
                    ephemeral: true
                });

                return;
            }

            const ehTicketRZ =
                interaction.channel.parentId ===
                    process.env.CATEGORY_TICKETS_ID &&
                interaction.channel.topic?.includes(
                    "RZ Store | rzstore-user:"
                );

            if (!ehTicketRZ) {

                await interaction.update({
                    content:
                        "❌ Este canal não foi reconhecido como um ticket de compra da RZ Store.",
                    components: []
                });

                return;
            }

            await interaction.update({
                content:
                    "🔒 Ticket fechado. Este canal será apagado em **3 segundos**.",
                components: []
            });

            setTimeout(async () => {

                try {

                    await interaction.channel.delete(
                        `Ticket fechado por ${interaction.user.tag}`
                    );

                } catch (error) {

                    console.error(
                        "Erro ao apagar ticket:",
                        error
                    );

                }

            }, 3000);

            return;
        }


        // =========================================
        // CANCELAR FECHAMENTO DO TICKET
        // =========================================

        if (
            interaction.customId === "cancelar_fechar_ticket"
        ) {

            if (
                !interaction.member.roles.cache.has(
                    process.env.STAFF_ROLE_ID
                )
            ) {

                await interaction.reply({
                    content:
                        "❌ Apenas a equipe da RZ Store pode fechar este ticket.",
                    ephemeral: true
                });

                return;
            }

            await interaction.update({
                content: "✅ Fechamento cancelado.",
                components: []
            });

            return;
        }

    }

});

client.login(process.env.DISCORD_TOKEN);
