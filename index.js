require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    Events,
    SlashCommandBuilder,
    REST,
    Routes,
    EmbedBuilder,
    AttachmentBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionFlagsBits,
    MessageFlags
} = require("discord.js");


const {
    MercadoPagoConfig,
    Order
} = require("mercadopago");

const QRCode = require("qrcode");
const { randomUUID } = require("crypto");

const mercadoPagoClient = new MercadoPagoConfig({
    accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN,
    options: {
        timeout: 5000
    }
});

const mercadoPagoOrder = new Order(mercadoPagoClient);

const MERCADO_PAGO_TEST_MODE =
    process.env.MERCADO_PAGO_TEST_MODE === "true";

async function criarCobrancaPix({
    valorCentavos,
    descricao,
    discordUserId,
    channelId,
    payerEmail
}) {

    const valorPedido = valorCentavos / 100;

    const accessToken =
        process.env.MERCADO_PAGO_ACCESS_TOKEN?.trim();

    if (!accessToken) {
        throw new Error(
            "MERCADO_PAGO_ACCESS_TOKEN não foi encontrado no .env."
        );
    }

    // O teste oficial de PIX da API de Orders usa valores
    // predefinidos. Mantemos o body igual ao exemplo oficial.
    const body = MERCADO_PAGO_TEST_MODE
        ? {
            type: "online",
            external_reference: "ext_ref_1234",
            total_amount: "50.00",
            payer: {
                email: "test_user_br@testuser.com",
                first_name: "APRO"
            },
            transactions: {
                payments: [
                    {
                        amount: "50.00",
                        payment_method: {
                            id: "pix",
                            type: "bank_transfer"
                        }
                    }
                ]
            }
        }
        : {
            type: "online",
            processing_mode: "automatic",
            total_amount: valorPedido.toFixed(2),
            external_reference:
                `rzstore-${discordUserId}-${channelId}`,
            payer: {
                email: payerEmail
            },
            transactions: {
                payments: [
                    {
                        amount: valorPedido.toFixed(2),
                        payment_method: {
                            id: "pix",
                            type: "bank_transfer"
                        }
                    }
                ]
            }
        };

    const resposta = await fetch(
        "https://api.mercadopago.com/v1/orders",
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-Idempotency-Key": randomUUID()
            },
            body: JSON.stringify(body)
        }
    );

    const textoResposta = await resposta.text();

    let order;

    try {
        order = JSON.parse(textoResposta);
    } catch {
        order = {
            raw_response: textoResposta
        };
    }

    if (!resposta.ok) {

        console.error(
            "Mercado Pago HTTP status:",
            resposta.status
        );

        console.error(
            "Mercado Pago body:",
            order
        );

        const detalhe =
            order?.message ||
            order?.error ||
            order?.status_detail ||
            JSON.stringify(order);

        const erro = new Error(
            `Mercado Pago retornou HTTP ${resposta.status}: ${detalhe}`
        );

        erro.status = resposta.status;
        erro.mercadoPago = order;

        throw erro;
    }

    const payment =
        order.transactions?.payments?.[0];

    const paymentMethod =
        payment?.payment_method;

    if (!paymentMethod?.qr_code) {
        throw new Error(
            "Mercado Pago criou a order, mas não retornou o código PIX."
        );
    }

    return {
        order,
        payment,
        pixCopiaCola: paymentMethod.qr_code,
        ticketUrl: paymentMethod.ticket_url,
        valorPedido,
        valorCobranca: MERCADO_PAGO_TEST_MODE
            ? 50
            : valorPedido
    };
}


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
            .setDescription("Cria o painel de compra de Robux"),

        new SlashCommandBuilder()
            .setName("korblox")
            .setDescription("Cria o painel de Korblox e Headless")
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

        console.log("Comandos /setupcomprar e /korblox registrados no servidor.");

    } catch (error) {

        console.error(error);

    }

});

async function buscarOrderMercadoPago(orderId) {

    const accessToken =
        process.env.MERCADO_PAGO_ACCESS_TOKEN?.trim();

    if (!accessToken) {
        throw new Error(
            "MERCADO_PAGO_ACCESS_TOKEN não foi encontrado no .env."
        );
    }

    const resposta = await fetch(
        `https://api.mercadopago.com/v1/orders/${orderId}`,
        {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Accept": "application/json"
            }
        }
    );

    const textoResposta = await resposta.text();

    let order;

    try {
        order = JSON.parse(textoResposta);
    } catch {
        order = {
            raw_response: textoResposta
        };
    }

    if (!resposta.ok) {

        console.error(
            "Erro ao consultar order do Mercado Pago:",
            resposta.status,
            order
        );

        throw new Error(
            `Mercado Pago retornou HTTP ${resposta.status} ao consultar a order.`
        );
    }

    return order;
}


async function enviarPixNoTicket(interaction, dados, valorCentavos) {

    const {
        order,
        payment,
        pixCopiaCola,
        ticketUrl,
        valorPedido,
        valorCobranca
    } = dados;

    const qrBuffer = await QRCode.toBuffer(
        pixCopiaCola,
        {
            type: "png",
            width: 500,
            margin: 2
        }
    );

    const qrAttachment = new AttachmentBuilder(
        qrBuffer,
        {
            name: "pix-qrcode.png"
        }
    );

    const valorPedidoFormatado =
        valorPedido.toLocaleString("pt-BR", {
            style: "currency",
            currency: "BRL"
        });

    const valorCobrancaFormatado =
        valorCobranca.toLocaleString("pt-BR", {
            style: "currency",
            currency: "BRL"
        });

    let textoValor =
        `**Valor:** ${valorPedidoFormatado}\n`;

    if (MERCADO_PAGO_TEST_MODE) {
        textoValor =
            `**Valor do pedido:** ${valorPedidoFormatado}\n` +
            `**Cobrança sandbox:** ${valorCobrancaFormatado}\n` +
            `> 🧪 Ambiente de teste do Mercado Pago: o PIX de teste usa valor predefinido.\n`;
    }

    const embedPix = new EmbedBuilder()
        .setColor("#00db0f")
        .setTitle(
            "<:pix:1548090281402966107> Pagamento via PIX"
        )
        .setDescription(
            textoValor +
            `**ID da order:** \`${order.id}\`\n` +
            `**ID do pagamento:** \`${payment?.id || "-"}\`\n\n` +
            "### PIX Copia e Cola\n" +
            `\`\`\`\n${pixCopiaCola}\n\`\`\`\n` +
            "### <:ampulheta:1549129208557469786> Status\n" +
            "> Aguardando pagamento."
        )
        .setImage("attachment://pix-qrcode.png")
        .setFooter({
            text:
                "RZ Store • Não pague duas vezes a mesma cobrança."
        })
        .setTimestamp();

    const linhaBotoesPix =
        new ActionRowBuilder();

    if (ticketUrl) {
        linhaBotoesPix.addComponents(
            new ButtonBuilder()
                .setLabel("Abrir página do PIX")
                .setStyle(ButtonStyle.Link)
                .setURL(ticketUrl)
        );
    }

    linhaBotoesPix.addComponents(
        new ButtonBuilder()
            .setCustomId("copiar_pix")
            .setLabel("Copiar PIX")
            .setEmoji("📋")
            .setStyle(ButtonStyle.Secondary)
    );

    const componentesPix = [linhaBotoesPix];

    await interaction.channel.send({
        embeds: [embedPix],
        files: [qrAttachment],
        components: componentesPix
    });

    const topicoAtual =
        interaction.channel.topic || "";

    await interaction.channel.setTopic(
        `${topicoAtual} | mp-order:${order.id} | mp-payment:${payment?.id || "-"} | mp-status:${payment?.status || order.status || "pending"}`
    );

    await interaction.editReply({
        content:
            "<:okk:1549125132906270851> PIX gerado com sucesso. Confira a cobrança acima."
    });
}


client.on(Events.InteractionCreate, async interaction => {

    // =========================================
    // COMANDO /setupcomprar
    // =========================================

    if (
        interaction.isChatInputCommand() &&
        interaction.commandName === "setupcomprar"
    ) {


        // Apenas a equipe da RZ Store pode usar este comando
        if (
            !interaction.member.roles.cache.has(
                process.env.STAFF_ROLE_ID
            )
        ) {
            await interaction.reply({
                content: "<:x_:1549124126575165533> Apenas a equipe da RZ Store pode usar este comando.",
                flags: MessageFlags.Ephemeral
            });

            return;
        }

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
            content: "<:okk:1549125132906270851> Painel de compra criado!",
            flags: MessageFlags.Ephemeral
        });

        await interaction.channel.send({
            embeds: [embed],
            components: [row]
        });

        return;
    }


    // =========================================
    // COMANDO /korblox
    // =========================================

    if (
        interaction.isChatInputCommand() &&
        interaction.commandName === "korblox"
    ) {


        // Apenas a equipe da RZ Store pode usar este comando
        if (
            !interaction.member.roles.cache.has(
                process.env.STAFF_ROLE_ID
            )
        ) {
            await interaction.reply({
                content: "<:x_:1549124126575165533> Apenas a equipe da RZ Store pode usar este comando.",
                flags: MessageFlags.Ephemeral
            });

            return;
        }

        

        const embedKorblox = new EmbedBuilder()
            .setColor("#00db0f")
            .setTitle("<:coroa:1548189671501078588> Korblox & Headless — RZ Store")
            .setDescription(
                "## ‹ KORBLOX & HEADLESS ⇄ RZ STORE ›\n\n" +

                "<:greencart:1548089836647485591> **— ESCOLHA SEU ITEM**\n" +
                "> <a:animatedarrowgreen:1548150127414480966> **Korblox:** 17.000 Robux — **R$ 544,00**\n" +
                "> <a:animatedarrowgreen:1548150127414480966> **Headless:** 31.000 Robux — **R$ 992,00**\n\n" +

                "<:pix:1548090281402966107> **— COMO FUNCIONA A COMPRA**\n" +
                "> <a:animatedarrowgreen:1548150127414480966> Selecione abaixo a quantidade de Robux que deseja comprar.\n" +
                "> <a:animatedarrowgreen:1548150127414480966> Confirme o pedido para criar seu ticket privado.\n" +
                "> <a:animatedarrowgreen:1548150127414480966> O pagamento e a entrega serão acompanhados pela equipe no ticket.\n\n" +

                "<:exclamacoes:1548095775873961985> **— POLÍTICA DE ESTORNO**\n" +
                "> <a:animatedarrowgreen:1548150127414480966> Após a entrega do Robux, **não será possível realizar estorno**.\n" +
                "> <a:animatedarrowgreen:1548150127414480966> O estorno será realizado apenas se não tivermos estoque para realizar a entrega.\n\n" +

                "<:interrogacoes:1548096277856649296> **— PRECISOU DE AJUDA?**\n" +
                "> <:sup:1548200025442750505> Nossa equipe estará disponível no seu ticket para ajudar."
            )
            .setImage("https://cdn.discordapp.com/attachments/1548159183071879228/1548159369059762218/korblox_headless.png?ex=6aa95704&is=6aa80584&hm=2396d2211826f3393801d7e6644acc954fa14b8c0aa5e1cc964b9803a82b2313&")
            .setFooter({
                text: "RZ Store"
            });

        const menuKorblox = new StringSelectMenuBuilder()
            .setCustomId("comprar_korblox_headless")
            .setPlaceholder("Clique aqui para escolher o item")
            .addOptions(

                new StringSelectMenuOptionBuilder()
                    .setLabel("Korblox")
                    .setDescription("17.000 Robux • R$ 544,00")
                    .setValue("korblox")
                    .setEmoji({
                        id: "1549132176048525363",
                        name: "korblox"
                    }),

                new StringSelectMenuOptionBuilder()
                    .setLabel("Headless")
                    .setDescription("31.000 Robux • R$ 992,00")
                    .setValue("headless")
                    .setEmoji({
                        id: "1549132702249259109",
                        name: "headless"
                    })
            );

        const rowKorblox = new ActionRowBuilder()
            .addComponents(menuKorblox);

        await interaction.reply({
            content: "<:okk:1549125132906270851> Painel de Korblox e Headless criado!",
            flags: MessageFlags.Ephemeral
        });

        await interaction.channel.send({
        embeds: [embedKorblox],
        components: [rowKorblox]
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
                    .setEmoji({
                        id: "1549125132906270851",
                        name: "okk"
                    })
                    .setStyle(ButtonStyle.Success),

                new ButtonBuilder()
                    .setCustomId("cancelar_compra")
                    .setLabel("Cancelar")
                    .setEmoji({
                        id: "1549124126575165533",
                        name: "x_"
                    })
                    .setStyle(ButtonStyle.Danger)

            );


        await interaction.reply({
            embeds: [embedConfirmacao],
            components: [botoes],
            flags: MessageFlags.Ephemeral
        });

        return;
    }


    // =========================================
    // MENU KORBLOX / HEADLESS
    // =========================================

    if (
        interaction.isStringSelectMenu() &&
        interaction.customId === "comprar_korblox_headless"
    ) {

        const opcao = interaction.values[0];

        await interaction.message.edit({
            components: interaction.message.components.map(row => row.toJSON())
        });

        const produtos = {
            korblox: {
                nome: "Korblox",
                robux: 17000,
                valor: 544
            },
            headless: {
                nome: "Headless",
                robux: 31000,
                valor: 992
            }
        };

        const produto = produtos[opcao];

        if (!produto) {
            await interaction.reply({
                content: "<:x_:1549124126575165533> Produto inválido.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const robuxFormatado = produto.robux.toLocaleString("pt-BR");
        const valorFormatado = produto.valor.toLocaleString("pt-BR", {
            style: "currency",
            currency: "BRL"
        });

        const embedConfirmacaoItem = new EmbedBuilder()
            .setColor("#00db0f")
            .setTitle(`<:greencart:1548089836647485591> Compra de ${produto.nome}`)
            .setDescription(
                `Você selecionou **${produto.nome}**.\n\n` +
                `<:greenrbx:1548088739677470881> **Preço em Robux:** ${robuxFormatado}\n` +
                `<:pix:1548090281402966107> **Valor:** ${valorFormatado}`
            )
            .setFooter({
                text: "RZ Store"
            });

        const botoesItem = new ActionRowBuilder()
            .addComponents(

                new ButtonBuilder()
                    .setCustomId(`confirmar_item_${opcao}`)
                    .setLabel("Confirmar compra")
                    .setEmoji({
                        id: "1549125132906270851",
                        name: "okk"
                    })
                    .setStyle(ButtonStyle.Success),

                new ButtonBuilder()
                    .setCustomId("cancelar_compra")
                    .setLabel("Cancelar")
                    .setEmoji({
                        id: "1549124126575165533",
                        name: "x_"
                    })
                    .setStyle(ButtonStyle.Danger)
            );

        await interaction.reply({
            embeds: [embedConfirmacaoItem],
            components: [botoesItem],
            flags: MessageFlags.Ephemeral
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
                    "<:x_:1549124126575165533> Digite uma quantidade válida de pelo menos **100 Robux**.",
                flags: MessageFlags.Ephemeral
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
                    .setEmoji({
                        id: "1549125132906270851",
                        name: "okk"
                    })
                    .setStyle(ButtonStyle.Success),

                new ButtonBuilder()
                    .setCustomId("cancelar_compra")
                    .setLabel("Cancelar")
                    .setEmoji({
                        id: "1549124126575165533",
                        name: "x_"
                    })
                    .setStyle(ButtonStyle.Danger)

            );


        await interaction.reply({
            embeds: [embedConfirmacao],
            components: [botoes],
            flags: MessageFlags.Ephemeral
        });

        return;
    }



    // =========================================
    // MODAL DO PIX (PRODUÇÃO)
    // =========================================

    if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith("modal_pix_")
    ) {

        const partes = interaction.customId.split("_");
        const valorCentavos = Number(partes[2]);
        const referencia = partes.slice(3).join("_");

        const donoTicket = interaction.channel.topic
            ?.match(/rzstore-user:(\d+)/)?.[1];

        if (
            !donoTicket ||
            interaction.user.id !== donoTicket
        ) {
            await interaction.reply({
                content:
                    "<:x_:1549124126575165533> Apenas o cliente deste ticket pode gerar o PIX.",
                flags: MessageFlags.Ephemeral
            });

            return;
        }

        if (
            interaction.channel.topic?.includes(
                "mp-order:"
            )
        ) {
            await interaction.reply({
                content:
                    "<:danger:1549129849904566392> Já existe uma cobrança PIX gerada para este ticket.",
                flags: MessageFlags.Ephemeral
            });

            return;
        }

        const email = interaction.fields
            .getTextInputValue("pix_email")
            .trim();

        const emailValido =
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

        if (!emailValido) {
            await interaction.reply({
                content:
                    "<:x_:1549124126575165533> Digite um e-mail válido.",
                flags: MessageFlags.Ephemeral
            });

            return;
        }

        if (
            !Number.isInteger(valorCentavos) ||
            valorCentavos <= 0
        ) {
            await interaction.reply({
                content:
                    "<:x_:1549124126575165533> O valor desta cobrança é inválido.",
                flags: MessageFlags.Ephemeral
            });

            return;
        }

        await interaction.deferReply({
            flags: MessageFlags.Ephemeral
        });

        try {

            let descricao = "RZ Store";

            if (referencia.startsWith("robux-")) {
                const quantidade = Number(
                    referencia.replace("robux-", "")
                );

                descricao =
                    `RZ Store - ${quantidade.toLocaleString("pt-BR")} Robux`;
            }

            if (referencia.startsWith("item-")) {
                const item = referencia
                    .replace("item-", "");

                descricao =
                    item === "korblox"
                        ? "RZ Store - Korblox"
                        : "RZ Store - Headless";
            }

            const dados = await criarCobrancaPix({
                valorCentavos,
                descricao,
                discordUserId: interaction.user.id,
                channelId: interaction.channel.id,
                payerEmail: email
            });

            await enviarPixNoTicket(
                interaction,
                dados,
                valorCentavos
            );

        } catch (error) {

            console.error(
                "Erro ao gerar PIX:",
                error
            );

            console.error(
                "Resposta Mercado Pago:",
                error?.cause || error?.response || error
            );

            const mensagemMercadoPago =
                error?.cause?.[0]?.description ||
                error?.message ||
                "Erro desconhecido.";

            await interaction.editReply({
                content:
                    "<:x_:1549124126575165533> Não foi possível gerar o PIX.\n" +
                    `Detalhe: \`${String(mensagemMercadoPago).slice(0, 500)}\``
            });

        }

        return;
    }


    // =========================================
    // BOTÕES
    // =========================================

    if (interaction.isButton()) {

        // =========================================
        // COPIAR PIX
        // =========================================

        if (
            interaction.customId === "copiar_pix"
        ) {

            const donoTicket = interaction.channel.topic
                ?.match(/rzstore-user:(\d+)/)?.[1];

            const ehStaff =
                interaction.member.roles.cache.has(
                    process.env.STAFF_ROLE_ID
                );

            if (
                !donoTicket ||
                (
                    interaction.user.id !== donoTicket &&
                    !ehStaff
                )
            ) {
                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Você não tem permissão para acessar o PIX deste ticket.",
                    flags: MessageFlags.Ephemeral
                });

                return;
            }

            const orderId = interaction.channel.topic
                ?.match(/mp-order:([A-Za-z0-9]+)/)?.[1];

            if (!orderId) {
                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Não encontrei a cobrança PIX deste ticket.",
                    flags: MessageFlags.Ephemeral
                });

                return;
            }

            await interaction.deferReply({
                flags: MessageFlags.Ephemeral
            });

            try {

                const order =
                    await buscarOrderMercadoPago(
                        orderId
                    );

                const pagamento =
                    order.transactions
                        ?.payments?.[0];

                const pixCopiaCola =
                    pagamento
                        ?.payment_method
                        ?.qr_code;

                if (!pixCopiaCola) {
                    throw new Error(
                        "A order não retornou o código PIX."
                    );
                }

                // Envia SOMENTE o código para facilitar o "Copiar texto"
                // no Discord mobile.
                await interaction.editReply({
                    content: pixCopiaCola
                });

            } catch (error) {

                console.error(
                    "Erro ao recuperar PIX:",
                    error
                );

                await interaction.editReply({
                    content:
                        "<:x_:1549124126575165533> Não foi possível recuperar o PIX. Tente novamente."
                });

            }

            return;
        }


        // =========================================
        // GERAR PIX
        // =========================================

        if (
            interaction.customId.startsWith(
                "gerar_pix_"
            )
        ) {

            const donoTicket = interaction.channel.topic
                ?.match(/rzstore-user:(\d+)/)?.[1];

            if (
                !donoTicket ||
                interaction.user.id !== donoTicket
            ) {
                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Apenas o cliente deste ticket pode gerar o PIX.",
                    flags: MessageFlags.Ephemeral
                });

                return;
            }

            if (
                interaction.channel.topic?.includes(
                    "mp-order:"
                )
            ) {
                await interaction.reply({
                    content:
                        "<:danger:1549129849904566392> Já existe uma cobrança PIX gerada para este ticket.",
                    flags: MessageFlags.Ephemeral
                });

                return;
            }

            const dadosCustomId =
                interaction.customId
                    .replace("gerar_pix_", "");

            const separador =
                dadosCustomId.indexOf("_");

            const valorCentavos = Number(
                dadosCustomId.slice(0, separador)
            );

            const referencia =
                dadosCustomId.slice(separador + 1);

            if (
                !Number.isInteger(valorCentavos) ||
                valorCentavos <= 0
            ) {
                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> O valor desta cobrança é inválido.",
                    flags: MessageFlags.Ephemeral
                });

                return;
            }

            // No sandbox o Mercado Pago exige dados de teste predefinidos.
            if (MERCADO_PAGO_TEST_MODE) {

                await interaction.deferReply({
                    flags: MessageFlags.Ephemeral
                });

                try {

                    let descricao = "RZ Store";

                    if (referencia.startsWith("robux-")) {
                        const quantidade = Number(
                            referencia.replace("robux-", "")
                        );

                        descricao =
                            `RZ Store - ${quantidade.toLocaleString("pt-BR")} Robux`;
                    }

                    if (referencia.startsWith("item-")) {
                        const item = referencia.replace("item-", "");

                        descricao =
                            item === "korblox"
                                ? "RZ Store - Korblox"
                                : "RZ Store - Headless";
                    }

                    const dados = await criarCobrancaPix({
                        valorCentavos,
                        descricao,
                        discordUserId: interaction.user.id,
                        channelId: interaction.channel.id,
                        payerEmail: "test_user_br@testuser.com"
                    });

                    await enviarPixNoTicket(
                        interaction,
                        dados,
                        valorCentavos
                    );

                } catch (error) {

                    console.error(
                        "Erro ao gerar PIX de teste:",
                        error
                    );

                    console.error(
                        "Resposta Mercado Pago:",
                        error?.cause || error?.response || error
                    );

                    const mensagemMercadoPago =
                        error?.mercadoPago?.message ||
                        error?.mercadoPago?.error ||
                        error?.message ||
                        "Erro desconhecido.";

                    await interaction.editReply({
                        content:
                            "<:x_:1549124126575165533> Não foi possível gerar o PIX de teste.\n" +
                            `Detalhe: \`${String(mensagemMercadoPago).slice(0, 500)}\``
                    });
                }

                return;
            }

            // Produção: pede somente o e-mail do pagador.
            const modalPix = new ModalBuilder()
                .setCustomId(
                    `modal_pix_${valorCentavos}_${referencia}`
                )
                .setTitle("Gerar pagamento PIX");

            const emailInput = new TextInputBuilder()
                .setCustomId("pix_email")
                .setLabel("E-mail do pagador")
                .setPlaceholder("exemplo@email.com")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(100);

            modalPix.addComponents(
                new ActionRowBuilder()
                    .addComponents(emailInput)
            );

            await interaction.showModal(modalPix);

            return;
        }


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
        .setTitle("<:danger:1549129849904566392> Você já possui um ticket aberto")
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

                `### <:ampulheta:1549129208557469786> Status\n` +
                `> Aguardando pagamento.\n\n` +

                `Clique no botão **Gerar PIX** abaixo para criar sua cobrança.`
            )
            .setFooter({
                text: "RZ Store"
            })
            .setTimestamp();

        const valorCentavos = Math.round(valor * 100);

        const botoesTicket = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`gerar_pix_${valorCentavos}_robux-${quantidade}`)
                    .setLabel("Gerar PIX")
                    .setEmoji({
                        id: "1548090281402966107",
                        name: "pix"
                    })
                    .setStyle(ButtonStyle.Success),

                new ButtonBuilder()
                    .setCustomId("fechar_ticket")
                    .setLabel("Fechar ticket")
                    .setEmoji({
                        id: "1549128145381367949",
                        name: "cadeado~1"
                    })
                    .setStyle(ButtonStyle.Danger)
            );

        await ticket.send({
            content: `${interaction.user} <@&${process.env.STAFF_ROLE_ID}>`,
            embeds: [embedTicket],
            components: [botoesTicket]
        });

        const embedCriado = new EmbedBuilder()
            .setColor("#00db0f")
            .setTitle("<:okk:1549125132906270851> Ticket criado!")
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
                "<:x_:1549124126575165533> Ocorreu um erro ao criar seu ticket. Entre em contato com a equipe.",
            embeds: [],
            components: []
        });

    }

    return;
}



        // =========================================
        // CONFIRMAR KORBLOX / HEADLESS
        // =========================================

        if (
            interaction.customId.startsWith(
                "confirmar_item_"
            )
        ) {

            const opcao = interaction.customId.replace(
                "confirmar_item_",
                ""
            );

            const produtos = {
                korblox: {
                    nome: "Korblox",
                    robux: 17000,
                    valor: 544
                },
                headless: {
                    nome: "Headless",
                    robux: 31000,
                    valor: 992
                }
            };

            const produto = produtos[opcao];

            if (!produto) {
                await interaction.update({
                    content: "<:x_:1549124126575165533> Produto inválido.",
                    embeds: [],
                    components: []
                });
                return;
            }

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
                    .setTitle("<:danger:1549129849904566392> Você já possui um ticket aberto")
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

            const robuxFormatado = produto.robux.toLocaleString("pt-BR");
            const valorFormatado = produto.valor.toLocaleString("pt-BR", {
                style: "currency",
                currency: "BRL"
            });

            try {

                const ticket = await guild.channels.create({

                    name: `${opcao}-${nomeUsuario}`,

                    type: ChannelType.GuildText,

                    parent: process.env.CATEGORY_TICKETS_ID,

                    topic: `RZ Store | rzstore-user:${interaction.user.id} | Produto: ${produto.nome} | Compra de ${interaction.user.tag}`,

                    permissionOverwrites: [

                        {
                            id: guild.roles.everyone.id,
                            deny: [
                                PermissionFlagsBits.ViewChannel
                            ]
                        },

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

                const embedTicketItem = new EmbedBuilder()
                    .setColor("#00db0f")
                    .setTitle("<:greencart:1548089836647485591> Novo pedido — RZ Store")
                    .setDescription(
                        `Olá ${interaction.user}! Seu ticket de compra foi criado com sucesso.\n\n` +

                        `### <:esmeralda:1548188465508909118> Detalhes do pedido\n` +
                        `> **Cliente:** ${interaction.user}\n` +
                        `> **Produto:** ${produto.nome}\n` +
                        `> <:greenrbx:1548088739677470881> **Preço em Robux:** ${robuxFormatado}\n` +
                        `> <:pix:1548090281402966107> **Valor:** ${valorFormatado}\n\n` +

                        `### <:ampulheta:1549129208557469786> Status\n` +
                        `> Aguardando pagamento.\n\n` +

                        `Clique no botão **Gerar PIX** abaixo para criar sua cobrança.`
                    )
                    .setFooter({
                        text: "RZ Store"
                    })
                    .setTimestamp();

                const valorCentavosItem = Math.round(produto.valor * 100);

                const botoesTicketItem = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`gerar_pix_${valorCentavosItem}_item-${opcao}`)
                            .setLabel("Gerar PIX")
                            .setEmoji({
                                id: "1548090281402966107",
                                name: "pix"
                            })
                            .setStyle(ButtonStyle.Success),

                        new ButtonBuilder()
                            .setCustomId("fechar_ticket")
                            .setLabel("Fechar ticket")
                            .setEmoji({
                                id: "1549128145381367949",
                                name: "cadeado~1"
                            })
                            .setStyle(ButtonStyle.Danger)
                    );

                await ticket.send({
                    content: `${interaction.user} <@&${process.env.STAFF_ROLE_ID}>`,
                    embeds: [embedTicketItem],
                    components: [botoesTicketItem]
                });

                const embedCriadoItem = new EmbedBuilder()
                    .setColor("#00db0f")
                    .setTitle("<:okk:1549125132906270851> Ticket criado!")
                    .setDescription(
                        `Seu pedido foi confirmado.\n\n` +
                        `<:esmeralda:1548188465508909118> **${produto.nome}**\n` +
                        `<:pix:1548090281402966107> **${valorFormatado}**\n\n` +
                        `Acesse seu ticket: ${ticket}`
                    )
                    .setFooter({
                        text: "RZ Store"
                    });

                await interaction.update({
                    embeds: [embedCriadoItem],
                    components: []
                });

            } catch (error) {

                console.error("Erro ao criar ticket de item:", error);

                await interaction.update({
                    content:
                        "<:x_:1549124126575165533> Ocorreu um erro ao criar seu ticket. Entre em contato com a equipe.",
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
                    "<:x_:1549124126575165533> Compra cancelada"
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
                        "<:x_:1549124126575165533> Apenas a equipe da RZ Store pode fechar este ticket.",
                    flags: MessageFlags.Ephemeral
                });

                return;
            }

            const confirmarFechamento = new ActionRowBuilder()
                .addComponents(

                    new ButtonBuilder()
                        .setCustomId("confirmar_fechar_ticket")
                        .setLabel("Sim, fechar")
                        .setEmoji({
                        id: "1549125132906270851",
                        name: "okk"
                    })
                        .setStyle(ButtonStyle.Danger),

                    new ButtonBuilder()
                        .setCustomId("cancelar_fechar_ticket")
                        .setLabel("Cancelar")
                        .setEmoji({
                        id: "1549124126575165533",
                        name: "x_"
                    })
                        .setStyle(ButtonStyle.Secondary)

                );

            await interaction.reply({
                content:
                    "<:danger:1549129849904566392> **Tem certeza que deseja fechar este ticket?**\n\n" +
                    "O canal será apagado.",
                components: [confirmarFechamento],
                flags: MessageFlags.Ephemeral
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
                        "<:x_:1549124126575165533> Apenas a equipe da RZ Store pode fechar este ticket.",
                    flags: MessageFlags.Ephemeral
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
                        "<:x_:1549124126575165533> Este canal não foi reconhecido como um ticket de compra da RZ Store.",
                    components: []
                });

                return;
            }

            await interaction.update({
                content:
                    "<:cadeado:1549128145381367949> Ticket fechado. Este canal será apagado em **3 segundos**.",
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
                        "<:x_:1549124126575165533> Apenas a equipe da RZ Store pode fechar este ticket.",
                    flags: MessageFlags.Ephemeral
                });

                return;
            }

            await interaction.update({
                content: "<:okk:1549125132906270851> Fechamento cancelado.",
                components: []
            });

            return;
        }

    }

});

client.on("error", error => {
    console.error("ERRO DO DISCORD:", error);
});

process.on("unhandledRejection", error => {
    console.error("PROMISE NÃO TRATADA:", error);
});

process.on("uncaughtException", error => {
    console.error("ERRO NÃO TRATADO:", error);
});

client.login(process.env.DISCORD_TOKEN);