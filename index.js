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

const express = require("express");

const QRCode = require("qrcode");
const { randomUUID, createHmac, timingSafeEqual } = require("crypto");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const mercadoPagoClient = new MercadoPagoConfig({
    accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN,
    options: {
        timeout: 5000
    }
});

const mercadoPagoOrder = new Order(mercadoPagoClient);

const MERCADO_PAGO_TEST_MODE =
    process.env.MERCADO_PAGO_TEST_MODE === "true";

const CARGOS_EM_TESTE =
    process.env.CARGOS_EM_TESTE === "true";

// Banco de teste separado do banco real.
// Assim, os testes do Mercado Pago não misturam os gastos reais.
const DATABASE_FILE =
    MERCADO_PAGO_TEST_MODE
        ? "./rz-store-test.db"
        : "./rz-store.db";

const db = new DatabaseSync(DATABASE_FILE);

db.exec(`
    CREATE TABLE IF NOT EXISTS clientes (
        discord_id TEXT PRIMARY KEY,
        total_centavos INTEGER NOT NULL DEFAULT 0,
        compras INTEGER NOT NULL DEFAULT 0,
        criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS compras (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL UNIQUE,
        payment_id TEXT,
        discord_id TEXT NOT NULL,
        valor_centavos INTEGER NOT NULL,
        quantidade_robux INTEGER,
        produto TEXT,
        criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_compras_discord_id
    ON compras(discord_id);

    CREATE TABLE IF NOT EXISTS estoque (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        quantidade INTEGER NOT NULL DEFAULT 0,
        atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO estoque (
        id,
        quantidade
    )
    VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS estoque_movimentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT NOT NULL,
        quantidade INTEGER NOT NULL,
        saldo_apos INTEGER NOT NULL,
        referencia TEXT UNIQUE,
        staff_discord_id TEXT,
        criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`);

// Migra bancos antigos sem apagar nenhum dado.
const colunasCompras =
    db.prepare(
        "PRAGMA table_info(compras)"
    ).all();

const nomesColunasCompras =
    new Set(
        colunasCompras.map(
            coluna => coluna.name
        )
    );

if (
    !nomesColunasCompras.has(
        "entregue"
    )
) {
    db.exec(`
        ALTER TABLE compras
        ADD COLUMN entregue INTEGER NOT NULL DEFAULT 0
    `);
}

if (
    !nomesColunasCompras.has(
        "entregue_em"
    )
) {
    db.exec(`
        ALTER TABLE compras
        ADD COLUMN entregue_em TEXT
    `);
}

if (
    !nomesColunasCompras.has(
        "entregue_por"
    )
) {
    db.exec(`
        ALTER TABLE compras
        ADD COLUMN entregue_por TEXT
    `);
}

console.log(
    `[BANCO] SQLite carregado: ${DATABASE_FILE}`
);

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

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




function validarAssinaturaMercadoPago({
    xSignature,
    xRequestId,
    dataId,
    secret
}) {

    if (
        !xSignature ||
        !xRequestId ||
        !dataId ||
        !secret
    ) {
        return false;
    }

    const partes =
        String(xSignature)
            .split(",");

    let ts = null;
    let v1 = null;

    for (const parte of partes) {

        const [chave, ...resto] =
            parte.trim().split("=");

        const valor =
            resto.join("=");

        if (chave === "ts") {
            ts = valor;
        }

        if (chave === "v1") {
            v1 = valor;
        }
    }

    if (!ts || !v1) {
        return false;
    }

    const idsParaTestar = [
        String(dataId).toLowerCase(),
        String(dataId)
    ];

    for (const id of idsParaTestar) {

        const manifesto =
            `id:${id};request-id:${xRequestId};ts:${ts};`;

        const assinaturaEsperada =
            createHmac(
                "sha256",
                secret
            )
                .update(manifesto)
                .digest("hex");

        const esperado =
            Buffer.from(
                assinaturaEsperada,
                "utf8"
            );

        const recebido =
            Buffer.from(
                String(v1),
                "utf8"
            );

        if (
            esperado.length === recebido.length &&
            timingSafeEqual(
                esperado,
                recebido
            )
        ) {
            return true;
        }
    }

    return false;
}



function obterQuantidadeEstoque() {

    const linha =
        db.prepare(`
            SELECT quantidade
            FROM estoque
            WHERE id = 1
        `).get();

    return Number(
        linha?.quantidade || 0
    );
}


function formatarRobux(
    quantidade
) {

    return Number(
        quantidade || 0
    ).toLocaleString(
        "pt-BR"
    );
}


function alterarEstoqueManual({
    quantidade,
    tipo,
    staffDiscordId
}) {

    if (
        !Number.isInteger(quantidade) ||
        quantidade <= 0
    ) {
        throw new Error(
            "A quantidade do estoque deve ser um número inteiro maior que zero."
        );
    }

    db.exec(
        "BEGIN IMMEDIATE"
    );

    try {

        const estoqueAntes =
            obterQuantidadeEstoque();

        let estoqueDepois;

        if (tipo === "entrada") {

            estoqueDepois =
                estoqueAntes +
                quantidade;

        } else if (
            tipo === "saida_manual"
        ) {

            if (
                quantidade >
                estoqueAntes
            ) {
                throw new Error(
                    `Não há Robux suficientes no estoque. Saldo atual: ${formatarRobux(estoqueAntes)} Robux.`
                );
            }

            estoqueDepois =
                estoqueAntes -
                quantidade;

        } else {

            throw new Error(
                "Tipo de movimentação de estoque inválido."
            );
        }

        db.prepare(`
            UPDATE estoque
            SET
                quantidade = ?,
                atualizado_em = CURRENT_TIMESTAMP
            WHERE id = 1
        `).run(
            estoqueDepois
        );

        db.prepare(`
            INSERT INTO estoque_movimentos (
                tipo,
                quantidade,
                saldo_apos,
                staff_discord_id
            )
            VALUES (?, ?, ?, ?)
        `).run(
            tipo,
            tipo === "entrada"
                ? quantidade
                : -quantidade,
            estoqueDepois,
            staffDiscordId || null
        );

        db.exec(
            "COMMIT"
        );

        return {
            estoqueAntes,
            estoqueDepois
        };

    } catch (error) {

        db.exec(
            "ROLLBACK"
        );

        throw error;
    }
}


function setarEstoqueManual({
    quantidade,
    staffDiscordId
}) {

    if (
        !Number.isInteger(quantidade) ||
        quantidade < 0
    ) {
        throw new Error(
            "A quantidade do estoque deve ser um número inteiro igual ou maior que zero."
        );
    }

    db.exec(
        "BEGIN IMMEDIATE"
    );

    try {

        const estoqueAntes =
            obterQuantidadeEstoque();

        const diferenca =
            quantidade -
            estoqueAntes;

        db.prepare(`
            UPDATE estoque
            SET
                quantidade = ?,
                atualizado_em = CURRENT_TIMESTAMP
            WHERE id = 1
        `).run(
            quantidade
        );

        db.prepare(`
            INSERT INTO estoque_movimentos (
                tipo,
                quantidade,
                saldo_apos,
                staff_discord_id
            )
            VALUES (?, ?, ?, ?)
        `).run(
            "set_manual",
            diferenca,
            quantidade,
            staffDiscordId || null
        );

        db.exec(
            "COMMIT"
        );

        return {
            estoqueAntes,
            estoqueDepois:
                quantidade
        };

    } catch (error) {

        db.exec(
            "ROLLBACK"
        );

        throw error;
    }
}


async function notificarEstoqueBaixo(
    guild,
    estoqueAntes,
    estoqueDepois
) {

    const limite =
        Number(
            process.env.ESTOQUE_BAIXO_LIMITE ||
            3000
        );

    if (
        !Number.isFinite(limite) ||
        limite < 0
    ) {
        return;
    }

    // Só avisa quando cruza o limite para baixo,
    // evitando spam a cada venda.
    if (
        estoqueAntes <= limite ||
        estoqueDepois > limite
    ) {
        return;
    }

    const canalId =
        process.env.CANAL_ESTOQUE_ID ||
        process.env.CANAL_LOGS_COMPRAS_ID;

    if (!canalId) {
        return;
    }

    try {

        const canal =
            await guild.channels.fetch(
                canalId
            );

        if (
            !canal ||
            !canal.isTextBased()
        ) {
            return;
        }

        const embed =
            new EmbedBuilder()
                .setColor(
                    "#00db0f"
                )
                .setTitle(
                    "<:danger:1549129849904566392> Estoque baixo"
                )
                .setDescription(
                    `O estoque da **RZ Store** chegou ao limite configurado.\n\n` +
                    `> <:greenrbx:1548088739677470881> **Estoque atual:** ${formatarRobux(estoqueDepois)} Robux\n` +
                    `> **Limite de aviso:** ${formatarRobux(limite)} Robux`
                )
                .setFooter({
                    text:
                        "RZ Store • Controle de estoque"
                })
                .setTimestamp();

        await canal.send({
            content:
                `<@&${process.env.STAFF_ROLE_ID}>`,
            embeds: [
                embed
            ],
            allowedMentions: {
                roles: [
                    process.env.STAFF_ROLE_ID
                ]
            }
        });

    } catch (error) {

        console.error(
            "[ESTOQUE] Erro ao enviar alerta de estoque baixo:",
            error
        );
    }
}


function registrarCompraAprovada({
    orderId,
    paymentId,
    discordId,
    valorCentavos,
    quantidadeRobux,
    produto
}) {

    const quantidade =
        Number(
            quantidadeRobux
        );

    if (
        !Number.isInteger(
            quantidade
        ) ||
        quantidade <= 0
    ) {
        throw new Error(
            "Não foi possível identificar a quantidade de Robux para baixar do estoque."
        );
    }

    db.exec(
        "BEGIN IMMEDIATE"
    );

    try {

        const compraExistente =
            db.prepare(`
                SELECT order_id
                FROM compras
                WHERE order_id = ?
            `).get(orderId);

        if (compraExistente) {

            const cliente =
                db.prepare(`
                    SELECT
                        total_centavos,
                        compras
                    FROM clientes
                    WHERE discord_id = ?
                `).get(discordId);

            const estoqueAtual =
                obterQuantidadeEstoque();

            db.exec(
                "COMMIT"
            );

            return {
                novaCompra: false,
                semEstoque: false,
                totalCentavos:
                    cliente?.total_centavos || 0,
                numeroCompras:
                    cliente?.compras || 0,
                estoqueAntes:
                    estoqueAtual,
                estoqueDepois:
                    estoqueAtual
            };
        }

        const estoqueAntes =
            obterQuantidadeEstoque();

        if (
            estoqueAntes <
            quantidade
        ) {

            db.exec(
                "ROLLBACK"
            );

            return {
                novaCompra: false,
                semEstoque: true,
                totalCentavos: 0,
                numeroCompras: 0,
                estoqueAntes,
                estoqueDepois:
                    estoqueAntes
            };
        }

        const estoqueDepois =
            estoqueAntes -
            quantidade;

        db.prepare(`
            UPDATE estoque
            SET
                quantidade = ?,
                atualizado_em =
                    CURRENT_TIMESTAMP
            WHERE id = 1
        `).run(
            estoqueDepois
        );

        db.prepare(`
            INSERT INTO estoque_movimentos (
                tipo,
                quantidade,
                saldo_apos,
                referencia
            )
            VALUES (?, ?, ?, ?)
        `).run(
            "venda",
            -quantidade,
            estoqueDepois,
            `compra:${orderId}`
        );

        db.prepare(`
            INSERT INTO compras (
                order_id,
                payment_id,
                discord_id,
                valor_centavos,
                quantidade_robux,
                produto
            )
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            orderId,
            paymentId || null,
            discordId,
            valorCentavos,
            quantidade,
            produto || null
        );

        db.prepare(`
            INSERT INTO clientes (
                discord_id,
                total_centavos,
                compras
            )
            VALUES (?, ?, 1)

            ON CONFLICT(discord_id)
            DO UPDATE SET
                total_centavos =
                    clientes.total_centavos +
                    excluded.total_centavos,

                compras =
                    clientes.compras + 1,

                atualizado_em =
                    CURRENT_TIMESTAMP
        `).run(
            discordId,
            valorCentavos
        );

        const cliente =
            db.prepare(`
                SELECT
                    total_centavos,
                    compras
                FROM clientes
                WHERE discord_id = ?
            `).get(discordId);

        db.exec(
            "COMMIT"
        );

        return {
            novaCompra: true,
            semEstoque: false,
            totalCentavos:
                cliente.total_centavos,
            numeroCompras:
                cliente.compras,
            estoqueAntes,
            estoqueDepois
        };

    } catch (error) {

        try {
            db.exec(
                "ROLLBACK"
            );
        } catch {}

        throw error;
    }
}

function obterCargoPorTotal(
    totalCentavos
) {

    const cargos = [
        {
            nome: "Tigre",
            minimo: 500000,
            id: process.env.ROLE_TIGRE_ID
        },
        {
            nome: "Coruja",
            minimo: 100000,
            id: process.env.ROLE_CORUJA_ID
        },
        {
            nome: "Lobo",
            minimo: 50000,
            id: process.env.ROLE_LOBO_ID
        },
        {
            nome: "Cervo",
            minimo: 25000,
            id: process.env.ROLE_CERVO_ID
        },
        {
            nome: "Coelho",
            minimo: 10000,
            id: process.env.ROLE_COELHO_ID
        },
        {
            nome: "Sapo",
            minimo: 1,
            id: process.env.ROLE_SAPO_ID
        }
    ];

    return (
        cargos.find(
            cargo =>
                totalCentavos >=
                cargo.minimo
        ) || null
    );
}


function obterTodosIdsCargosClientes() {

    return [
        process.env.ROLE_SAPO_ID,
        process.env.ROLE_COELHO_ID,
        process.env.ROLE_CERVO_ID,
        process.env.ROLE_LOBO_ID,
        process.env.ROLE_CORUJA_ID,
        process.env.ROLE_TIGRE_ID
    ].filter(Boolean);
}


function obterNomeCargoPorId(id) {

    const cargos = [
        {
            nome: "Sapo",
            id: process.env.ROLE_SAPO_ID
        },
        {
            nome: "Coelho",
            id: process.env.ROLE_COELHO_ID
        },
        {
            nome: "Cervo",
            id: process.env.ROLE_CERVO_ID
        },
        {
            nome: "Lobo",
            id: process.env.ROLE_LOBO_ID
        },
        {
            nome: "Coruja",
            id: process.env.ROLE_CORUJA_ID
        },
        {
            nome: "Tigre",
            id: process.env.ROLE_TIGRE_ID
        }
    ];

    return (
        cargos.find(
            cargo =>
                cargo.id === id
        )?.nome || null
    );
}


function obterMetaCargo(nome) {

    const metas = {
        Sapo: "Primeira compra",
        Coelho: "R$ 100+",
        Cervo: "R$ 250+",
        Lobo: "R$ 500+",
        Coruja: "R$ 1.000+",
        Tigre: "R$ 5.000+"
    };

    return metas[nome] || "";
}


function obterImagemCargo(nome) {

    const arquivos = {
        Sapo: "sapo.png",
        Coelho: "coelho.png",
        Cervo: "cervo.png",
        Lobo: "lobo.png",
        Coruja: "coruja.png",
        Tigre: "tigre.png"
    };

    const nomeArquivo =
        arquivos[nome];

    if (!nomeArquivo) {
        return null;
    }

    return {
        nomeArquivo,
        caminho: path.join(
            __dirname,
            "assets",
            "evolucoes",
            nomeArquivo
        )
    };
}


async function notificarEvolucaoCargo({
    guild,
    member,
    cargoAnteriorId,
    cargoNovo,
    totalCentavos
}) {

    const canalId =
        process.env.CANAL_EVOLUCAO_ID;

    if (!canalId) {

        console.warn(
            "[CARGOS] CANAL_EVOLUCAO_ID não configurado no .env."
        );

        return;
    }

    try {

        const canal =
            await guild.channels.fetch(
                canalId
            );

        if (
            !canal ||
            !canal.isTextBased()
        ) {

            console.warn(
                "[CARGOS] Canal de evolução não encontrado ou não é um canal de texto."
            );

            return;
        }

        const nomeAnterior =
            obterNomeCargoPorId(
                cargoAnteriorId
            );

        const meta =
            obterMetaCargo(
                cargoNovo.nome
            );

        const totalFormatado =
            (
                totalCentavos / 100
            ).toLocaleString(
                "pt-BR",
                {
                    style: "currency",
                    currency: "BRL"
                }
            );

        const descricaoEvolucao =
            nomeAnterior &&
            cargoAnteriorId
                ? `${member} evoluiu de <@&${cargoAnteriorId}> para <@&${cargoNovo.id}>!`
                : `${member} conquistou o cargo <@&${cargoNovo.id}>!`;

        const imagemCargo =
            obterImagemCargo(
                cargoNovo.nome
            );

        const embedEvolucao =
            new EmbedBuilder()
                .setColor("#00db0f")
                .setAuthor({
                    name:
                        `${member.user.username} • Evolução de cliente`,
                    iconURL:
                        member.user.displayAvatarURL()
                })
                .setTitle(
                    "<:coroa:1548189671501078588> Novo cargo conquistado!"
                )
                .setDescription(
                    `${descricaoEvolucao}\n\n` +
                    `> **Novo cargo:** <@&${cargoNovo.id}>\n` +
                    `> **Meta do cargo:** ${meta}\n` +
                    `> **Total acumulado:** ${totalFormatado}\n\n` +
                    "<a:greenverification:1548192162653536336> Obrigado por comprar na **RZ Store**!"
                )
                .setThumbnail(
                    member.user.displayAvatarURL()
                )
                .setFooter({
                    text:
                        "RZ Store • Sistema de fidelidade"
                })
                .setTimestamp();

        if (imagemCargo) {

            embedEvolucao.setImage(
                `attachment://${imagemCargo.nomeArquivo}`
            );
        }

        await canal.send({
            content: `<@${member.id}>`,
            embeds: [
                embedEvolucao
            ],
            files:
                imagemCargo
                    ? [
                        {
                            attachment:
                                imagemCargo.caminho,
                            name:
                                imagemCargo.nomeArquivo
                        }
                    ]
                    : [],
            allowedMentions: {
                users: [
                    member.id
                ],
                roles: []
            }
        });

    } catch (error) {

        console.error(
            "[CARGOS] Erro ao enviar embed de evolução:",
            error
        );
    }
}


async function atualizarCargoCliente({
    guild,
    discordId,
    totalCentavos
}) {

    const cargoCorreto =
        obterCargoPorTotal(
            totalCentavos
        );

    if (!cargoCorreto) {
        return null;
    }

    if (
        MERCADO_PAGO_TEST_MODE &&
        !CARGOS_EM_TESTE
    ) {

        console.log(
            `[CARGOS] Modo de teste: ${cargoCorreto.nome} não foi aplicado.`
        );

        return {
            nome: cargoCorreto.nome,
            id: cargoCorreto.id || null,
            aplicado: false
        };
    }

    if (!cargoCorreto.id) {

        console.warn(
            `[CARGOS] ID do cargo ${cargoCorreto.nome} não está configurado no .env.`
        );

        return {
            nome: cargoCorreto.nome,
            id: null,
            aplicado: false
        };
    }

    const member =
        await guild.members.fetch(
            discordId
        );

    const todosIds =
        obterTodosIdsCargosClientes();

    const cargoAnteriorId =
        todosIds.find(
            id =>
                member.roles.cache.has(id)
        ) || null;

    const mudouDeCargo =
        cargoAnteriorId !==
        cargoCorreto.id;

    const idsParaRemover =
        todosIds.filter(
            id =>
                id !== cargoCorreto.id &&
                member.roles.cache.has(id)
        );

    if (idsParaRemover.length > 0) {

        await member.roles.remove(
            idsParaRemover,
            "Atualização automática de cargo por gastos na RZ Store"
        );
    }

    if (
        !member.roles.cache.has(
            cargoCorreto.id
        )
    ) {

        await member.roles.add(
            cargoCorreto.id,
            `Total gasto na RZ Store: R$ ${(totalCentavos / 100).toFixed(2)}`
        );
    }

    if (mudouDeCargo) {

        await notificarEvolucaoCargo({
            guild,
            member,
            cargoAnteriorId,
            cargoNovo:
                cargoCorreto,
            totalCentavos
        });
    }

    return {
        nome: cargoCorreto.nome,
        id: cargoCorreto.id,
        aplicado: true,
        mudou:
            mudouDeCargo,
        cargoAnteriorId
    };
}


async function processarOrderAprovada(orderId) {

    if (
        ordersEmProcessamento.has(
            orderId
        )
    ) {
        console.log(
            `[WEBHOOK] Order ${orderId} já está sendo processada. Ignorando webhook duplicado.`
        );

        return;
    }

    ordersEmProcessamento.add(
        orderId
    );

    try {

        const order =
            await buscarOrderMercadoPago(
                orderId
            );

        const pagamento =
            order.transactions
                ?.payments?.[0];

        const pagamentoAprovado =
            (
                order.status === "processed" &&
                order.status_detail === "accredited"
            ) ||
            (
                pagamento?.status === "processed" &&
                pagamento?.status_detail === "accredited"
            );

        if (!pagamentoAprovado) {

            console.log(
                `[WEBHOOK] Order ${orderId} ainda não foi aprovada:`,
                order.status,
                order.status_detail
            );

            return;
        }

        const guild =
            await client.guilds.fetch(
                process.env.GUILD_ID
            );

        const canais =
            await guild.channels.fetch();

        const ticket =
            canais.find(channel =>
                channel &&
                channel.type ===
                    ChannelType.GuildText &&
                channel.topic?.includes(
                    `mp-order:${orderId}`
                )
            );

        if (!ticket) {

            console.log(
                `[WEBHOOK] Não encontrei ticket para a order ${orderId}.`
            );

            return;
        }

        // Impede mensagem duplicada caso o Mercado Pago
        // reenvie a mesma notificação.
        if (
            ticket.topic?.includes(
                "mp-status:accredited"
            )
        ) {

            console.log(
                `[WEBHOOK] Order ${orderId} já tinha sido confirmada no Discord.`
            );

            return;
        }

        const donoTicket =
            ticket.topic
                ?.match(
                    /rzstore-user:(\d+)/
                )?.[1];

        const paymentId =
            pagamento?.id || "-";

        const valorPago =
            Number(
                order.total_paid_amount ||
                pagamento?.paid_amount ||
                pagamento?.amount ||
                0
            );

        const valorPagoFormatado =
            valorPago.toLocaleString(
                "pt-BR",
                {
                    style: "currency",
                    currency: "BRL"
                }
            );

        // O sandbox do Mercado Pago cobra R$ 50,00 fixos.
        // Para o histórico usamos o valor REAL do pedido salvo
        // no tópico do ticket.
        const valorCentavosPedido =
            Number(
                ticket.topic
                    ?.match(
                        /valor-centavos:(\d+)/
                    )?.[1]
            );

        const quantidadeRobux =
            Number(
                ticket.topic
                    ?.match(
                        /robux:(\d+)/
                    )?.[1]
            );

        const produto =
            ticket.topic
                ?.match(
                    /Produto:\s*([^|]+)/
                )?.[1]
                ?.trim() ||
            (
                Number.isFinite(
                    quantidadeRobux
                )
                    ? `${quantidadeRobux.toLocaleString("pt-BR")} Robux`
                    : "Compra RZ Store"
            );

        if (
            !donoTicket ||
            !Number.isInteger(
                valorCentavosPedido
            ) ||
            valorCentavosPedido <= 0
        ) {

            throw new Error(
                "Não foi possível identificar o cliente ou o valor real do pedido no tópico do ticket."
            );
        }

        const registro =
            registrarCompraAprovada({
                orderId,
                paymentId,
                discordId:
                    donoTicket,
                valorCentavos:
                    valorCentavosPedido,
                quantidadeRobux:
                    Number.isFinite(
                        quantidadeRobux
                    )
                        ? quantidadeRobux
                        : null,
                produto
            });

        if (registro.semEstoque) {

            const estoqueFormatado =
                formatarRobux(
                    registro.estoqueDepois
                );

            const quantidadeFormatada =
                formatarRobux(
                    quantidadeRobux
                );

            const embedSemEstoque =
                new EmbedBuilder()
                    .setColor(
                        "#00db0f"
                    )
                    .setTitle(
                        "<:danger:1549129849904566392> Pagamento aprovado — estoque insuficiente"
                    )
                    .setDescription(
                        `O pagamento foi aprovado, mas o estoque atual não é suficiente para este pedido.

` +
                        `> **Pedido:** ${quantidadeFormatada} Robux
` +
                        `> **Estoque atual:** ${estoqueFormatado} Robux

` +
                        `<@&${process.env.STAFF_ROLE_ID}> verifique este pedido imediatamente.`
                    )
                    .setFooter({
                        text:
                            "RZ Store • Atenção necessária"
                    })
                    .setTimestamp();

            await ticket.send({
                content:
                    `<@${donoTicket}> <@&${process.env.STAFF_ROLE_ID}>`,
                embeds: [
                    embedSemEstoque
                ],
                allowedMentions: {
                    users: [
                        donoTicket
                    ],
                    roles: [
                        process.env.STAFF_ROLE_ID
                    ]
                }
            });

            console.error(
                `[ESTOQUE] Pagamento ${orderId} aprovado sem estoque suficiente.`
            );

            return;
        }

        // A order já foi salva antes: não aplica cargo,
        // não envia evolução e não manda confirmação novamente.
        if (!registro.novaCompra) {

            console.log(
                `[WEBHOOK] Order ${orderId} já estava registrada no banco. Ignorando processamento duplicado.`
            );

            return;
        }

        await notificarEstoqueBaixo(
            guild,
            registro.estoqueAntes,
            registro.estoqueDepois
        );

        let cargoAtual = null;

        try {

            cargoAtual =
                await atualizarCargoCliente({
                    guild,
                    discordId:
                        donoTicket,
                    totalCentavos:
                        registro.totalCentavos
                });

        } catch (cargoError) {

            console.error(
                "[CARGOS] Erro ao atualizar cargo do cliente:",
                cargoError
            );
        }

        const totalGastoFormatado =
            (
                registro.totalCentavos /
                100
            ).toLocaleString(
                "pt-BR",
                {
                    style: "currency",
                    currency: "BRL"
                }
            );

        const valorPedidoFormatado =
            (
                valorCentavosPedido /
                100
            ).toLocaleString(
                "pt-BR",
                {
                    style: "currency",
                    currency: "BRL"
                }
            );

        const cargoTexto =
            cargoAtual?.id &&
            cargoAtual?.aplicado
                ? `<@&${cargoAtual.id}>`
                : (
                    cargoAtual?.nome ||
                    "Não configurado"
                );

        const embedPagamento =
            new EmbedBuilder()
                .setColor("#00db0f")
                .setTitle(
                    "<:okk:1549125132906270851> Pagamento confirmado!"
                )
                .setDescription(
                    "<:pix:1548090281402966107> O Mercado Pago confirmou o pagamento deste pedido.\n\n" +

                    `> **Order:** \`${orderId}\`\n` +
                    `> **Pagamento:** \`${paymentId}\`\n` +
                    `> **Valor do pedido:** ${valorPedidoFormatado}\n` +
                    (
                        MERCADO_PAGO_TEST_MODE
                            ? `> **Cobrança sandbox:** ${valorPagoFormatado}\n`
                            : ""
                    ) +
                    `> **Total gasto na loja:** ${totalGastoFormatado}\n` +
                    `> **Cargo atual:** ${cargoTexto}\n` +
                    `> **Compras aprovadas:** ${registro.numeroCompras}\n\n` +

                    "### <:okk:1549125132906270851> Status\n" +
                    "> **Pagamento aprovado e creditado.**\n\n" +

                    "Aguarde a equipe da RZ Store realizar a entrega."
                )
                .setFooter({
                    text:
                        "RZ Store • Confirmação automática pelo Mercado Pago"
                })
                .setTimestamp();

        const botaoRoblox = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId("enviar_nick_roblox")
                    .setLabel("Enviar nick do Roblox")
                    .setEmoji({
                        id: "1548176792010104923",
                        name: "roblox"
                    })
                    .setStyle(ButtonStyle.Success)
            );

        await ticket.send({
            content:
                donoTicket
                    ? `<@${donoTicket}> agora envie seu **nome de usuário ou ID do Roblox** para realizarmos a entrega.`
                    : undefined,
            embeds: [embedPagamento],
            components: [botaoRoblox]
        });

        const topicoAtual =
            ticket.topic || "";

        const novoTopico =
            /mp-status:[^|]+/.test(
                topicoAtual
            )
                ? topicoAtual.replace(
                    /mp-status:[^|]+/,
                    "mp-status:accredited"
                )
                : `${topicoAtual} | mp-status:accredited`;

        await ticket.setTopic(
            novoTopico
        );

        console.log(
            `[WEBHOOK] Pagamento confirmado para a order ${orderId}.`
        );


    } catch (error) {

        console.error(
            "[WEBHOOK] Erro ao processar order:",
            error
        );

    } finally {

        ordersEmProcessamento.delete(
            orderId
        );
    }
}


app.get("/", (req, res) => {
    res
        .status(200)
        .send("RZ Store Bot online.");
});


app.get("/health", (req, res) => {
    res.status(200).json({
        ok: true,
        bot:
            client.user?.tag ||
            "iniciando"
    });
});


app.post(
    "/mercadopago/webhook",
    (req, res) => {

        const dataId =
            req.query["data.id"] ||
            req.body?.data?.id;

        const tipo =
            req.query.type ||
            req.body?.type;

        const webhookSecret =
            process.env
                .MERCADO_PAGO_WEBHOOK_SECRET
                ?.trim();

        // Durante a PRIMEIRA configuração da URL,
        // ainda não existe secret. Nesse caso apenas
        // respondemos 200, mas NÃO processamos pagamento.
        if (!webhookSecret) {

            console.warn(
                "[WEBHOOK] Recebido sem MERCADO_PAGO_WEBHOOK_SECRET configurado."
            );

            return res.sendStatus(200);
        }

        const assinaturaValida =
            validarAssinaturaMercadoPago({
                xSignature:
                    req.headers[
                        "x-signature"
                    ],

                xRequestId:
                    req.headers[
                        "x-request-id"
                    ],

                dataId:
                    req.query[
                        "data.id"
                    ] || dataId,

                secret:
                    webhookSecret
            });

        if (!assinaturaValida) {

            console.warn(
                "[WEBHOOK] Assinatura inválida.",
                {
                    temXSignature:
                        Boolean(
                            req.headers[
                                "x-signature"
                            ]
                        ),

                    temXRequestId:
                        Boolean(
                            req.headers[
                                "x-request-id"
                            ]
                        ),

                    dataId:
                        dataId || null,

                    tipo:
                        tipo || null
                }
            );

            return res
                .sendStatus(401);
        }

        // O Mercado Pago espera 200/201 rapidamente.
        res.sendStatus(200);

        if (
            tipo !== "order" ||
            !dataId
        ) {
            return;
        }

        // Processa depois de já responder ao Mercado Pago.
        setImmediate(() => {
            processarOrderAprovada(
                String(dataId)
            );
        });
    }
);


const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});

// Evita envio duplicado do nick do Roblox no mesmo ticket.
// O botão também será desativado no Discord após o primeiro envio.
const robloxNickEnviado = new Set();

// O Mercado Pago pode enviar o mesmo webhook mais de uma vez.
// Essa trava impede duas execuções simultâneas da mesma order.
const ordersEmProcessamento = new Set();

client.once("clientReady", async () => {

    console.log(`Bot online como ${client.user.tag}`);

    const commands = [
        new SlashCommandBuilder()
            .setName("setupcomprar")
            .setDescription("Cria o painel de compra de Robux"),

        new SlashCommandBuilder()
            .setName("korblox")
            .setDescription("Cria o painel de Korblox e Headless"),

        new SlashCommandBuilder()
            .setName("cliente")
            .setDescription("Mostra o histórico de um cliente da RZ Store")
            .addUserOption(option =>
                option
                    .setName("usuario")
                    .setDescription("Cliente que você deseja consultar")
                    .setRequired(false)
            )
            .addStringOption(option =>
                option
                    .setName("id")
                    .setDescription("ID do Discord do cliente")
                    .setRequired(false)
            ),

        new SlashCommandBuilder()
            .setName("estoque")
            .setDescription("Mostra o estoque atual de Robux"),

        new SlashCommandBuilder()
            .setName("adicionarestoque")
            .setDescription("Adiciona Robux ao estoque da loja")
            .addIntegerOption(option =>
                option
                    .setName("quantidade")
                    .setDescription("Quantidade de Robux que será adicionada")
                    .setRequired(true)
                    .setMinValue(1)
            ),

        new SlashCommandBuilder()
            .setName("removerestoque")
            .setDescription("Remove Robux do estoque da loja")
            .addIntegerOption(option =>
                option
                    .setName("quantidade")
                    .setDescription("Quantidade de Robux que será removida")
                    .setRequired(true)
                    .setMinValue(1)
            ),

        new SlashCommandBuilder()
            .setName("setarestoque")
            .setDescription("Define o estoque para uma quantidade exata")
            .addIntegerOption(option =>
                option
                    .setName("quantidade")
                    .setDescription("Nova quantidade total de Robux em estoque")
                    .setRequired(true)
                    .setMinValue(0)
            ),

        new SlashCommandBuilder()
            .setName("anunciarestoque")
            .setDescription("Publica o estoque atual no canal público")
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

        console.log("Comandos /setupcomprar, /korblox, /cliente, /estoque, /adicionarestoque, /removerestoque, /setarestoque e /anunciarestoque registrados no servidor.");

    } catch (error) {

        console.error(error);

    }

    app.listen(PORT, () => {

        console.log(
            `Webhook HTTP rodando na porta ${PORT}`
        );

        console.log(
            `Endpoint local: http://localhost:${PORT}/mercadopago/webhook`
        );

    });

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

    const mensagemPix =
        await interaction.channel.send({
            embeds: [embedPix],
            files: [qrAttachment],
            components: componentesPix
        });

    const topicoAtual =
        interaction.channel.topic || "";

    await interaction.channel.setTopic(
        `${topicoAtual} | mp-order:${order.id} | mp-payment:${payment?.id || "-"} | mp-status:${payment?.status || order.status || "pending"} | pix-msg:${mensagemPix.id}`
    );

    await interaction.editReply({
        content:
            "<:okk:1549125132906270851> PIX gerado com sucesso. Confira a cobrança acima."
    });
}


client.on(Events.InteractionCreate, async interaction => {

    // =========================================
    // COMANDOS DE ESTOQUE
    // =========================================

    if (
        interaction.isChatInputCommand() &&
        [
            "estoque",
            "adicionarestoque",
            "removerestoque",
            "setarestoque",
            "anunciarestoque"
        ].includes(
            interaction.commandName
        )
    ) {

        if (
            !interaction.member.roles.cache.has(
                process.env.STAFF_ROLE_ID
            )
        ) {

            await interaction.reply({
                content:
                    "<:x_:1549124126575165533> Apenas a equipe da RZ Store pode usar este comando.",
                flags:
                    MessageFlags.Ephemeral
            });

            return;
        }

        if (
            interaction.commandName ===
            "estoque"
        ) {

            const estoqueAtual =
                obterQuantidadeEstoque();

            const embedEstoque =
                new EmbedBuilder()
                    .setColor(
                        "#00db0f"
                    )
                    .setTitle(
                        "<:greenrbx:1548088739677470881> Estoque da RZ Store"
                    )
                    .setDescription(
                        `> **Disponível:** ${formatarRobux(estoqueAtual)} Robux`
                    )
                    .setFooter({
                        text:
                            MERCADO_PAGO_TEST_MODE
                                ? "RZ Store • Estoque de TESTE"
                                : "RZ Store • Controle de estoque"
                    })
                    .setTimestamp();

            await interaction.reply({
                embeds: [
                    embedEstoque
                ],
                flags:
                    MessageFlags.Ephemeral
            });

            return;
        }

        if (
            interaction.commandName ===
            "anunciarestoque"
        ) {

            const canalPublicoId =
                process.env.CANAL_ESTOQUE_PUBLICO_ID;

            if (!canalPublicoId) {

                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Configure `CANAL_ESTOQUE_PUBLICO_ID` no `.env` primeiro.",
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            try {

                const canalPublico =
                    await interaction.guild.channels.fetch(
                        canalPublicoId
                    );

                if (
                    !canalPublico ||
                    !canalPublico.isTextBased()
                ) {
                    throw new Error(
                        "O canal configurado não é um canal de texto válido."
                    );
                }

                const estoqueAtual =
                    obterQuantidadeEstoque();

                const caminhoBanner =
                    path.join(
                        __dirname,
                        "assets",
                        "estoque",
                        "estoque.png"
                    );

                const embedPublico =
                    new EmbedBuilder()
                        .setColor(
                            "#00db0f"
                        )
                        .setTitle(
                            "<:greenrbx:1548088739677470881> Estoque da semana"
                        )
                        .setDescription(
                            "Confira o estoque de Robux disponível para esta semana na **RZ Store**.\n\n" +
                            `> <:greenrbx:1548088739677470881> **Estoque da semana:** ${formatarRobux(estoqueAtual)} Robux\n\n` +
                            "Garanta seu pedido enquanto ainda temos Robux disponíveis. O estoque pode diminuir ao longo da semana conforme novas compras são realizadas."
                        )
                        .setImage(
                            "attachment://estoque.png"
                        )
                        .setFooter({
                            text:
                                "RZ Store • Estoque semanal"
                        })
                        .setTimestamp();

                await canalPublico.send({
                    embeds: [
                        embedPublico
                    ],
                    files: [
                        {
                            attachment:
                                caminhoBanner,
                            name:
                                "estoque.png"
                        }
                    ],
                    allowedMentions: {
                        users: [],
                        roles: []
                    }
                });

                await interaction.reply({
                    content:
                        `<:okk:1549125132906270851> Estoque anunciado com sucesso em ${canalPublico}.`,
                    flags:
                        MessageFlags.Ephemeral
                });

            } catch (error) {

                console.error(
                    "[ESTOQUE] Erro ao anunciar estoque:",
                    error
                );

                await interaction.reply({
                    content:
                        `<:x_:1549124126575165533> Não consegui anunciar o estoque: ${error.message}`,
                    flags:
                        MessageFlags.Ephemeral
                });
            }

            return;
        }

        const quantidade =
            interaction.options.getInteger(
                "quantidade",
                true
            );

        if (
            interaction.commandName ===
            "setarestoque"
        ) {

            try {

                const resultado =
                    setarEstoqueManual({
                        quantidade,
                        staffDiscordId:
                            interaction.user.id
                    });

                await interaction.reply({
                    content:
                        `<:okk:1549125132906270851> Estoque alterado de **${formatarRobux(resultado.estoqueAntes)}** para **${formatarRobux(resultado.estoqueDepois)} Robux**.`,
                    flags:
                        MessageFlags.Ephemeral
                });

            } catch (error) {

                await interaction.reply({
                    content:
                        `<:x_:1549124126575165533> ${error.message}`,
                    flags:
                        MessageFlags.Ephemeral
                });
            }

            return;
        }

        try {

            const tipo =
                interaction.commandName ===
                "adicionarestoque"
                    ? "entrada"
                    : "saida_manual";

            const resultado =
                alterarEstoqueManual({
                    quantidade,
                    tipo,
                    staffDiscordId:
                        interaction.user.id
                });

            if (
                tipo ===
                "saida_manual"
            ) {

                await notificarEstoqueBaixo(
                    interaction.guild,
                    resultado.estoqueAntes,
                    resultado.estoqueDepois
                );
            }

            const acao =
                tipo === "entrada"
                    ? "adicionados"
                    : "removidos";

            await interaction.reply({
                content:
                    `<:okk:1549125132906270851> **${formatarRobux(quantidade)} Robux** foram ${acao} do estoque.\n` +
                    `<:greenrbx:1548088739677470881> **Estoque atual:** ${formatarRobux(resultado.estoqueDepois)} Robux`,
                flags:
                    MessageFlags.Ephemeral
            });

        } catch (error) {

            await interaction.reply({
                content:
                    `<:x_:1549124126575165533> ${error.message}`,
                flags:
                    MessageFlags.Ephemeral
            });
        }

        return;
    }

    // =========================================
    // COMANDO /cliente
    // =========================================

    if (
        interaction.isChatInputCommand() &&
        interaction.commandName === "cliente"
    ) {

        if (
            !interaction.member.roles.cache.has(
                process.env.STAFF_ROLE_ID
            )
        ) {
            await interaction.reply({
                content:
                    "<:x_:1549124126575165533> Apenas a equipe da RZ Store pode usar este comando.",
                flags: MessageFlags.Ephemeral
            });

            return;
        }

        const usuarioSelecionado =
            interaction.options.getUser(
                "usuario",
                false
            );

        const idDigitado =
            interaction.options.getString(
                "id",
                false
            )?.trim();

        if (
            !usuarioSelecionado &&
            !idDigitado
        ) {
            await interaction.reply({
                content:
                    "<:interrogacoes:1548096277856649296> Informe um usuário ou o ID do Discord do cliente.",
                flags: MessageFlags.Ephemeral
            });

            return;
        }

        if (
            usuarioSelecionado &&
            idDigitado
        ) {
            await interaction.reply({
                content:
                    "<:interrogacoes:1548096277856649296> Use apenas uma opção: **usuario** ou **id**.",
                flags: MessageFlags.Ephemeral
            });

            return;
        }

        const discordId =
            usuarioSelecionado?.id ||
            idDigitado;

        if (
            !/^\d{15,25}$/.test(
                discordId
            )
        ) {
            await interaction.reply({
                content:
                    "<:x_:1549124126575165533> O ID do Discord informado é inválido.",
                flags: MessageFlags.Ephemeral
            });

            return;
        }

        const cliente =
            db.prepare(`
                SELECT
                    discord_id,
                    total_centavos,
                    compras,
                    criado_em,
                    atualizado_em
                FROM clientes
                WHERE discord_id = ?
            `).get(discordId);

        if (!cliente) {

            await interaction.reply({
                content:
                    `<:interrogacoes:1548096277856649296> Não encontrei nenhuma compra aprovada registrada para o ID \`${discordId}\`.`,
                flags: MessageFlags.Ephemeral
            });

            return;
        }

        let usuario = usuarioSelecionado;

        if (!usuario) {
            try {
                usuario =
                    await client.users.fetch(
                        discordId
                    );
            } catch {
                usuario = null;
            }
        }

        const totalCentavos =
            Number(
                cliente.total_centavos || 0
            );

        const totalFormatado =
            (
                totalCentavos / 100
            ).toLocaleString(
                "pt-BR",
                {
                    style: "currency",
                    currency: "BRL"
                }
            );

        const cargoAtual =
            obterCargoPorTotal(
                totalCentavos
            );

        const faixas = [
            {
                nome: "Sapo",
                minimo: 1,
                id: process.env.ROLE_SAPO_ID
            },
            {
                nome: "Coelho",
                minimo: 10000,
                id: process.env.ROLE_COELHO_ID
            },
            {
                nome: "Cervo",
                minimo: 25000,
                id: process.env.ROLE_CERVO_ID
            },
            {
                nome: "Lobo",
                minimo: 50000,
                id: process.env.ROLE_LOBO_ID
            },
            {
                nome: "Coruja",
                minimo: 100000,
                id: process.env.ROLE_CORUJA_ID
            },
            {
                nome: "Tigre",
                minimo: 500000,
                id: process.env.ROLE_TIGRE_ID
            }
        ];

        const proximoCargo =
            faixas.find(
                faixa =>
                    faixa.minimo >
                    totalCentavos
            );

        let textoProximoCargo;

        if (proximoCargo) {

            const faltamCentavos =
                proximoCargo.minimo -
                totalCentavos;

            const faltamFormatado =
                (
                    faltamCentavos / 100
                ).toLocaleString(
                    "pt-BR",
                    {
                        style: "currency",
                        currency: "BRL"
                    }
                );

            textoProximoCargo =
                proximoCargo.id
                    ? `<@&${proximoCargo.id}> — faltam **${faltamFormatado}**`
                    : `**${proximoCargo.nome}** — faltam **${faltamFormatado}**`;

        } else {

            textoProximoCargo =
                "<:coroa:1548189671501078588> Cargo máximo alcançado";
        }

        const textoCargoAtual =
            cargoAtual?.id
                ? `<@&${cargoAtual.id}>`
                : (
                    cargoAtual?.nome ||
                    "Sem cargo"
                );

        const comprasRecentes =
            db.prepare(`
                SELECT
                    quantidade_robux,
                    produto,
                    valor_centavos,
                    criado_em
                FROM compras
                WHERE discord_id = ?
                ORDER BY id DESC
                LIMIT 3
            `).all(discordId);

        let textoUltimasCompras =
            "Nenhuma compra encontrada.";

        if (
            comprasRecentes.length > 0
        ) {

            textoUltimasCompras =
                comprasRecentes
                    .map(
                        compra => {

                            const valor =
                                (
                                    Number(
                                        compra.valor_centavos
                                    ) / 100
                                ).toLocaleString(
                                    "pt-BR",
                                    {
                                        style: "currency",
                                        currency: "BRL"
                                    }
                                );

                            const item =
                                compra.quantidade_robux
                                    ? `${Number(
                                        compra.quantidade_robux
                                    ).toLocaleString(
                                        "pt-BR"
                                    )} Robux`
                                    : (
                                        compra.produto ||
                                        "Compra"
                                    );

                            return (
                                `> **${item}** — ${valor}`
                            );
                        }
                    )
                    .join("\n");
        }

        const embedCliente =
            new EmbedBuilder()
                .setColor("#00db0f")
                .setAuthor({
                    name:
                        usuario
                            ? `${usuario.username} • Cliente RZ Store`
                            : `Cliente ${discordId} • RZ Store`,
                    ...(usuario
                        ? {
                            iconURL:
                                usuario.displayAvatarURL()
                        }
                        : {})
                })
                .setDescription(
                    `> **Cliente:** ${usuario || `<@${discordId}>`}\n` +
                    `> **Discord ID:** \`${discordId}\`\n\n` +

                    `### <:pix:1548090281402966107> Histórico\n` +
                    `> **Total gasto:** ${totalFormatado}\n` +
                    `> **Compras aprovadas:** ${cliente.compras}\n\n` +

                    `### <:coroa:1548189671501078588> Fidelidade\n` +
                    `> **Cargo atual:** ${textoCargoAtual}\n` +
                    `> **Próximo cargo:** ${textoProximoCargo}\n\n` +

                    `### <:greenrbx:1548088739677470881> Últimas compras\n` +
                    textoUltimasCompras
                )
                .setFooter({
                    text:
                        MERCADO_PAGO_TEST_MODE
                            ? "RZ Store • Banco de TESTE"
                            : "RZ Store • Histórico do cliente"
                })
                .setTimestamp();

        await interaction.reply({
            embeds: [
                embedCliente
            ]
        });

        return;
    }

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
    // MODAL DO NICK / ID DO ROBLOX
    // =========================================

    if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith("modal_nick_roblox_")
    ) {

        const mensagemBotaoId =
            interaction.customId.replace(
                "modal_nick_roblox_",
                ""
            );

        const donoTicket = interaction.channel.topic
            ?.match(/rzstore-user:(\d+)/)?.[1];

        if (
            !donoTicket ||
            interaction.user.id !== donoTicket
        ) {
            await interaction.reply({
                content:
                    "<:x_:1549124126575165533> Apenas o cliente deste ticket pode enviar os dados do Roblox.",
                flags: MessageFlags.Ephemeral
            });

            return;
        }
        if (
            robloxNickEnviado.has(
                interaction.channel.id
            )
        ) {
            await interaction.reply({
                content:
                    "<:danger:1549129849904566392> Você já enviou os dados do Roblox neste ticket.",
                flags: MessageFlags.Ephemeral
            });

            return;
        }

        const nickRoblox = interaction.fields
            .getTextInputValue("nick_roblox")
            .trim();

        const quantidadeRobux = Number(
            interaction.channel.topic
                ?.match(/robux:(\d+)/)?.[1]
        );

        const valorCentavos = Number(
            interaction.channel.topic
                ?.match(/valor-centavos:(\d+)/)?.[1]
        );

        const quantidadeRobuxFormatada =
            Number.isFinite(quantidadeRobux)
                ? quantidadeRobux.toLocaleString("pt-BR")
                : "Não identificado";

        const valorPagamentoFormatado =
            Number.isFinite(valorCentavos)
                ? (valorCentavos / 100).toLocaleString(
                    "pt-BR",
                    {
                        style: "currency",
                        currency: "BRL"
                    }
                )
                : "Não identificado";

        if (
            nickRoblox.length < 1 ||
            nickRoblox.length > 50
        ) {
            await interaction.reply({
                content:
                    "<:x_:1549124126575165533> Digite um nome de usuário ou ID do Roblox válido.",
                flags: MessageFlags.Ephemeral
            });

            return;
        }

        // Responde imediatamente ao modal para ele fechar sem ficar
        // no estado "RZ Store está pensando...".
        await interaction.reply({
            content:
                "<:okk:1549125132906270851> Dados recebidos! Aguarde a equipe realizar a entrega.",
            flags: MessageFlags.Ephemeral
        });

        // Marca imediatamente para impedir qualquer segundo envio.
        robloxNickEnviado.add(
            interaction.channel.id
        );

        try {

            const embedRoblox = new EmbedBuilder()
                .setColor("#00db0f")
                .setTitle(
                    "<:roblox:1548176792010104923> Dados para entrega"
                )
                .setDescription(
                    `> **Cliente:** ${interaction.user}\n` +
                    `> **Roblox:** \`${nickRoblox}\`\n` +
                    `> <:greenrbx:1548088739677470881> **Quantidade:** ${quantidadeRobuxFormatada} Robux\n` +
                    `> <:pix:1548090281402966107> **Valor pago:** ${valorPagamentoFormatado}\n\n` +
                    "<:okk:1549125132906270851> Os dados foram enviados para a equipe. Agora é só aguardar a entrega."
                )
                .setFooter({
                    text: "RZ Store"
                })
                .setTimestamp();

            const botaoEntrega =
                new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(
                                "marcar_entregue"
                            )
                            .setLabel(
                                "Marcar como entregue"
                            )
                            .setEmoji({
                                id:
                                    "1549125132906270851",
                                name:
                                    "okk"
                            })
                            .setStyle(
                                ButtonStyle.Success
                            )
                    );

            await interaction.channel.send({
                content: `<@&${process.env.STAFF_ROLE_ID}>`,
                embeds: [embedRoblox],
                components: [
                    botaoEntrega
                ],
                allowedMentions: {
                    roles: [
                        process.env.STAFF_ROLE_ID
                    ]
                }
            });

            // Desativa o botão da mensagem EXATA que abriu o modal.
            try {

                const mensagemComBotao =
                    await interaction.channel.messages.fetch(
                        mensagemBotaoId
                    );

                const componentesDesativados =
                    mensagemComBotao.components.map(row => {

                        const novaLinha =
                            ActionRowBuilder.from(row);

                        const novosBotoes =
                            row.components.map(component => {

                                const botao =
                                    ButtonBuilder.from(component);

                                if (
                                    component.customId ===
                                    "enviar_nick_roblox"
                                ) {
                                    botao.setDisabled(true);
                                }

                                return botao;
                            });

                        novaLinha.setComponents(
                            novosBotoes
                        );

                        return novaLinha;
                    });

                await mensagemComBotao.edit({
                    components:
                        componentesDesativados
                });

            } catch (buttonError) {

                console.warn(
                    "Não foi possível desativar o botão do Roblox:",
                    buttonError
                );

            }

        } catch (error) {

            console.error(
                "Erro ao enviar embed dos dados do Roblox:",
                error
            );

            await interaction.followUp({
                content:
                    "<:x_:1549124126575165533> Houve um erro ao registrar os dados no ticket. Avise a equipe.",
                flags: MessageFlags.Ephemeral
            });

        }

        return;
    }


    // =========================================
    // BOTÕES
    // =========================================

    if (interaction.isButton()) {

        // =========================================
        // ENVIAR NICK / ID DO ROBLOX
        // =========================================

        if (
            interaction.customId === "enviar_nick_roblox"
        ) {

            if (
                robloxNickEnviado.has(
                    interaction.channel.id
                )
            ) {
                await interaction.reply({
                    content:
                        "<:danger:1549129849904566392> Você já enviou os dados do Roblox neste ticket.",
                    flags: MessageFlags.Ephemeral
                });

                return;
            }

            const donoTicket = interaction.channel.topic
                ?.match(/rzstore-user:(\d+)/)?.[1];

            if (
                !donoTicket ||
                interaction.user.id !== donoTicket
            ) {
                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Apenas o cliente deste ticket pode enviar os dados do Roblox.",
                    flags: MessageFlags.Ephemeral
                });

                return;
            }
            const modalRoblox = new ModalBuilder()
                .setCustomId(
                    `modal_nick_roblox_${interaction.message.id}`
                )
                .setTitle("Dados do Roblox");

            const nickInput = new TextInputBuilder()
                .setCustomId("nick_roblox")
                .setLabel("Nome de usuário ou ID do Roblox")
                .setPlaceholder("Exemplo: @bananinhagamer123 ou 123456789")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(50);

            modalRoblox.addComponents(
                new ActionRowBuilder()
                    .addComponents(nickInput)
            );

            await interaction.showModal(
                modalRoblox
            );

            return;
        }


        // =========================================
        // MARCAR PEDIDO COMO ENTREGUE
        // =========================================

        if (
            interaction.customId ===
            "marcar_entregue"
        ) {

            const ehStaff =
                interaction.member.roles.cache.has(
                    process.env.STAFF_ROLE_ID
                );

            if (!ehStaff) {

                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Apenas a equipe da RZ Store pode marcar um pedido como entregue.",
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            const orderId =
                interaction.channel.topic
                    ?.match(
                        /mp-order:([^|]+)/
                    )?.[1]
                    ?.trim();

            if (!orderId) {

                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Não encontrei a Order deste pedido.",
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            const compra =
                db.prepare(`
                    SELECT
                        order_id,
                        entregue
                    FROM compras
                    WHERE order_id = ?
                `).get(orderId);

            if (!compra) {

                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Esta compra ainda não está registrada no banco.",
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            if (
                Number(compra.entregue) === 1
            ) {

                await interaction.reply({
                    content:
                        "<:danger:1549129849904566392> Este pedido já foi marcado como entregue.",
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            const confirmacao =
                new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(
                                `confirmar_entrega_${interaction.message.id}`
                            )
                            .setLabel(
                                "Confirmar entrega"
                            )
                            .setStyle(
                                ButtonStyle.Success
                            )
                            .setEmoji({
                                id:
                                    "1549125132906270851",
                                name:
                                    "okk"
                            }),

                        new ButtonBuilder()
                            .setCustomId(
                                `cancelar_entrega_${interaction.message.id}`
                            )
                            .setLabel(
                                "Cancelar"
                            )
                            .setStyle(
                                ButtonStyle.Secondary
                            )
                    );

            await interaction.reply({
                content:
                    "<:danger:1549129849904566392> Confirme apenas se os Robux já foram entregues ao cliente.",
                components: [
                    confirmacao
                ],
                flags:
                    MessageFlags.Ephemeral
            });

            return;
        }


        // =========================================
        // CANCELAR CONFIRMAÇÃO DE ENTREGA
        // =========================================

        if (
            interaction.customId.startsWith(
                "cancelar_entrega_"
            )
        ) {

            const ehStaff =
                interaction.member.roles.cache.has(
                    process.env.STAFF_ROLE_ID
                );

            if (!ehStaff) {

                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Apenas a equipe pode realizar esta ação.",
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            await interaction.update({
                content:
                    "Entrega não foi marcada.",
                components: []
            });

            return;
        }


        // =========================================
        // CONFIRMAR ENTREGA
        // =========================================

        if (
            interaction.customId.startsWith(
                "confirmar_entrega_"
            )
        ) {

            const ehStaff =
                interaction.member.roles.cache.has(
                    process.env.STAFF_ROLE_ID
                );

            if (!ehStaff) {

                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Apenas a equipe da RZ Store pode confirmar entregas.",
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            await interaction.deferUpdate();

            const mensagemEntregaId =
                interaction.customId.replace(
                    "confirmar_entrega_",
                    ""
                );

            const donoTicket =
                interaction.channel.topic
                    ?.match(
                        /rzstore-user:(\d+)/
                    )?.[1];

            const orderId =
                interaction.channel.topic
                    ?.match(
                        /mp-order:([^|]+)/
                    )?.[1]
                    ?.trim();

            if (
                !donoTicket ||
                !orderId
            ) {

                await interaction.editReply({
                    content:
                        "<:x_:1549124126575165533> Não consegui identificar o cliente ou a Order deste pedido.",
                    components: []
                });

                return;
            }

            try {

                // UPDATE condicional: mesmo com dois cliques/webhooks,
                // a entrega só pode ser finalizada uma vez.
                const resultado =
                    db.prepare(`
                        UPDATE compras
                        SET
                            entregue = 1,
                            entregue_em =
                                CURRENT_TIMESTAMP,
                            entregue_por = ?
                        WHERE
                            order_id = ?
                            AND entregue = 0
                    `).run(
                        interaction.user.id,
                        orderId
                    );

                if (
                    Number(resultado.changes) === 0
                ) {

                    await interaction.editReply({
                        content:
                            "<:danger:1549129849904566392> Este pedido já foi marcado como entregue.",
                        components: []
                    });

                    return;
                }

                const compra =
                    db.prepare(`
                        SELECT
                            order_id,
                            payment_id,
                            discord_id,
                            valor_centavos,
                            quantidade_robux,
                            produto,
                            entregue_em,
                            entregue_por
                        FROM compras
                        WHERE order_id = ?
                    `).get(orderId);

                const membroCliente =
                    await interaction.guild.members.fetch(
                        donoTicket
                    );

                // Desativa o botão original de entrega.
                try {

                    const mensagemEntrega =
                        await interaction.channel.messages.fetch(
                            mensagemEntregaId
                        );

                    const componentes =
                        mensagemEntrega.components.map(
                            row => {

                                const novaLinha =
                                    ActionRowBuilder.from(
                                        row
                                    );

                                const botoes =
                                    row.components.map(
                                        component => {

                                            const botao =
                                                ButtonBuilder.from(
                                                    component
                                                );

                                            if (
                                                component.customId ===
                                                "marcar_entregue"
                                            ) {
                                                botao
                                                    .setDisabled(
                                                        true
                                                    )
                                                    .setLabel(
                                                        "Pedido entregue"
                                                    );
                                            }

                                            return botao;
                                        }
                                    );

                                novaLinha.setComponents(
                                    botoes
                                );

                                return novaLinha;
                            }
                        );

                    await mensagemEntrega.edit({
                        components:
                            componentes
                    });

                } catch (buttonError) {

                    console.warn(
                        "[ENTREGA] Não foi possível desativar o botão de entrega:",
                        buttonError
                    );
                }

                const valorFormatado =
                    (
                        Number(
                            compra?.valor_centavos ||
                            0
                        ) / 100
                    ).toLocaleString(
                        "pt-BR",
                        {
                            style:
                                "currency",
                            currency:
                                "BRL"
                        }
                    );

                const quantidadeFormatada =
                    compra?.quantidade_robux
                        ? Number(
                            compra.quantidade_robux
                        ).toLocaleString(
                            "pt-BR"
                        )
                        : "—";

                const canalAvaliacoesId =
                    process.env.CANAL_AVALIACOES_ID;

                const textoAvaliacao =
                    canalAvaliacoesId
                        ? `<a:greenverification:1548192162653536336> Se puder, conte como foi sua experiência em <#${canalAvaliacoesId}>! Sua avaliação ajuda muito a RZ Store.`
                        : "<a:greenverification:1548192162653536336> Se puder, deixe uma avaliação da sua experiência com a **RZ Store**!";

                const embedEntregue =
                    new EmbedBuilder()
                        .setColor(
                            "#00db0f"
                        )
                        .setTitle(
                            "<a:greenverification:1548192162653536336> Pedido entregue!"
                        )
                        .setDescription(
                            `${membroCliente}, seu pedido foi marcado como **entregue** pela equipe da RZ Store.\n\n` +
                            `> <:greenrbx:1548088739677470881> **Quantidade:** ${quantidadeFormatada} Robux\n` +
                            `> <:pix:1548090281402966107> **Valor:** ${valorFormatado}\n` +
                            `> <:sup:1548200025442750505> **Entregue por:** ${interaction.user}\n\n` +
                            `${textoAvaliacao}\n\n` +
                            "Obrigado pela preferência! <:greenheart:1548096797992296488>"
                        )
                        .setFooter({
                            text:
                                "RZ Store • Pedido finalizado"
                        })
                        .setTimestamp();

                await interaction.channel.send({
                    content:
                        `<@${donoTicket}>`,
                    embeds: [
                        embedEntregue
                    ],
                    allowedMentions: {
                        users: [
                            donoTicket
                        ],
                        roles: []
                    }
                });

                // =========================================
                // LOG DA COMPRA ENTREGUE
                // =========================================

                const canalLogsComprasId =
                    process.env.CANAL_LOGS_COMPRAS_ID;

                if (canalLogsComprasId) {

                    try {

                        const canalLogs =
                            await interaction.guild.channels.fetch(
                                canalLogsComprasId
                            );

                        if (
                            canalLogs &&
                            canalLogs.isTextBased()
                        ) {

                            const produtoTexto =
                                compra?.produto ||
                                (
                                    compra?.quantidade_robux
                                        ? `${quantidadeFormatada} Robux`
                                        : "Compra RZ Store"
                                );

                            const embedLogCompra =
                                new EmbedBuilder()
                                    .setColor(
                                        "#00db0f"
                                    )
                                    .setTitle(
                                        "<a:greenverification:1548192162653536336> Compra entregue"
                                    )
                                    .setDescription(
                                        `> **Cliente:** ${membroCliente}\n` +
                                        `> **Discord ID:** \`${donoTicket}\`\n` +
                                        `> <:greenrbx:1548088739677470881> **Produto:** ${produtoTexto}\n` +
                                        `> <:greenrbx:1548088739677470881> **Quantidade:** ${quantidadeFormatada} Robux\n` +
                                        `> <:pix:1548090281402966107> **Valor:** ${valorFormatado}\n` +
                                        `> <:sup:1548200025442750505> **Entregue por:** ${interaction.user}\n\n` +
                                        `> **Order:** \`${compra?.order_id || orderId}\`\n` +
                                        `> **Pagamento:** \`${compra?.payment_id || "—"}\`\n` +
                                        `> **Ticket:** ${interaction.channel}`
                                    )
                                    .setThumbnail(
                                        membroCliente.user.displayAvatarURL()
                                    )
                                    .setFooter({
                                        text:
                                            "RZ Store • Log de compras"
                                    })
                                    .setTimestamp();

                            await canalLogs.send({
                                embeds: [
                                    embedLogCompra
                                ],
                                allowedMentions: {
                                    users: [],
                                    roles: []
                                }
                            });

                        } else {

                            console.warn(
                                "[ENTREGA] CANAL_LOGS_COMPRAS_ID não aponta para um canal de texto."
                            );
                        }

                    } catch (logError) {

                        console.error(
                            "[ENTREGA] Erro ao enviar log da compra:",
                            logError
                        );
                    }

                } else {

                    console.warn(
                        "[ENTREGA] CANAL_LOGS_COMPRAS_ID não configurado no .env."
                    );
                }


                // =========================================
                // MENSAGEM PRIVADA PARA O CLIENTE
                // =========================================

                try {

                    const textoAvaliacaoPrivado =
                        canalAvaliacoesId
                            ? `Se puder, deixe sua avaliação em <#${canalAvaliacoesId}>. Sua opinião ajuda muito a RZ Store!`
                            : "Se puder, deixe uma avaliação da sua experiência com a RZ Store. Sua opinião ajuda muito!";

                    const embedPrivado =
                        new EmbedBuilder()
                            .setColor(
                                "#00db0f"
                            )
                            .setTitle(
                                "<a:greenverification:1548192162653536336> Seu pedido foi entregue!"
                            )
                            .setDescription(
                                `Seu pedido na **RZ Store** foi finalizado com sucesso.\n\n` +
                                `> <:greenrbx:1548088739677470881> **Quantidade:** ${quantidadeFormatada} Robux\n` +
                                `> <:pix:1548090281402966107> **Valor:** ${valorFormatado}\n\n` +
                                `<a:greenverification:1548192162653536336> ${textoAvaliacaoPrivado}\n\n` +
                                "Obrigado pela preferência! <:greenheart:1548096797992296488>"
                            )
                            .setFooter({
                                text:
                                    "RZ Store • Pedido finalizado"
                            })
                            .setTimestamp();

                    await membroCliente.send({
                        embeds: [
                            embedPrivado
                        ]
                    });

                } catch (dmError) {

                    console.warn(
                        `[ENTREGA] Não foi possível enviar DM para ${donoTicket}. O usuário pode estar com as mensagens privadas desativadas.`,
                        dmError?.message || dmError
                    );
                }

                await interaction.editReply({
                    content:
                        "<:okk:1549125132906270851> Pedido marcado como entregue com sucesso.",
                    components: []
                });

            } catch (error) {

                console.error(
                    "[ENTREGA] Erro ao finalizar pedido:",
                    error
                );

                await interaction.editReply({
                    content:
                        "<:x_:1549124126575165533> Ocorreu um erro ao marcar o pedido como entregue.",
                    components: []
                });
            }

            return;
        }


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

            try {

                // O botão está na mesma mensagem do embed do PIX.
                // Então pegamos o código diretamente do embed,
                // sem consultar a API do Mercado Pago novamente.
                const descricao =
                    interaction.message.embeds?.[0]?.description || "";

                const matchPix =
                    descricao.match(
                        /### PIX Copia e Cola\s*```(?:\w+)?\s*([\s\S]*?)```/i
                    );

                const pixCopiaCola =
                    matchPix?.[1]?.trim();

                if (!pixCopiaCola) {
                    throw new Error(
                        "Não encontrei o PIX no embed da mensagem."
                    );
                }

                await interaction.reply({
                    content: pixCopiaCola,
                    flags: MessageFlags.Ephemeral
                });

            } catch (error) {

                console.error(
                    "Erro ao copiar PIX:",
                    error
                );

                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Não foi possível recuperar o PIX. Tente novamente.",
                    flags: MessageFlags.Ephemeral
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

    const estoqueAtual =
        obterQuantidadeEstoque();

    if (
        quantidade >
        estoqueAtual
    ) {

        await interaction.update({
            content:
                `<:danger:1549129849904566392> Estoque insuficiente para esta compra.
` +
                `Você selecionou **${formatarRobux(quantidade)} Robux**, mas temos **${formatarRobux(estoqueAtual)} Robux** disponíveis no momento.`,
            embeds: [],
            components: []
        });

        return;
    }

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

            topic: `RZ Store | rzstore-user:${interaction.user.id} | Compra de ${interaction.user.tag} | robux:${quantidade} | valor-centavos:${Math.round(valor * 100)}`,

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

            const estoqueAtual =
                obterQuantidadeEstoque();

            if (
                produto.robux >
                estoqueAtual
            ) {

                await interaction.update({
                    content:
                        `<:danger:1549129849904566392> Estoque insuficiente para esta compra.
` +
                        `Este pedido precisa de **${formatarRobux(produto.robux)} Robux**, mas temos **${formatarRobux(estoqueAtual)} Robux** disponíveis no momento.`,
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

                    topic: `RZ Store | rzstore-user:${interaction.user.id} | Produto: ${produto.nome} | Compra de ${interaction.user.tag} | robux:${produto.robux} | valor-centavos:${Math.round(produto.valor * 100)}`,

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