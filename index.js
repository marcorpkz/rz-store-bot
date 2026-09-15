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

    CREATE TABLE IF NOT EXISTS pedidos_abertos (
        channel_id TEXT PRIMARY KEY,
        discord_id TEXT NOT NULL,
        quantidade INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'aberto',
        order_id TEXT,
        criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        encerrado_em TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pedidos_abertos_status
    ON pedidos_abertos(status);

    CREATE TABLE IF NOT EXISTS cupons (
        codigo TEXT PRIMARY KEY,
        desconto_percentual INTEGER NOT NULL,
        validade_em TEXT NOT NULL,
        limite_usos INTEGER NOT NULL DEFAULT 0,
        usos INTEGER NOT NULL DEFAULT 0,
        ativo INTEGER NOT NULL DEFAULT 1,
        criado_por TEXT,
        criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cupom_usos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        order_id TEXT NOT NULL UNIQUE,
        desconto_centavos INTEGER NOT NULL DEFAULT 0,
        usado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_cupom_usos_codigo
    ON cupom_usos(codigo);

    CREATE TABLE IF NOT EXISTS configuracoes (
        chave TEXT PRIMARY KEY,
        valor TEXT
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

if (
    !nomesColunasCompras.has(
        "valor_original_centavos"
    )
) {
    db.exec(`
        ALTER TABLE compras
        ADD COLUMN valor_original_centavos INTEGER
    `);
}

if (
    !nomesColunasCompras.has(
        "desconto_centavos"
    )
) {
    db.exec(`
        ALTER TABLE compras
        ADD COLUMN desconto_centavos INTEGER NOT NULL DEFAULT 0
    `);
}

if (
    !nomesColunasCompras.has(
        "cupom_codigo"
    )
) {
    db.exec(`
        ALTER TABLE compras
        ADD COLUMN cupom_codigo TEXT
    `);
}

// Migra a tabela de cupons sem apagar os cupons já existentes.
const colunasCupons =
    db.prepare(
        "PRAGMA table_info(cupons)"
    ).all();

const nomesColunasCupons =
    new Set(
        colunasCupons.map(
            coluna => coluna.name
        )
    );

if (
    !nomesColunasCupons.has(
        "limite_por_pessoa"
    )
) {
    db.exec(`
        ALTER TABLE cupons
        ADD COLUMN limite_por_pessoa INTEGER NOT NULL DEFAULT 0
    `);
}

if (
    !nomesColunasCupons.has(
        "maximo_robux"
    )
) {
    db.exec(`
        ALTER TABLE cupons
        ADD COLUMN maximo_robux INTEGER NOT NULL DEFAULT 0
    `);
}

if (
    !nomesColunasCupons.has(
        "somente_boosters"
    )
) {
    db.exec(`
        ALTER TABLE cupons
        ADD COLUMN somente_boosters INTEGER NOT NULL DEFAULT 0
    `);
}

console.log(
    `[BANCO] SQLite carregado: ${DATABASE_FILE}`
);

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

function obterPrazoExpiracaoPedidoMinutos() {
    const configurado = Number(
        process.env.PEDIDO_EXPIRA_MINUTOS || 30
    );

    if (!Number.isFinite(configurado) || configurado < 1) {
        return 30;
    }

    return Math.floor(configurado);
}

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




async function cancelarOrderMercadoPago(orderId) {
    const accessToken =
        process.env.MERCADO_PAGO_ACCESS_TOKEN?.trim();

    if (!accessToken) {
        throw new Error(
            "MERCADO_PAGO_ACCESS_TOKEN não foi encontrado no .env."
        );
    }

    const resposta = await fetch(
        `https://api.mercadopago.com/v1/orders/${encodeURIComponent(orderId)}/cancel`,
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-Idempotency-Key": randomUUID()
            }
        }
    );

    const texto = await resposta.text();

    let dados;

    try {
        dados = JSON.parse(texto);
    } catch {
        dados = { raw_response: texto };
    }

    if (!resposta.ok) {
        const detalhe =
            dados?.message ||
            dados?.error ||
            dados?.status_detail ||
            JSON.stringify(dados);

        const erro = new Error(
            `Mercado Pago retornou HTTP ${resposta.status} ao cancelar a order: ${detalhe}`
        );

        erro.status = resposta.status;
        erro.mercadoPago = dados;

        throw erro;
    }

    return dados;
}

function orderMercadoPagoAprovada(order) {
    const pagamento =
        order?.transactions?.payments?.[0];

    return (
        (
            order?.status === "processed" &&
            order?.status_detail === "accredited"
        ) ||
        (
            pagamento?.status === "processed" &&
            pagamento?.status_detail === "accredited"
        )
    );
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



function normalizarCodigoCupom(
    codigo
) {

    return String(
        codigo || ""
    )
        .trim()
        .toUpperCase();
}


function obterCupom(
    codigo
) {

    const codigoNormalizado =
        normalizarCodigoCupom(
            codigo
        );

    if (!codigoNormalizado) {
        return null;
    }

    return db.prepare(`
        SELECT
            codigo,
            desconto_percentual,
            validade_em,
            limite_usos,
            usos,
            limite_por_pessoa,
            maximo_robux,
            somente_boosters,
            ativo,
            criado_por,
            criado_em
        FROM cupons
        WHERE codigo = ?
    `).get(
        codigoNormalizado
    ) || null;
}


function validarCupom(
    codigo,
    {
        discordId = null,
        quantidadeRobux = null,
        isBooster = false
    } = {}
) {

    const cupom =
        obterCupom(
            codigo
        );

    if (!cupom) {
        return {
            valido: false,
            motivo:
                "Cupom não encontrado."
        };
    }

    if (
        Number(cupom.ativo) !== 1
    ) {
        return {
            valido: false,
            motivo:
                "Este cupom não está mais ativo."
        };
    }

    const validade =
        new Date(
            cupom.validade_em
        );

    if (
        Number.isNaN(
            validade.getTime()
        ) ||
        validade.getTime() <
        Date.now()
    ) {
        return {
            valido: false,
            motivo:
                "Este cupom já expirou."
        };
    }

    const limite =
        Number(
            cupom.limite_usos || 0
        );

    const usos =
        Number(
            cupom.usos || 0
        );

    if (
        limite > 0 &&
        usos >= limite
    ) {
        return {
            valido: false,
            motivo:
                "Este cupom atingiu o limite total de usos."
        };
    }

    const limitePorPessoa =
        Number(
            cupom.limite_por_pessoa || 0
        );

    if (
        limitePorPessoa > 0 &&
        discordId
    ) {

        const usosDaPessoa =
            Number(
                db.prepare(`
                    SELECT COUNT(*) AS total
                    FROM cupom_usos
                    WHERE
                        codigo = ?
                        AND discord_id = ?
                `).get(
                    cupom.codigo,
                    discordId
                )?.total || 0
            );

        if (
            usosDaPessoa >=
            limitePorPessoa
        ) {
            return {
                valido: false,
                motivo:
                    limitePorPessoa === 1
                        ? "Você já utilizou este cupom anteriormente."
                        : `Você já atingiu o limite de ${limitePorPessoa} usos deste cupom por pessoa.`
            };
        }
    }

    const maximoRobux =
        Number(
            cupom.maximo_robux || 0
        );

    if (
        maximoRobux > 0 &&
        Number.isFinite(
            Number(
                quantidadeRobux
            )
        ) &&
        Number(
            quantidadeRobux
        ) >
        maximoRobux
    ) {
        return {
            valido: false,
            motivo:
                `Este cupom só pode ser usado em pedidos de até ${formatarRobux(maximoRobux)} Robux.`
        };
    }

    if (
        Number(
            cupom.somente_boosters || 0
        ) === 1 &&
        !isBooster
    ) {
        return {
            valido: false,
            motivo:
                "Este cupom é exclusivo para boosters do servidor."
        };
    }

    return {
        valido: true,
        cupom
    };
}

function calcularDescontoCupom(
    valorOriginalCentavos,
    cupom
) {

    const descontoPercentual =
        Number(
            cupom.desconto_percentual
        );

    const descontoCentavos =
        Math.round(
            valorOriginalCentavos *
            descontoPercentual /
            100
        );

    const valorFinalCentavos =
        Math.max(
            1,
            valorOriginalCentavos -
            descontoCentavos
        );

    return {
        descontoPercentual,
        descontoCentavos,
        valorFinalCentavos
    };
}


function listarCuponsAtivos() {

    return db.prepare(`
        SELECT
            codigo,
            desconto_percentual,
            validade_em,
            limite_usos,
            usos,
            limite_por_pessoa,
            maximo_robux,
            somente_boosters
        FROM cupons
        WHERE
            ativo = 1
            AND validade_em > ?
            AND (
                limite_usos = 0
                OR usos < limite_usos
            )
        ORDER BY
            desconto_percentual DESC,
            validade_em ASC
    `).all(
        new Date().toISOString()
    );
}


function formatarListaCupons(
    cupons
) {

    if (
        !cupons ||
        cupons.length === 0
    ) {
        return (
            "<:interrogacoes:1548096277856649296> " +
            "**Nenhum cupom ativo no momento.**\n\n" +
            "Fique de olho neste canal para não perder os próximos descontos!"
        );
    }

    return cupons
        .map(cupom => {

            const validadeUnix =
                Math.floor(
                    new Date(
                        cupom.validade_em
                    ).getTime() /
                    1000
                );

            const limite =
                Number(
                    cupom.limite_usos || 0
                );

            const usos =
                Number(
                    cupom.usos || 0
                );

            const usosTexto =
                limite === 0
                    ? "<:danger:1549129849904566392> Usos totais ilimitados"
                    : `<:danger:1549129849904566392> ${Math.max(
                        0,
                        limite - usos
                    )} uso(s) total(is) restante(s)`;

            const regras = [
                usosTexto
            ];

            const limitePorPessoa =
                Number(
                    cupom.limite_por_pessoa || 0
                );

            if (
                limitePorPessoa > 0
            ) {
                regras.push(
                    limitePorPessoa === 1
                        ? "<:cliente:1548196941102317568> 1 uso por pessoa"
                        : `<:cliente:1548196941102317568> Até ${limitePorPessoa} usos por pessoa`
                );
            }

            const maximoRobux =
                Number(
                    cupom.maximo_robux || 0
                );

            if (
                maximoRobux > 0
            ) {
                regras.push(
                    `<:greencart:1548089836647485591> Pedidos de até ${formatarRobux(maximoRobux)} Robux`
                );
            }

            if (
                Number(
                    cupom.somente_boosters || 0
                ) === 1
            ) {
                regras.push(
                    "<:esmeralda:1548188465508909118> Exclusivo para boosters"
                );
            }

            return (
                `### <:cupom:1548097312046186559> \`${cupom.codigo}\` — ${cupom.desconto_percentual}% OFF\n` +
                `> <:ampulheta:1549129208557469786> Válido até <t:${validadeUnix}:D>\n` +
                regras
                    .map(
                        regra =>
                            `> ${regra}`
                    )
                    .join(
                        "\n"
                    )
            );
        })
        .join(
            "\n\n"
        );
}


async function atualizarPainelCupons(
    guild
) {

    const canalId =
        process.env.CANAL_CUPONS_ID;

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
            console.warn(
                "[CUPONS] CANAL_CUPONS_ID não aponta para um canal de texto."
            );
            return;
        }

        const embed =
            new EmbedBuilder()
                .setColor(
                    "#00db0f"
                )
                .setTitle(
                    "<a:greengifts:1548099596075409499> Cupons de desconto disponíveis"
                )
                .setDescription(
                    "<a:greensparkles:1548099963051843695> Aproveite os cupons ativos abaixo e economize nas suas compras de Robux.\n\n" +
                    formatarListaCupons(
                        listarCuponsAtivos()
                    ) +
                    "\n\n> Use o código do cupom durante sua compra."
                )
                .setFooter({
                    text:
                        "RZ Store • Cupons"
                })
                .setTimestamp();

        const banner =
            process.env.CUPONS_BANNER_URL
                ?.trim();

        if (
            banner &&
            /^https?:\/\//i.test(
                banner
            )
        ) {
            embed.setImage(
                banner
            );
        }

        const config =
            db.prepare(`
                SELECT valor
                FROM configuracoes
                WHERE chave =
                    'painel_cupons_message_id'
            `).get();

        let mensagem = null;

        if (config?.valor) {
            try {
                mensagem =
                    await canal.messages.fetch(
                        config.valor
                    );
            } catch {
                mensagem = null;
            }
        }

        if (mensagem) {

            await mensagem.edit({
                embeds: [
                    embed
                ]
            });

        } else {

            const novaMensagem =
                await canal.send({
                    embeds: [
                        embed
                    ]
                });

            db.prepare(`
                INSERT INTO configuracoes (
                    chave,
                    valor
                )
                VALUES (
                    'painel_cupons_message_id',
                    ?
                )
                ON CONFLICT(chave)
                DO UPDATE SET
                    valor =
                        excluded.valor
            `).run(
                novaMensagem.id
            );
        }

    } catch (error) {

        console.error(
            "[CUPONS] Erro ao atualizar painel:",
            error
        );
    }
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


function obterRobuxPedidosEmAberto(
    excluirChannelId = null
) {

    let linha;

    if (excluirChannelId) {

        linha =
            db.prepare(`
                SELECT
                    COALESCE(
                        SUM(quantidade),
                        0
                    ) AS total
                FROM pedidos_abertos
                WHERE
                    status = 'aberto'
                    AND channel_id <> ?
            `).get(
                excluirChannelId
            );

    } else {

        linha =
            db.prepare(`
                SELECT
                    COALESCE(
                        SUM(quantidade),
                        0
                    ) AS total
                FROM pedidos_abertos
                WHERE status = 'aberto'
            `).get();
    }

    return Number(
        linha?.total || 0
    );
}


function obterEstoqueDisponivel(
    excluirChannelId = null
) {

    return Math.max(
        0,
        obterQuantidadeEstoque() -
        obterRobuxPedidosEmAberto(
            excluirChannelId
        )
    );
}


function obterLimiteMaximoPedido(
    excluirChannelId = null
) {

    const disponivel =
        obterEstoqueDisponivel(
            excluirChannelId
        );

    return disponivel >= 200
        ? Math.floor(
            disponivel /
            2
        )
        : disponivel;
}


function validarLimiteMaximoPedido({
    quantidade,
    excluirChannelId = null
}) {

    const quantidadeNumero =
        Number(
            quantidade
        );

    const disponivel =
        obterEstoqueDisponivel(
            excluirChannelId
        );

    const limiteAplicavel =
        disponivel >= 200
            ? Math.floor(
                disponivel /
                2
            )
            : disponivel;

    if (
        !Number.isInteger(
            quantidadeNumero
        ) ||
        quantidadeNumero <= 0
    ) {
        return {
            valido: false,
            motivo:
                "Quantidade de Robux inválida.",
            limite:
                limiteAplicavel,
            disponivel
        };
    }

    if (
        quantidadeNumero >
        limiteAplicavel
    ) {
        return {
            valido: false,
            motivo:
                `Para manter Robux disponíveis para outros clientes, cada pedido pode usar no máximo **50% do estoque disponível**.\n\n` +
                `> <:greenrbx:1548088739677470881> **Disponível agora:** ${formatarRobux(disponivel)} Robux\n` +
                `> <:greencart:1548089836647485591> **Máximo por pedido:** ${formatarRobux(limiteAplicavel)} Robux`,
            limite:
                limiteAplicavel,
            disponivel
        };
    }

    return {
        valido: true,
        limite:
            limiteAplicavel,
        disponivel
    };
}


function reservarPedidoEmAberto({
    channelId,
    discordId,
    quantidade
}) {

    const quantidadeNumero =
        Number(
            quantidade
        );

    if (
        !channelId ||
        !discordId ||
        !Number.isInteger(
            quantidadeNumero
        ) ||
        quantidadeNumero <= 0
    ) {
        throw new Error(
            "Dados inválidos para registrar o pedido em aberto."
        );
    }

    db.exec(
        "BEGIN IMMEDIATE"
    );

    try {

        const existente =
            db.prepare(`
                SELECT
                    status,
                    quantidade
                FROM pedidos_abertos
                WHERE channel_id = ?
            `).get(
                channelId
            );

        if (
            existente?.status ===
            "aberto"
        ) {

            const estoqueTotal =
                obterQuantidadeEstoque();

            const pedidosEmAberto =
                obterRobuxPedidosEmAberto();

            db.exec(
                "COMMIT"
            );

            return {
                reservado: true,
                estoqueTotal,
                pedidosEmAberto,
                disponivel:
                    Math.max(
                        0,
                        estoqueTotal -
                        pedidosEmAberto
                    )
            };
        }

        const estoqueTotal =
            obterQuantidadeEstoque();

        const pedidosAntes =
            obterRobuxPedidosEmAberto();

        const disponivelAntes =
            Math.max(
                0,
                estoqueTotal -
                pedidosAntes
            );

        const limitePedido =
            disponivelAntes >= 200
                ? Math.floor(
                    disponivelAntes /
                    2
                )
                : disponivelAntes;

        if (
            quantidadeNumero >
            disponivelAntes ||
            quantidadeNumero >
            limitePedido
        ) {

            db.exec(
                "ROLLBACK"
            );

            return {
                reservado: false,
                estoqueTotal,
                pedidosEmAberto:
                    pedidosAntes,
                disponivel:
                    disponivelAntes,
                limite:
                    limitePedido,
                motivo:
                    quantidadeNumero >
                    limitePedido
                        ? "limite_metade"
                        : "estoque"
            };
        }

        db.prepare(`
            INSERT INTO pedidos_abertos (
                channel_id,
                discord_id,
                quantidade,
                status
            )
            VALUES (?, ?, ?, 'aberto')

            ON CONFLICT(channel_id)
            DO UPDATE SET
                discord_id =
                    excluded.discord_id,
                quantidade =
                    excluded.quantidade,
                status =
                    'aberto',
                order_id =
                    NULL,
                criado_em =
                    CURRENT_TIMESTAMP,
                encerrado_em =
                    NULL
        `).run(
            channelId,
            discordId,
            quantidadeNumero
        );

        const pedidosDepois =
            pedidosAntes +
            quantidadeNumero;

        db.exec(
            "COMMIT"
        );

        return {
            reservado: true,
            estoqueTotal,
            pedidosEmAberto:
                pedidosDepois,
            disponivel:
                Math.max(
                    0,
                    estoqueTotal -
                    pedidosDepois
                )
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


function obterPedidoAbertoPorCanal(channelId) {
    if (!channelId) {
        return null;
    }

    return db.prepare(`
        SELECT
            channel_id,
            discord_id,
            quantidade,
            status,
            order_id,
            criado_em,
            CAST(strftime('%s', criado_em) AS INTEGER) AS criado_unix
        FROM pedidos_abertos
        WHERE channel_id = ?
    `).get(channelId) || null;
}

function pedidoAbertoExpirou(pedido) {
    if (!pedido || pedido.status !== "aberto") {
        return false;
    }

    const criadoUnix = Number(pedido.criado_unix);

    if (!Number.isFinite(criadoUnix)) {
        return false;
    }

    const expiraUnix =
        calcularExpiracaoUnixPedido(
            pedido
        );

    if (!expiraUnix) {
        return false;
    }

    return (
        Math.floor(
            Date.now() /
            1000
        ) >=
        expiraUnix
    );
}

function encerrarPedidoEmAberto(
    channelId,
    status = "cancelado",
    orderId = null
) {

    if (!channelId) {
        return false;
    }

    const resultado =
        db.prepare(`
            UPDATE pedidos_abertos
            SET
                status = ?,
                order_id =
                    COALESCE(
                        ?,
                        order_id
                    ),
                encerrado_em =
                    CURRENT_TIMESTAMP
            WHERE
                channel_id = ?
                AND status = 'aberto'
        `).run(
            status,
            orderId,
            channelId
        );

    return Number(
        resultado.changes
    ) > 0;
}


async function reconciliarPedidosEmAberto(
    guild
) {

    try {

        const canais =
            await guild.channels.fetch();

        const pedidos =
            db.prepare(`
                SELECT channel_id
                FROM pedidos_abertos
                WHERE status = 'aberto'
            `).all();

        for (
            const pedido
            of pedidos
        ) {

            if (
                !canais.has(
                    pedido.channel_id
                )
            ) {

                encerrarPedidoEmAberto(
                    pedido.channel_id,
                    "cancelado"
                );
            }
        }

    } catch (error) {

        console.error(
            "[ESTOQUE] Erro ao reconciliar pedidos em aberto:",
            error
        );
    }
}


const pedidosSendoExpirados = new Set();

const timersExpiracaoPedidos =
    new Map();


function limparTimerExpiracaoPedido(
    channelId
) {

    const timer =
        timersExpiracaoPedidos.get(
            channelId
        );

    if (timer) {
        clearTimeout(
            timer
        );

        timersExpiracaoPedidos.delete(
            channelId
        );
    }
}


function calcularExpiracaoUnixPedido(
    pedido
) {

    const criadoUnix =
        Number(
            pedido?.criado_unix
        );

    if (
        !Number.isFinite(
            criadoUnix
        )
    ) {
        return null;
    }

    return (
        criadoUnix +
        obterPrazoExpiracaoPedidoMinutos() *
        60
    );
}


function agendarExpiracaoPedido(
    guild,
    channelId
) {

    limparTimerExpiracaoPedido(
        channelId
    );

    const pedido =
        obterPedidoAbertoPorCanal(
            channelId
        );

    if (
        !pedido ||
        pedido.status !==
            "aberto"
    ) {
        return false;
    }

    const expiraUnix =
        calcularExpiracaoUnixPedido(
            pedido
        );

    if (!expiraUnix) {
        return false;
    }

    const agoraUnix =
        Math.floor(
            Date.now() /
            1000
        );

    const atrasoMs =
        Math.max(
            1000,
            (
                expiraUnix -
                agoraUnix
            ) *
            1000
        );

    const timer =
        setTimeout(
            async () => {

                timersExpiracaoPedidos.delete(
                    channelId
                );

                try {

                    await processarExpiracaoPedido(
                        guild,
                        pedido
                    );

                } catch (error) {

                    console.error(
                        `[EXPIRAÇÃO] Erro no timer do pedido ${channelId}:`,
                        error
                    );
                }

            },
            atrasoMs
        );

    timersExpiracaoPedidos.set(
        channelId,
        timer
    );

    console.log(
        `[EXPIRAÇÃO] Pedido ${channelId} agendado para expirar em ${Math.ceil(atrasoMs / 1000)}s.`
    );

    return true;
}


async function agendarTodosPedidosEmAberto(
    guild
) {

    const pedidos =
        db.prepare(`
            SELECT
                channel_id
            FROM pedidos_abertos
            WHERE status = 'aberto'
        `).all();

    for (
        const pedido
        of pedidos
    ) {

        agendarExpiracaoPedido(
            guild,
            pedido.channel_id
        );
    }

    console.log(
        `[EXPIRAÇÃO] ${pedidos.length} pedido(s) em aberto agendado(s).`
    );
}


async function enviarLogPedidoExpirado({
    guild,
    pedido,
    channel,
    user,
    orderId,
    orderCancelada,
    valorCentavos
}) {
    const canalLogsId =
        process.env.CANAL_LOGS_PEDIDOS_EXPIRADOS_ID ||
        process.env.CANAL_LOGS_COMPRAS_ID;

    if (!canalLogsId) {
        return;
    }

    try {
        const canalLogs =
            await guild.channels.fetch(canalLogsId);

        if (!canalLogs || !canalLogs.isTextBased()) {
            return;
        }

        const valorFormatado =
            Number.isInteger(valorCentavos) &&
            valorCentavos > 0
                ? (valorCentavos / 100).toLocaleString(
                    "pt-BR",
                    {
                        style: "currency",
                        currency: "BRL"
                    }
                )
                : "Não identificado";

        const embed =
            new EmbedBuilder()
                .setColor("#00db0f")
                .setTitle(
                    "<:ampulheta:1549129208557469786> Pedido expirado"
                )
                .setDescription(
                    "Um pedido foi encerrado automaticamente porque o prazo para pagamento terminou.\n\n" +
                    `> <:cliente:1548196941102317568> **Cliente:** ${user ? `${user}` : `<@${pedido.discord_id}>`}\n` +
                    `> **ID do cliente:** \`${pedido.discord_id}\`\n` +
                    `> <:greenrbx:1548088739677470881> **Quantidade:** ${formatarRobux(pedido.quantidade)} Robux\n` +
                    `> <:pix:1548090281402966107> **Valor:** ${valorFormatado}\n` +
                    `> <:ampulheta:1549129208557469786> **Prazo:** ${obterPrazoExpiracaoPedidoMinutos()} minutos\n` +
                    `> **Ticket:** ${channel ? `${channel}` : `\`${pedido.channel_id}\``}\n` +
                    `> **Order Mercado Pago:** ${orderId ? `\`${orderId}\`` : "Nenhuma cobrança gerada"}\n` +
                    `> **Cobrança cancelada:** ${orderId ? (orderCancelada ? "Sim" : "Já estava encerrada") : "Não se aplica"}\n\n` +
                    "Os Robux do pedido voltaram a ficar disponíveis no estoque."
                )
                .setFooter({
                    text: "RZ Store • Pedidos expirados"
                })
                .setTimestamp();

        if (user) {
            embed.setThumbnail(
                user.displayAvatarURL()
            );
        }

        await canalLogs.send({
            embeds: [embed]
        });

    } catch (error) {
        console.error(
            "[EXPIRAÇÃO] Erro ao enviar log:",
            error
        );
    }
}

async function enviarDmPedidoExpirado({
    user,
    pedido,
    orderId
}) {
    if (!user) {
        return false;
    }

    try {
        const embed =
            new EmbedBuilder()
                .setColor("#00db0f")
                .setTitle(
                    "<:ampulheta:1549129208557469786> Seu pedido expirou"
                )
                .setDescription(
                    `O prazo de **${obterPrazoExpiracaoPedidoMinutos()} minutos** para pagamento do seu pedido na **RZ Store** terminou.\n\n` +
                    `> <:greenrbx:1548088739677470881> **Pedido:** ${formatarRobux(pedido.quantidade)} Robux\n` +
                    (
                        orderId
                            ? "> <:pix:1548090281402966107> A cobrança PIX pendente foi encerrada.\n"
                            : ""
                    ) +
                    "\nOs Robux que estavam separados para o seu pedido foram liberados novamente para o estoque.\n\n" +
                    "<a:greensparkles:1548099963051843695> Se ainda quiser comprar, é só iniciar um novo pedido na **RZ Store**."
                )
                .setFooter({
                    text: "RZ Store • Pedido expirado"
                })
                .setTimestamp();

        await user.send({
            embeds: [embed]
        });

        return true;

    } catch (error) {
        console.warn(
            `[EXPIRAÇÃO] Não foi possível enviar DM para ${pedido.discord_id}:`,
            error?.message || error
        );

        return false;
    }
}

async function processarExpiracaoPedido(
    guild,
    pedidoInicial
) {
    const channelId =
        pedidoInicial?.channel_id;

    if (
        !channelId ||
        pedidosSendoExpirados.has(channelId)
    ) {
        return false;
    }

    pedidosSendoExpirados.add(channelId);

    try {
        const pedido =
            obterPedidoAbertoPorCanal(channelId);

        if (
            !pedido ||
            pedido.status !== "aberto" ||
            !pedidoAbertoExpirou(pedido)
        ) {
            return false;
        }

        console.log(
            `[EXPIRAÇÃO] Processando pedido expirado ${channelId}.`
        );

        let channel = null;

        try {
            channel =
                await guild.channels.fetch(channelId);
        } catch {}

        const orderId =
            pedido.order_id ||
            channel?.topic
                ?.match(/mp-order:([^|]+)/)?.[1]
                ?.trim() ||
            null;

        let orderCancelada = false;

        if (orderId) {
            let orderAtual = null;

            try {
                orderAtual =
                    await buscarOrderMercadoPago(orderId);
            } catch (error) {
                console.warn(
                    `[EXPIRAÇÃO] Não consegui consultar a order ${orderId}:`,
                    error?.message || error
                );
            }

            if (
                orderMercadoPagoAprovada(orderAtual)
            ) {
                await processarOrderAprovada(orderId);
                return false;
            }

            const statusAtual =
                String(orderAtual?.status || "")
                    .toLowerCase();

            const detalheAtual =
                String(orderAtual?.status_detail || "")
                    .toLowerCase();

            const jaEncerrada =
                [
                    "canceled",
                    "cancelled",
                    "expired"
                ].includes(statusAtual) ||
                [
                    "canceled",
                    "cancelled",
                    "expired"
                ].includes(detalheAtual);

            if (!jaEncerrada) {
                try {
                    await cancelarOrderMercadoPago(orderId);
                    orderCancelada = true;

                } catch (cancelError) {
                    let orderDepois = null;

                    try {
                        orderDepois =
                            await buscarOrderMercadoPago(orderId);
                    } catch {}

                    if (
                        orderMercadoPagoAprovada(orderDepois)
                    ) {
                        await processarOrderAprovada(orderId);
                        return false;
                    }

                    const statusDepois =
                        String(orderDepois?.status || "")
                            .toLowerCase();

                    const detalheDepois =
                        String(orderDepois?.status_detail || "")
                            .toLowerCase();

                    const seguraParaLiberar =
                        [
                            "canceled",
                            "cancelled",
                            "expired"
                        ].includes(statusDepois) ||
                        [
                            "canceled",
                            "cancelled",
                            "expired"
                        ].includes(detalheDepois);

                    if (!seguraParaLiberar) {

                        if (
                            MERCADO_PAGO_TEST_MODE
                        ) {

                            console.warn(
                                `[EXPIRAÇÃO] Sandbox: não foi possível confirmar o cancelamento da order ${orderId}. O pedido local será expirado mesmo assim para permitir o teste do fluxo.`,
                                cancelError?.message ||
                                cancelError
                            );

                        } else {

                            console.error(
                                `[EXPIRAÇÃO] A order ${orderId} não pôde ser cancelada. O estoque continuará reservado por segurança e o bot tentará novamente.`,
                                cancelError
                            );

                            // Reagenda uma nova tentativa em 60 segundos.
                            const retryTimer =
                                setTimeout(
                                    async () => {

                                        timersExpiracaoPedidos.delete(
                                            channelId
                                        );

                                        try {
                                            await processarExpiracaoPedido(
                                                guild,
                                                pedido
                                            );
                                        } catch (retryError) {
                                            console.error(
                                                `[EXPIRAÇÃO] Falha na nova tentativa do pedido ${channelId}:`,
                                                retryError
                                            );
                                        }

                                    },
                                    60 * 1000
                                );

                            timersExpiracaoPedidos.set(
                                channelId,
                                retryTimer
                            );

                            return false;
                        }
                    }
                }
            }
        }

        const resultado =
            db.prepare(`
                UPDATE pedidos_abertos
                SET
                    status = 'expirado',
                    order_id = COALESCE(?, order_id),
                    encerrado_em = CURRENT_TIMESTAMP
                WHERE
                    channel_id = ?
                    AND status = 'aberto'
            `).run(
                orderId,
                channelId
            );

        if (Number(resultado.changes) === 0) {
            return false;
        }

        limparTimerExpiracaoPedido(
            channelId
        );

        await atualizarPainelEstoque(guild);

        let user = null;

        try {
            user =
                await client.users.fetch(
                    pedido.discord_id
                );
        } catch {}

        const valorCentavos =
            Number(
                channel?.topic
                    ?.match(/valor-centavos:(\d+)/)?.[1]
            );

        await enviarLogPedidoExpirado({
            guild,
            pedido,
            channel,
            user,
            orderId,
            orderCancelada,
            valorCentavos:
                Number.isInteger(valorCentavos)
                    ? valorCentavos
                    : null
        });

        await enviarDmPedidoExpirado({
            user,
            pedido,
            orderId
        });

        if (
            channel &&
            channel.isTextBased()
        ) {
            try {
                const embedTicket =
                    new EmbedBuilder()
                        .setColor("#00db0f")
                        .setTitle(
                            "<:ampulheta:1549129208557469786> Pedido expirado"
                        )
                        .setDescription(
                            `O prazo de **${obterPrazoExpiracaoPedidoMinutos()} minutos** para pagamento terminou.\n\n` +
                            `> <:greenrbx:1548088739677470881> **${formatarRobux(pedido.quantidade)} Robux** foram liberados novamente para o estoque.\n\n` +
                            "Este ticket será fechado automaticamente."
                        )
                        .setFooter({
                            text: "RZ Store • Pedido expirado"
                        })
                        .setTimestamp();

                await channel.send({
                    content: `<@${pedido.discord_id}>`,
                    embeds: [embedTicket],
                    allowedMentions: {
                        users: [pedido.discord_id]
                    }
                });

                setTimeout(
                    async () => {
                        try {
                            const canalAtual =
                                await guild.channels.fetch(
                                    channelId
                                );

                            if (canalAtual) {
                                await canalAtual.delete(
                                    "Pedido expirado automaticamente"
                                );
                            }
                        } catch {}
                    },
                    10 * 1000
                );

            } catch (error) {
                console.warn(
                    "[EXPIRAÇÃO] Não foi possível avisar no ticket:",
                    error?.message || error
                );
            }
        }

        console.log(
            `[EXPIRAÇÃO] Pedido ${channelId} expirado e estoque liberado.`
        );

        return true;

    } finally {
        pedidosSendoExpirados.delete(channelId);
    }
}

async function processarPedidosExpirados(
    guild
) {

    const pedidos =
        db.prepare(`
            SELECT
                channel_id,
                discord_id,
                quantidade,
                status,
                order_id,
                criado_em,
                CAST(
                    strftime(
                        '%s',
                        criado_em
                    )
                    AS INTEGER
                ) AS criado_unix
            FROM pedidos_abertos
            WHERE status = 'aberto'
            ORDER BY criado_em ASC
        `).all();

    for (
        const pedido
        of pedidos
    ) {

        if (
            !pedidoAbertoExpirou(
                pedido
            )
        ) {
            continue;
        }

        try {

            await processarExpiracaoPedido(
                guild,
                pedido
            );

        } catch (error) {

            console.error(
                `[EXPIRAÇÃO] Erro ao processar pedido ${pedido.channel_id}:`,
                error
            );
        }
    }
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


function formatarMoedaCentavos(
    centavos
) {

    return (
        Number(
            centavos || 0
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
}


function obterResumoVendas(
    whereSql = "",
    parametros = []
) {

    return db.prepare(`
        SELECT
            COUNT(*) AS pedidos,
            COALESCE(
                SUM(valor_centavos),
                0
            ) AS faturamento_centavos,
            COALESCE(
                SUM(quantidade_robux),
                0
            ) AS robux_vendidos,
            COUNT(
                DISTINCT discord_id
            ) AS clientes_unicos,
            COALESCE(
                SUM(desconto_centavos),
                0
            ) AS descontos_centavos,
            COALESCE(
                SUM(
                    CASE
                        WHEN entregue = 1
                        THEN 1
                        ELSE 0
                    END
                ),
                0
            ) AS entregues
        FROM compras
        ${whereSql}
    `).get(
        ...parametros
    );
}


function montarLinhaResumoVendas(
    titulo,
    resumo
) {

    const pedidos =
        Number(
            resumo?.pedidos ||
            0
        );

    const faturamento =
        formatarMoedaCentavos(
            resumo?.faturamento_centavos
        );

    const robux =
        formatarRobux(
            resumo?.robux_vendidos
        );

    return (
        `### ${titulo}\n` +
        `> <:pix:1548090281402966107> **Faturamento:** ${faturamento}\n` +
        `> <:greenrbx:1548088739677470881> **Robux vendidos:** ${robux} Robux\n` +
        `> <:greencart:1548089836647485591> **Pedidos:** ${pedidos}`
    );
}


async function atualizarPainelVendas(
    guild
) {

    const canalVendasId =
        process.env.CANAL_VENDAS_ID;

    if (!canalVendasId) {

        return {
            atualizado:
                false,
            motivo:
                "CANAL_VENDAS_ID não configurado."
        };
    }

    try {

        const canal =
            await guild.channels.fetch(
                canalVendasId
            );

        if (
            !canal ||
            !canal.isTextBased()
        ) {
            throw new Error(
                "CANAL_VENDAS_ID não aponta para um canal de texto válido."
            );
        }

        // O banco usa UTC. O ajuste -3/+3 deixa "Hoje"
        // alinhado ao horário de Brasília.
        const hoje =
            obterResumoVendas(
                "WHERE criado_em >= datetime('now', '-3 hours', 'start of day', '+3 hours')"
            );

        const seteDias =
            obterResumoVendas(
                "WHERE criado_em >= datetime('now', '-7 days')"
            );

        const trintaDias =
            obterResumoVendas(
                "WHERE criado_em >= datetime('now', '-30 days')"
            );

        const total =
            obterResumoVendas();

        const pedidosTotal =
            Number(
                total?.pedidos ||
                0
            );

        const entreguesTotal =
            Number(
                total?.entregues ||
                0
            );

        const aguardandoEntrega =
            Math.max(
                0,
                pedidosTotal -
                entreguesTotal
            );

        const ticketMedioCentavos =
            pedidosTotal > 0
                ? Math.round(
                    Number(
                        total.faturamento_centavos ||
                        0
                    ) /
                    pedidosTotal
                )
                : 0;

        const maiorCliente =
            db.prepare(`
                SELECT
                    discord_id,
                    SUM(
                        valor_centavos
                    ) AS total_centavos,
                    COUNT(*) AS compras
                FROM compras
                GROUP BY
                    discord_id
                ORDER BY
                    total_centavos DESC
                LIMIT 1
            `).get();

        const cupomMaisUsado =
            db.prepare(`
                SELECT
                    cupom_codigo AS codigo,
                    COUNT(*) AS usos,
                    SUM(
                        desconto_centavos
                    ) AS desconto_centavos
                FROM compras
                WHERE
                    cupom_codigo IS NOT NULL
                    AND TRIM(
                        cupom_codigo
                    ) <> ''
                GROUP BY
                    cupom_codigo
                ORDER BY
                    usos DESC,
                    desconto_centavos DESC
                LIMIT 1
            `).get();

        const maiorVenda =
            db.prepare(`
                SELECT
                    discord_id,
                    valor_centavos,
                    quantidade_robux,
                    produto
                FROM compras
                ORDER BY
                    valor_centavos DESC
                LIMIT 1
            `).get();

        const embed =
            new EmbedBuilder()
                .setColor(
                    "#00db0f"
                )
                .setTitle(
                    "<:greencart:1548089836647485591> Painel de vendas — RZ Store"
                )
                .setDescription(
                    montarLinhaResumoVendas(
                        "Hoje",
                        hoje
                    ) +
                    "\n\n\n" +
                    montarLinhaResumoVendas(
                        "Últimos 7 dias",
                        seteDias
                    ) +
                    "\n\n\n" +
                    montarLinhaResumoVendas(
                        "Últimos 30 dias",
                        trintaDias
                    ) +
                    "\n\n\n" +
                    montarLinhaResumoVendas(
                        "Desde o início",
                        total
                    )
                )
                .addFields(
                    {
                        name:
                            "<:cliente:1548196941102317568> Clientes",
                        value:
                            `> **Clientes únicos:** ${Number(total?.clientes_unicos || 0)}\n` +
                            `> **Ticket médio:** ${formatarMoedaCentavos(ticketMedioCentavos)}`,
                        inline:
                            false
                    },
                    {
                        name:
                            "<a:greenverification:1548192162653536336> Entregas",
                        value:
                            `> **Entregues:** ${entreguesTotal}\n` +
                            `> **Aguardando entrega:** ${aguardandoEntrega}`,
                        inline:
                            false
                    },
                    {
                        name:
                            "<:cupom:1548097312046186559> Descontos",
                        value:
                            `> **Concedidos:** ${formatarMoedaCentavos(total?.descontos_centavos)}\n` +
                            (
                                cupomMaisUsado
                                    ? `> **Cupom mais usado:** ${cupomMaisUsado.codigo} — ${Number(cupomMaisUsado.usos)} usos`
                                    : "> **Cupom mais usado:** —"
                            ),
                        inline:
                            false
                    }
                );

        if (maiorVenda) {

            const descricaoMaiorVenda =
                maiorVenda.produto
                    ? maiorVenda.produto
                    : `${formatarRobux(maiorVenda.quantidade_robux)} Robux`;

            embed.addFields({
                name:
                    "<:esmeralda:1548188465508909118> Maior venda",
                value:
                    `> **Pedido:** ${descricaoMaiorVenda}\n` +
                    `> **Valor:** ${formatarMoedaCentavos(maiorVenda.valor_centavos)}\n` +
                    `> **Cliente:** <@${maiorVenda.discord_id}>`,
                inline:
                    false
            });
        }

        if (maiorCliente) {

            embed.addFields({
                name:
                    "<:cliente:1548196941102317568> Maior cliente",
                value:
                    `> **Cliente:** <@${maiorCliente.discord_id}>\n` +
                    `> **Total gasto:** ${formatarMoedaCentavos(maiorCliente.total_centavos)}\n` +
                    `> **Compras:** ${Number(maiorCliente.compras)}`,
                inline:
                    false
            });
        }

        embed
            .setFooter({
                text:
                    MERCADO_PAGO_TEST_MODE
                        ? "RZ Store • Painel de vendas • BANCO DE TESTE"
                        : "RZ Store • Painel de vendas • Atualização automática"
            })
            .setTimestamp();

        const config =
            db.prepare(`
                SELECT valor
                FROM configuracoes
                WHERE chave =
                    'painel_vendas_message_id'
            `).get();

        let mensagem = null;

        if (
            config?.valor
        ) {

            try {

                mensagem =
                    await canal.messages.fetch(
                        config.valor
                    );

            } catch {

                mensagem =
                    null;
            }
        }

        if (mensagem) {

            await mensagem.edit({
                embeds: [
                    embed
                ],
                allowedMentions: {
                    parse: []
                }
            });

            return {
                atualizado:
                    true,
                criado:
                    false,
                mensagem,
                canal
            };
        }

        const novaMensagem =
            await canal.send({
                embeds: [
                    embed
                ],
                allowedMentions: {
                    parse: []
                }
            });

        db.prepare(`
            INSERT INTO configuracoes (
                chave,
                valor
            )
            VALUES (
                'painel_vendas_message_id',
                ?
            )

            ON CONFLICT(chave)
            DO UPDATE SET
                valor =
                    excluded.valor
        `).run(
            novaMensagem.id
        );

        return {
            atualizado:
                true,
            criado:
                true,
            mensagem:
                novaMensagem,
            canal
        };

    } catch (error) {

        console.error(
            "[VENDAS] Erro ao atualizar painel:",
            error
        );

        return {
            atualizado:
                false,
            erro:
                error
        };
    }
}


async function atualizarPainelEstoque(
    guild,
    {
        mencionarEveryone = false
    } = {}
) {

    const canalPublicoId =
        process.env.CANAL_ESTOQUE_PUBLICO_ID;

    if (!canalPublicoId) {
        return {
            atualizado: false,
            motivo:
                "CANAL_ESTOQUE_PUBLICO_ID não configurado."
        };
    }

    try {

        const canalPublico =
            await guild.channels.fetch(
                canalPublicoId
            );

        if (
            !canalPublico ||
            !canalPublico.isTextBased()
        ) {
            throw new Error(
                "O canal de estoque configurado não é um canal de texto válido."
            );
        }

        const estoqueTotal =
            obterQuantidadeEstoque();

        const pedidosEmAberto =
            obterRobuxPedidosEmAberto();

        const estoqueDisponivel =
            Math.max(
                0,
                estoqueTotal -
                pedidosEmAberto
            );

        const limiteMaximoPedido =
            obterLimiteMaximoPedido();

        const caminhoBanner =
            path.join(
                __dirname,
                "assets",
                "estoque",
                "estoque.png"
            );

        const embed =
            new EmbedBuilder()
                .setColor(
                    "#00db0f"
                )
                .setTitle(
                    "<:greenrbx:1548088739677470881> Estoque disponível — RZ Store"
                )
                .setDescription(
                    "Acompanhe abaixo o estoque de Robux da **RZ Store em tempo real**.\n\n" +
                    `> <:greenrbx:1548088739677470881> **Estoque total:** ${formatarRobux(estoqueTotal)} Robux\n` +
                    `> <:ampulheta:1549129208557469786> **Pedidos em aberto:** ${formatarRobux(pedidosEmAberto)} Robux\n` +
                    `> <a:greenverification:1548192162653536336> **Disponível agora:** ${formatarRobux(estoqueDisponivel)} Robux\n` +
                    `> <:greencart:1548089836647485591> **Máximo por pedido:** ${formatarRobux(limiteMaximoPedido)} Robux\n\n` +
                    "<a:greensparkles:1548099963051843695> Cada pedido pode utilizar no máximo **50% do estoque disponível**. Este painel é atualizado automaticamente conforme novas compras, pagamentos e alterações no estoque."
                )
                .setImage(
                    "attachment://estoque.png"
                )
                .setFooter({
                    text:
                        "RZ Store • Estoque em tempo real"
                })
                .setTimestamp();

        const config =
            db.prepare(`
                SELECT valor
                FROM configuracoes
                WHERE chave =
                    'painel_estoque_message_id'
            `).get();

        let mensagem = null;

        if (
            config?.valor
        ) {

            try {

                mensagem =
                    await canalPublico.messages.fetch(
                        config.valor
                    );

            } catch {

                mensagem =
                    null;
            }
        }

        if (mensagem) {

            await mensagem.edit({
                content:
                    mensagem.content ||
                    "",
                embeds: [
                    embed
                ]
            });

            return {
                atualizado: true,
                criado: false,
                mensagem,
                canal:
                    canalPublico,
                estoqueTotal,
                pedidosEmAberto,
                estoqueDisponivel
            };
        }

        const novaMensagem =
            await canalPublico.send({
                content:
                    mencionarEveryone
                        ? "@everyone"
                        : undefined,
                embeds: [
                    embed
                ],
                files: [
                    {
                        attachment:
                            caminhoBanner,
                        name:
                            "estoque.png"
                    }
                ],
                allowedMentions:
                    mencionarEveryone
                        ? {
                            parse: [
                                "everyone"
                            ]
                        }
                        : {
                            parse: []
                        }
            });

        db.prepare(`
            INSERT INTO configuracoes (
                chave,
                valor
            )
            VALUES (
                'painel_estoque_message_id',
                ?
            )

            ON CONFLICT(chave)
            DO UPDATE SET
                valor =
                    excluded.valor
        `).run(
            novaMensagem.id
        );

        return {
            atualizado: true,
            criado: true,
            mensagem:
                novaMensagem,
            canal:
                canalPublico,
            estoqueTotal,
            pedidosEmAberto,
            estoqueDisponivel
        };

    } catch (error) {

        console.error(
            "[ESTOQUE] Erro ao atualizar painel público:",
            error
        );

        return {
            atualizado: false,
            erro:
                error
        };
    }
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

            const pedidosEmAberto =
                obterRobuxPedidosEmAberto();

            const disponivel =
                Math.max(
                    0,
                    estoqueAntes -
                    pedidosEmAberto
                );

            if (
                quantidade >
                disponivel
            ) {
                throw new Error(
                    `Não é possível remover essa quantidade. Há ${formatarRobux(pedidosEmAberto)} Robux em pedidos em aberto e apenas ${formatarRobux(disponivel)} Robux disponíveis.`
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

        const pedidosEmAberto =
            obterRobuxPedidosEmAberto();

        if (
            quantidade <
            pedidosEmAberto
        ) {
            throw new Error(
                `Não é possível definir o estoque para ${formatarRobux(quantidade)} Robux porque existem ${formatarRobux(pedidosEmAberto)} Robux em pedidos em aberto.`
            );
        }

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
    produto,
    valorOriginalCentavos = null,
    descontoCentavos = 0,
    cupomCodigo = null,
    ticketChannelId = null
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

    const valorOriginal =
        Number.isInteger(
            Number(
                valorOriginalCentavos
            )
        )
            ? Number(
                valorOriginalCentavos
            )
            : valorCentavos;

    const desconto =
        Number.isInteger(
            Number(
                descontoCentavos
            )
        )
            ? Math.max(
                0,
                Number(
                    descontoCentavos
                )
            )
            : 0;

    const codigoCupom =
        cupomCodigo
            ? normalizarCodigoCupom(
                cupomCodigo
            )
            : null;

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

        const pedidosOutros =
            obterRobuxPedidosEmAberto(
                ticketChannelId
            );

        const disponivelParaEstePedido =
            Math.max(
                0,
                estoqueAntes -
                pedidosOutros
            );

        if (
            disponivelParaEstePedido <
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

        if (ticketChannelId) {

            db.prepare(`
                UPDATE pedidos_abertos
                SET
                    status = 'pago',
                    order_id = ?,
                    encerrado_em =
                        CURRENT_TIMESTAMP
                WHERE
                    channel_id = ?
                    AND status = 'aberto'
            `).run(
                orderId,
                ticketChannelId
            );
        }

        db.prepare(`
            INSERT INTO compras (
                order_id,
                payment_id,
                discord_id,
                valor_centavos,
                valor_original_centavos,
                desconto_centavos,
                cupom_codigo,
                quantidade_robux,
                produto
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            orderId,
            paymentId || null,
            discordId,
            valorCentavos,
            valorOriginal,
            desconto,
            codigoCupom,
            quantidade,
            produto || null
        );

        if (codigoCupom) {

            const uso =
                db.prepare(`
                    INSERT OR IGNORE INTO cupom_usos (
                        codigo,
                        discord_id,
                        order_id,
                        desconto_centavos
                    )
                    VALUES (?, ?, ?, ?)
                `).run(
                    codigoCupom,
                    discordId,
                    orderId,
                    desconto
                );

            if (
                Number(
                    uso.changes
                ) > 0
            ) {
                db.prepare(`
                    UPDATE cupons
                    SET usos =
                        usos + 1
                    WHERE codigo = ?
                `).run(
                    codigoCupom
                );
            }
        }

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


async function encontrarMensagemPrincipalPedido(
    ticket
) {

    const mensagemId =
        ticket.topic
            ?.match(
                /ticket-msg:(\d+)/
            )?.[1];

    if (mensagemId) {

        try {

            return await ticket.messages.fetch(
                mensagemId
            );

        } catch {}
    }

    // Compatibilidade com tickets criados antes de começarmos
    // a salvar o ID da primeira mensagem no tópico.
    try {

        const mensagens =
            await ticket.messages.fetch({
                limit: 100
            });

        return (
            mensagens.find(
                mensagem =>
                    mensagem.author?.id ===
                        client.user.id &&
                    mensagem.embeds?.[0]
                        ?.title
                        ?.includes(
                            "Novo pedido — RZ Store"
                        )
            ) ||
            null
        );

    } catch (error) {

        console.warn(
            `[PAGAMENTO] Não consegui procurar a mensagem principal do ticket ${ticket.id}:`,
            error?.message ||
            error
        );

        return null;
    }
}


async function atualizarMensagemPrincipalPedidoPago(
    ticket
) {

    const mensagem =
        await encontrarMensagemPrincipalPedido(
            ticket
        );

    if (!mensagem) {

        console.warn(
            `[PAGAMENTO] Mensagem principal do ticket ${ticket.id} não encontrada.`
        );

        return false;
    }

    try {

        const embedOriginal =
            mensagem.embeds?.[0];

        if (!embedOriginal) {
            return false;
        }

        const dadosEmbed =
            embedOriginal.toJSON();

        dadosEmbed.title =
            "<:okk:1549125132906270851> Pedido pago — RZ Store";

        const descricaoOriginal =
            dadosEmbed.description ||
            "";

        const blocoStatusPendente =
            /### <:ampulheta:1549129208557469786> Status\n> Aguardando pagamento\.\n> \*\*Prazo para pagar:\*\* <t:\d+:R>\n\nClique no botão \*\*Gerar PIX\*\* abaixo para criar sua cobrança\./;

        const blocoStatusPago =
            "### <a:greenverification:1548192162653536336> Status\n" +
            "> **Pagamento confirmado.**\n\n" +
            "Aguarde a equipe da RZ Store realizar a entrega.";

        if (
            blocoStatusPendente.test(
                descricaoOriginal
            )
        ) {

            dadosEmbed.description =
                descricaoOriginal.replace(
                    blocoStatusPendente,
                    blocoStatusPago
                );

        } else {

            // Fallback para qualquer pequena variação no texto.
            dadosEmbed.description =
                descricaoOriginal
                    .replace(
                        /### <:ampulheta:1549129208557469786> Status[\s\S]*$/,
                        blocoStatusPago
                    );
        }

        dadosEmbed.timestamp =
            new Date().toISOString();

        const componentes =
            mensagem.components.map(
                row => {

                    const novaLinha =
                        ActionRowBuilder.from(
                            row
                        );

                    const novosComponentes =
                        row.components.map(
                            component => {

                                if (
                                    component.type === 2 &&
                                    component.customId
                                        ?.startsWith(
                                            "gerar_pix_"
                                        )
                                ) {

                                    return ButtonBuilder
                                        .from(
                                            component
                                        )
                                        .setLabel(
                                            "Pagamento confirmado"
                                        )
                                        .setEmoji({
                                            id:
                                                "1548192162653536336",
                                            name:
                                                "greenverification",
                                            animated:
                                                true
                                        })
                                        .setStyle(
                                            ButtonStyle.Success
                                        )
                                        .setDisabled(
                                            true
                                        );
                                }

                                return ButtonBuilder.from(
                                    component
                                );
                            }
                        );

                    novaLinha.setComponents(
                        novosComponentes
                    );

                    return novaLinha;
                }
            );

        await mensagem.edit({
            embeds: [
                new EmbedBuilder(
                    dadosEmbed
                )
            ],
            components:
                componentes
        });

        console.log(
            `[PAGAMENTO] Mensagem principal do ticket ${ticket.id} atualizada para pago.`
        );

        return true;

    } catch (error) {

        console.error(
            `[PAGAMENTO] Erro ao atualizar mensagem principal do ticket ${ticket.id}:`,
            error
        );

        return false;
    }
}


async function sincronizarMensagensPedidosPagos(
    guild
) {

    try {

        const canais =
            await guild.channels.fetch();

        const ticketsPagos =
            canais.filter(
                channel =>
                    channel &&
                    channel.type ===
                        ChannelType.GuildText &&
                    channel.parentId ===
                        process.env.CATEGORY_TICKETS_ID &&
                    channel.topic?.includes(
                        "mp-status:accredited"
                    )
            );

        for (
            const ticket
            of ticketsPagos.values()
        ) {

            limparTimerExpiracaoPedido(
                ticket.id
            );

            await atualizarMensagemPrincipalPedidoPago(
                ticket
            );
        }

        if (
            ticketsPagos.size >
            0
        ) {

            console.log(
                `[PAGAMENTO] ${ticketsPagos.size} ticket(s) pago(s) sincronizado(s) no startup.`
            );
        }

    } catch (error) {

        console.error(
            "[PAGAMENTO] Erro ao sincronizar mensagens de pedidos pagos:",
            error
        );
    }
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

            limparTimerExpiracaoPedido(
                ticket.id
            );

            await atualizarMensagemPrincipalPedidoPago(
                ticket
            );

            console.log(
                `[WEBHOOK] Order ${orderId} já tinha sido confirmada no Discord. Status visual sincronizado.`
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

        const cupomCodigo =
            ticket.topic
                ?.match(
                    /cupom:([^|]+)/
                )?.[1]
                ?.trim() ||
            null;

        const valorOriginalCentavos =
            Number(
                ticket.topic
                    ?.match(
                        /valor-original-centavos:(\d+)/
                    )?.[1]
            );

        const descontoCentavos =
            Number(
                ticket.topic
                    ?.match(
                        /desconto-centavos:(\d+)/
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
                produto,
                valorOriginalCentavos:
                    Number.isInteger(
                        valorOriginalCentavos
                    )
                        ? valorOriginalCentavos
                        : valorCentavosPedido,
                descontoCentavos:
                    Number.isInteger(
                        descontoCentavos
                    )
                        ? descontoCentavos
                        : 0,
                cupomCodigo,
                ticketChannelId:
                    ticket.id
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

        limparTimerExpiracaoPedido(
            ticket.id
        );

        await atualizarMensagemPrincipalPedidoPago(
            ticket
        );

        await atualizarPainelEstoque(
            guild
        );

        await atualizarPainelVendas(
            guild
        );

        if (cupomCodigo) {
            await atualizarPainelCupons(
                guild
            );
        }

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
                        cupomCodigo
                            ? `> <:cupom:1548097312046186559> **Cupom:** \`${cupomCodigo}\`\n`
                            : ""
                    ) +
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
    console.log(
        `[EXPIRAÇÃO] Prazo configurado: ${obterPrazoExpiracaoPedidoMinutos()} minuto(s).`
    );

    try {

        const guildEstoque =
            await client.guilds.fetch(
                process.env.GUILD_ID
            );

        await reconciliarPedidosEmAberto(
            guildEstoque
        );

        await atualizarPainelEstoque(
            guildEstoque
        );

        await processarPedidosExpirados(
            guildEstoque
        );

        await agendarTodosPedidosEmAberto(
            guildEstoque
        );

        await sincronizarMensagensPedidosPagos(
            guildEstoque
        );

        if (
            process.env.CANAL_VENDAS_ID
        ) {

            await atualizarPainelVendas(
                guildEstoque
            );
        }

        setInterval(
            async () => {

                await atualizarPainelEstoque(
                    guildEstoque
                );

            },
            10 * 60 * 1000
        );

        setInterval(
            async () => {

                if (
                    process.env.CANAL_VENDAS_ID
                ) {

                    await atualizarPainelVendas(
                        guildEstoque
                    );
                }

            },
            5 * 60 * 1000
        );

        setInterval(
            async () => {

                await processarPedidosExpirados(
                    guildEstoque
                );

            },
            30 * 1000
        );

    } catch (error) {

        console.error(
            "[ESTOQUE] Não foi possível reconciliar pedidos em aberto:",
            error
        );
    }

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
            .setDescription("Publica o estoque atual no canal público"),

        new SlashCommandBuilder()
            .setName("vendas")
            .setDescription("Cria ou atualiza o painel fixo de vendas"),

        new SlashCommandBuilder()
            .setName("criarcupom")
            .setDescription("Cria um novo cupom de desconto")
            .addStringOption(option =>
                option
                    .setName("codigo")
                    .setDescription("Código do cupom, ex: RZ10")
                    .setRequired(true)
                    .setMinLength(2)
                    .setMaxLength(20)
            )
            .addIntegerOption(option =>
                option
                    .setName("desconto")
                    .setDescription("Desconto percentual do cupom")
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(90)
            )
            .addIntegerOption(option =>
                option
                    .setName("validade_dias")
                    .setDescription("Por quantos dias o cupom ficará válido")
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(365)
            )
            .addIntegerOption(option =>
                option
                    .setName("usos")
                    .setDescription("Limite total de usos (0 = ilimitado)")
                    .setRequired(true)
                    .setMinValue(0)
                    .setMaxValue(100000)
            )
            .addIntegerOption(option =>
                option
                    .setName("por_pessoa")
                    .setDescription("Limite de usos por pessoa (0 = ilimitado)")
                    .setRequired(false)
                    .setMinValue(0)
                    .setMaxValue(1000)
            )
            .addIntegerOption(option =>
                option
                    .setName("maximo_robux")
                    .setDescription("Maior pedido permitido em Robux (0 = sem limite)")
                    .setRequired(false)
                    .setMinValue(0)
                    .setMaxValue(10000000)
            )
            .addBooleanOption(option =>
                option
                    .setName("somente_boosters")
                    .setDescription("Permitir o cupom somente para boosters")
                    .setRequired(false)
            ),

        new SlashCommandBuilder()
            .setName("removercupom")
            .setDescription("Desativa um cupom de desconto")
            .addStringOption(option =>
                option
                    .setName("codigo")
                    .setDescription("Código do cupom")
                    .setRequired(true)
                    .setMinLength(2)
                    .setMaxLength(20)
            ),

        new SlashCommandBuilder()
            .setName("cupons")
            .setDescription("Mostra os cupons ativos da RZ Store")
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

        console.log("Comandos da RZ Store registrados, incluindo estoque e cupons.");

    } catch (error) {

        console.error(error);

    }

    try {

        const guildCupons =
            await client.guilds.fetch(
                process.env.GUILD_ID
            );

        await atualizarPainelCupons(
            guildCupons
        );

        setInterval(
            async () => {
                await atualizarPainelCupons(
                    guildCupons
                );
            },
            10 * 60 * 1000
        );

    } catch (error) {

        console.error(
            "[CUPONS] Não foi possível iniciar o painel automático:",
            error
        );
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

    db.prepare(`
        UPDATE pedidos_abertos
        SET order_id = ?
        WHERE
            channel_id = ?
            AND status = 'aberto'
    `).run(
        order.id,
        interaction.channel.id
    );

    await interaction.editReply({
        content:
            "<:okk:1549125132906270851> PIX gerado com sucesso. Confira a cobrança acima."
    });
}


client.on(Events.ChannelDelete, async channel => {

    try {

        const pedidoFoiEncerrado =
            encerrarPedidoEmAberto(
                channel.id,
                "cancelado"
            );

        limparTimerExpiracaoPedido(
            channel.id
        );

        if (
            pedidoFoiEncerrado &&
            channel.guild
        ) {

            await atualizarPainelEstoque(
                channel.guild
            );
        }

    } catch (error) {

        console.error(
            "[ESTOQUE] Erro ao liberar pedido após exclusão do canal:",
            error
        );
    }
});


client.on(Events.InteractionCreate, async interaction => {

    // =========================================
    // COMANDOS DE CUPOM
    // =========================================

    if (
        interaction.isChatInputCommand() &&
        [
            "criarcupom",
            "removercupom",
            "cupons"
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
            "cupons"
        ) {

            const embed =
                new EmbedBuilder()
                    .setColor(
                        "#00db0f"
                    )
                    .setTitle(
                        "<:cupom:1548097312046186559> Cupons ativos"
                    )
                    .setDescription(
                        formatarListaCupons(
                            listarCuponsAtivos()
                        )
                    )
                    .setFooter({
                        text:
                            "RZ Store • Gerenciamento de cupons"
                    })
                    .setTimestamp();

            await interaction.reply({
                embeds: [
                    embed
                ],
                flags:
                    MessageFlags.Ephemeral
            });

            return;
        }

        if (
            interaction.commandName ===
            "criarcupom"
        ) {

            const codigo =
                normalizarCodigoCupom(
                    interaction.options.getString(
                        "codigo",
                        true
                    )
                );

            const desconto =
                interaction.options.getInteger(
                    "desconto",
                    true
                );

            const validadeDias =
                interaction.options.getInteger(
                    "validade_dias",
                    true
                );

            const limiteUsos =
                interaction.options.getInteger(
                    "usos",
                    true
                );

            const limitePorPessoa =
                interaction.options.getInteger(
                    "por_pessoa",
                    false
                ) ?? 0;

            const maximoRobux =
                interaction.options.getInteger(
                    "maximo_robux",
                    false
                ) ?? 0;

            const somenteBoosters =
                interaction.options.getBoolean(
                    "somente_boosters",
                    false
                ) ?? false;

            if (
                !/^[A-Z0-9_-]{2,20}$/.test(
                    codigo
                )
            ) {

                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> O código pode conter apenas letras, números, `_` e `-`.",
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            if (
                obterCupom(
                    codigo
                )
            ) {

                await interaction.reply({
                    content:
                        `<:danger:1549129849904566392> Já existe um cupom com o código \`${codigo}\`.`,
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            const validade =
                new Date(
                    Date.now() +
                    validadeDias *
                    24 *
                    60 *
                    60 *
                    1000
                );

            db.prepare(`
                INSERT INTO cupons (
                    codigo,
                    desconto_percentual,
                    validade_em,
                    limite_usos,
                    usos,
                    limite_por_pessoa,
                    maximo_robux,
                    somente_boosters,
                    ativo,
                    criado_por
                )
                VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1, ?)
            `).run(
                codigo,
                desconto,
                validade.toISOString(),
                limiteUsos,
                limitePorPessoa,
                maximoRobux,
                somenteBoosters
                    ? 1
                    : 0,
                interaction.user.id
            );

            await atualizarPainelCupons(
                interaction.guild
            );

            const validadeUnix =
                Math.floor(
                    validade.getTime() /
                    1000
                );

            await interaction.reply({
                content:
                    `<:okk:1549125132906270851> Cupom \`${codigo}\` criado com **${desconto}% OFF**.\n` +
                    `<:ampulheta:1549129208557469786> Validade: <t:${validadeUnix}:F>\n` +
                    (
                        limiteUsos === 0
                            ? "<:danger:1549129849904566392> Usos totais ilimitados.\n"
                            : `<:danger:1549129849904566392> Limite total: **${limiteUsos} usos**.\n`
                    ) +
                    (
                        limitePorPessoa === 0
                            ? "<:cliente:1548196941102317568> Sem limite por pessoa.\n"
                            : `<:cliente:1548196941102317568> Limite por pessoa: **${limitePorPessoa} uso(s)**.\n`
                    ) +
                    (
                        maximoRobux === 0
                            ? "<:greencart:1548089836647485591> Sem limite máximo de Robux por pedido.\n"
                            : `<:greencart:1548089836647485591> Pedido máximo: **${formatarRobux(maximoRobux)} Robux**.\n`
                    ) +
                    (
                        somenteBoosters
                            ? "<:esmeralda:1548188465508909118> **Exclusivo para boosters.**"
                            : "<:esmeralda:1548188465508909118> Disponível para todos os clientes."
                    ),
                flags:
                    MessageFlags.Ephemeral
            });

            return;
        }

        if (
            interaction.commandName ===
            "removercupom"
        ) {

            const codigo =
                normalizarCodigoCupom(
                    interaction.options.getString(
                        "codigo",
                        true
                    )
                );

            const resultado =
                db.prepare(`
                    UPDATE cupons
                    SET ativo = 0
                    WHERE
                        codigo = ?
                        AND ativo = 1
                `).run(
                    codigo
                );

            if (
                Number(
                    resultado.changes
                ) === 0
            ) {

                await interaction.reply({
                    content:
                        `<:interrogacoes:1548096277856649296> Não encontrei um cupom ativo com o código \`${codigo}\`.`,
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            await atualizarPainelCupons(
                interaction.guild
            );

            await interaction.reply({
                content:
                    `<:okk:1549125132906270851> Cupom \`${codigo}\` desativado com sucesso.`,
                flags:
                    MessageFlags.Ephemeral
            });

            return;
        }
    }

    // =========================================
    // PAINEL FIXO DE VENDAS
    // =========================================

    if (
        interaction.isChatInputCommand() &&
        interaction.commandName ===
            "vendas"
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
            !process.env.CANAL_VENDAS_ID
        ) {

            await interaction.reply({
                content:
                    "<:x_:1549124126575165533> Configure `CANAL_VENDAS_ID` no `.env` primeiro.",
                flags:
                    MessageFlags.Ephemeral
            });

            return;
        }

        await interaction.deferReply({
            flags:
                MessageFlags.Ephemeral
        });

        const resultado =
            await atualizarPainelVendas(
                interaction.guild
            );

        if (
            !resultado.atualizado
        ) {

            await interaction.editReply({
                content:
                    `<:x_:1549124126575165533> Não consegui atualizar o painel de vendas${resultado.erro?.message ? `: ${resultado.erro.message}` : "."}`
            });

            return;
        }

        await interaction.editReply({
            content:
                resultado.criado
                    ? `<:okk:1549125132906270851> Painel de vendas criado em ${resultado.canal}. A partir de agora ele será atualizado automaticamente.`
                    : `<:okk:1549125132906270851> Painel de vendas atualizado em ${resultado.canal}.`
        });

        return;
    }


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

            const pedidosEmAberto =
                obterRobuxPedidosEmAberto();

            const estoqueDisponivel =
                Math.max(
                    0,
                    estoqueAtual -
                    pedidosEmAberto
                );

            const limiteMaximoPedido =
                obterLimiteMaximoPedido();

            const embedEstoque =
                new EmbedBuilder()
                    .setColor(
                        "#00db0f"
                    )
                    .setTitle(
                        "<:greenrbx:1548088739677470881> Estoque da RZ Store"
                    )
                    .setDescription(
                        `> <:greenrbx:1548088739677470881> **Estoque total:** ${formatarRobux(estoqueAtual)} Robux\n` +
                        `> <:ampulheta:1549129208557469786> **Pedidos em aberto:** ${formatarRobux(pedidosEmAberto)} Robux\n` +
                        `> <a:greenverification:1548192162653536336> **Disponível:** ${formatarRobux(estoqueDisponivel)} Robux\n` +
                        `> <:greencart:1548089836647485591> **Máximo por pedido:** ${formatarRobux(limiteMaximoPedido)} Robux`
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

            await interaction.deferReply({
                flags:
                    MessageFlags.Ephemeral
            });

            const resultado =
                await atualizarPainelEstoque(
                    interaction.guild,
                    {
                        mencionarEveryone:
                            true
                    }
                );

            if (
                !resultado.atualizado
            ) {

                await interaction.editReply({
                    content:
                        `<:x_:1549124126575165533> Não consegui publicar o painel de estoque${resultado.erro?.message ? `: ${resultado.erro.message}` : "."}`
                });

                return;
            }

            await interaction.editReply({
                content:
                    resultado.criado
                        ? `<:okk:1549125132906270851> Painel de estoque criado em ${resultado.canal} e o **@everyone** foi marcado. A partir de agora ele será atualizado automaticamente.`
                        : `<:okk:1549125132906270851> O painel de estoque em ${resultado.canal} já existia e foi atualizado. As próximas alterações também serão automáticas.`
            });

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

                await atualizarPainelEstoque(
                    interaction.guild
                );

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

            await atualizarPainelEstoque(
                interaction.guild
            );

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
                    .setCustomId(`usar_cupom_robux_${quantidade}`)
                    .setLabel("Usar cupom")
                    .setEmoji({
                        id: "1548097312046186559",
                        name: "cupom"
                    })
                    .setStyle(ButtonStyle.Secondary),

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
                    .setCustomId(`usar_cupom_item_${opcao}`)
                    .setLabel("Usar cupom")
                    .setEmoji({
                        id: "1548097312046186559",
                        name: "cupom"
                    })
                    .setStyle(ButtonStyle.Secondary),

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
                    .setCustomId(`usar_cupom_robux_${quantidade}`)
                    .setLabel("Usar cupom")
                    .setEmoji({
                        id: "1548097312046186559",
                        name: "cupom"
                    })
                    .setStyle(ButtonStyle.Secondary),

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

        const pedidoAberto =
            obterPedidoAbertoPorCanal(
                interaction.channel.id
            );

        if (
            pedidoAberto &&
            pedidoAbertoExpirou(
                pedidoAberto
            )
        ) {
            await interaction.reply({
                content:
                    "<:ampulheta:1549129208557469786> O prazo deste pedido terminou. O ticket está sendo encerrado.",
                flags:
                    MessageFlags.Ephemeral
            });

            setImmediate(
                () =>
                    processarExpiracaoPedido(
                        interaction.guild,
                        pedidoAberto
                    )
            );

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
    // MODAL DO CUPOM
    // =========================================

    if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
            "modal_cupom_"
        )
    ) {

        const dados =
            interaction.customId.replace(
                "modal_cupom_",
                ""
            );

        const separador =
            dados.indexOf(
                "_"
            );

        const tipoCompra =
            dados.slice(
                0,
                separador
            );

        const referencia =
            dados.slice(
                separador + 1
            );

        const codigo =
            normalizarCodigoCupom(
                interaction.fields.getTextInputValue(
                    "codigo_cupom"
                )
            );

        const quantidadeParaValidar =
            tipoCompra === "robux"
                ? Number(
                    referencia
                )
                : (
                    referencia === "korblox"
                        ? 17000
                        : (
                            referencia === "headless"
                                ? 31000
                                : 0
                        )
                );

        const ehBooster =
            Boolean(
                interaction.member
                    ?.premiumSinceTimestamp ||
                interaction.member
                    ?.premiumSince
            );

        const validacao =
            validarCupom(
                codigo,
                {
                    discordId:
                        interaction.user.id,
                    quantidadeRobux:
                        quantidadeParaValidar,
                    isBooster:
                        ehBooster
                }
            );

        if (
            !validacao.valido
        ) {

            await interaction.reply({
                content:
                    `<:x_:1549124126575165533> ${validacao.motivo}`,
                flags:
                    MessageFlags.Ephemeral
            });

            return;
        }

        let valorOriginalCentavos;
        let titulo;
        let detalhes;
        let customIdConfirmar;

        if (
            tipoCompra ===
            "robux"
        ) {

            const quantidade =
                Number(
                    referencia
                );

            if (
                !Number.isInteger(
                    quantidade
                ) ||
                quantidade < 100
            ) {

                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Quantidade de Robux inválida.",
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            valorOriginalCentavos =
                Math.round(
                    (
                        quantidade /
                        100
                    ) *
                    320
                );

            titulo =
                "<:greenrbx:1548088739677470881> Cupom aplicado";

            detalhes =
                `> **Quantidade:** ${formatarRobux(quantidade)} Robux`;

            customIdConfirmar =
                `confirmar_compra_cupom_${quantidade}_${codigo}`;

        } else {

            const produtos = {
                korblox: {
                    nome:
                        "Korblox",
                    robux:
                        17000,
                    valorCentavos:
                        54400
                },
                headless: {
                    nome:
                        "Headless",
                    robux:
                        31000,
                    valorCentavos:
                        99200
                }
            };

            const produto =
                produtos[
                    referencia
                ];

            if (!produto) {

                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Produto inválido.",
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            valorOriginalCentavos =
                produto.valorCentavos;

            titulo =
                `<:greencart:1548089836647485591> Cupom aplicado — ${produto.nome}`;

            detalhes =
                `> **Produto:** ${produto.nome}\n` +
                `> <:greenrbx:1548088739677470881> **Preço em Robux:** ${formatarRobux(produto.robux)}`;

            customIdConfirmar =
                `confirmar_item_cupom_${referencia}_${codigo}`;
        }

        const calculo =
            calcularDescontoCupom(
                valorOriginalCentavos,
                validacao.cupom
            );

        const originalFormatado =
            (
                valorOriginalCentavos /
                100
            ).toLocaleString(
                "pt-BR",
                {
                    style:
                        "currency",
                    currency:
                        "BRL"
                }
            );

        const descontoFormatado =
            (
                calculo.descontoCentavos /
                100
            ).toLocaleString(
                "pt-BR",
                {
                    style:
                        "currency",
                    currency:
                        "BRL"
                }
            );

        const finalFormatado =
            (
                calculo.valorFinalCentavos /
                100
            ).toLocaleString(
                "pt-BR",
                {
                    style:
                        "currency",
                    currency:
                        "BRL"
                }
            );

        const embed =
            new EmbedBuilder()
                .setColor(
                    "#00db0f"
                )
                .setTitle(
                    titulo
                )
                .setDescription(
                    `${detalhes}\n\n` +
                    `> <:cupom:1548097312046186559> **Cupom:** \`${codigo}\`\n` +
                    `> **Desconto:** ${validacao.cupom.desconto_percentual}% OFF\n` +
                    `> **Valor original:** ~~${originalFormatado}~~\n` +
                    `> **Economia:** ${descontoFormatado}\n` +
                    `> <:pix:1548090281402966107> **Valor final:** **${finalFormatado}**`
                )
                .setFooter({
                    text:
                        "RZ Store • Cupom aplicado"
                });

        const row =
            new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(
                            customIdConfirmar
                        )
                        .setLabel(
                            "Confirmar compra"
                        )
                        .setEmoji({
                            id:
                                "1549125132906270851",
                            name:
                                "okk"
                        })
                        .setStyle(
                            ButtonStyle.Success
                        ),

                    new ButtonBuilder()
                        .setCustomId(
                            "cancelar_compra"
                        )
                        .setLabel(
                            "Cancelar"
                        )
                        .setEmoji({
                            id:
                                "1549124126575165533",
                            name:
                                "x_"
                        })
                        .setStyle(
                            ButtonStyle.Danger
                        )
                );

        await interaction.reply({
            embeds: [
                embed
            ],
            components: [
                row
            ],
            flags:
                MessageFlags.Ephemeral
        });

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
        // USAR CUPOM
        // =========================================

        if (
            interaction.customId.startsWith(
                "usar_cupom_"
            )
        ) {

            const dados =
                interaction.customId.replace(
                    "usar_cupom_",
                    ""
                );

            const separador =
                dados.indexOf(
                    "_"
                );

            const tipoCompra =
                dados.slice(
                    0,
                    separador
                );

            const referencia =
                dados.slice(
                    separador + 1
                );

            if (
                ![
                    "robux",
                    "item"
                ].includes(
                    tipoCompra
                ) ||
                !referencia
            ) {

                await interaction.reply({
                    content:
                        "<:x_:1549124126575165533> Não consegui identificar esta compra.",
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            const modal =
                new ModalBuilder()
                    .setCustomId(
                        `modal_cupom_${tipoCompra}_${referencia}`
                    )
                    .setTitle(
                        "Aplicar cupom"
                    );

            const input =
                new TextInputBuilder()
                    .setCustomId(
                        "codigo_cupom"
                    )
                    .setLabel(
                        "Código do cupom"
                    )
                    .setPlaceholder(
                        "Exemplo: RZ10"
                    )
                    .setStyle(
                        TextInputStyle.Short
                    )
                    .setRequired(
                        true
                    )
                    .setMinLength(
                        2
                    )
                    .setMaxLength(
                        20
                    );

            modal.addComponents(
                new ActionRowBuilder()
                    .addComponents(
                        input
                    )
            );

            await interaction.showModal(
                modal
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

                await atualizarPainelVendas(
                    interaction.guild
                );

                const compra =
                    db.prepare(`
                        SELECT
                            order_id,
                            payment_id,
                            discord_id,
                            valor_centavos,
                            valor_original_centavos,
                            desconto_centavos,
                            cupom_codigo,
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
                                        (
                                            compra?.cupom_codigo
                                                ? `> <:cupom:1548097312046186559> **Cupom:** \`${compra.cupom_codigo}\`\n`
                                                : ""
                                        ) +
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

            const pedidoAberto =
                obterPedidoAbertoPorCanal(
                    interaction.channel.id
                );

            if (
                pedidoAberto &&
                pedidoAbertoExpirou(
                    pedidoAberto
                )
            ) {
                await interaction.reply({
                    content:
                        "<:ampulheta:1549129208557469786> O prazo deste pedido terminou. O ticket está sendo encerrado.",
                    flags:
                        MessageFlags.Ephemeral
                });

                setImmediate(
                    () =>
                        processarExpiracaoPedido(
                            interaction.guild,
                            pedidoAberto
                        )
                );

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

    const dadosCompra =
        interaction.customId.replace(
            "confirmar_compra_",
            ""
        );

    let quantidade;
    let cupomCodigo = null;

    if (
        dadosCompra.startsWith(
            "cupom_"
        )
    ) {

        const match =
            dadosCompra.match(
                /^cupom_(\d+)_(.+)$/
            );

        if (!match) {

            await interaction.update({
                content:
                    "<:x_:1549124126575165533> Não consegui identificar os dados deste cupom.",
                embeds: [],
                components: []
            });

            return;
        }

        quantidade =
            Number(
                match[1]
            );

        cupomCodigo =
            normalizarCodigoCupom(
                match[2]
            );

    } else {

        quantidade =
            Number(
                dadosCompra
            );
    }

    const valorOriginalCentavos =
        Math.round(
            (
                quantidade /
                100
            ) *
            320
        );

    let valorCentavos =
        valorOriginalCentavos;

    let descontoCentavos = 0;
    let descontoPercentual = 0;

    if (cupomCodigo) {

        const validacao =
            validarCupom(
                cupomCodigo,
                {
                    discordId:
                        interaction.user.id,
                    quantidadeRobux:
                        quantidade,
                    isBooster:
                        Boolean(
                            interaction.member
                                ?.premiumSinceTimestamp ||
                            interaction.member
                                ?.premiumSince
                        )
                }
            );

        if (
            !validacao.valido
        ) {

            await interaction.update({
                content:
                    `<:x_:1549124126575165533> ${validacao.motivo}`,
                embeds: [],
                components: []
            });

            return;
        }

        const calculo =
            calcularDescontoCupom(
                valorOriginalCentavos,
                validacao.cupom
            );

        valorCentavos =
            calculo.valorFinalCentavos;

        descontoCentavos =
            calculo.descontoCentavos;

        descontoPercentual =
            calculo.descontoPercentual;
    }

    const valor =
        valorCentavos /
        100;

    const estoqueAtual =
        obterEstoqueDisponivel();

    const validacaoLimitePedido =
        validarLimiteMaximoPedido({
            quantidade
        });

    if (
        !validacaoLimitePedido.valido
    ) {

        await interaction.update({
            content:
                `<:danger:1549129849904566392> ${validacaoLimitePedido.motivo}`,
            embeds: [],
            components: []
        });

        return;
    }

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

            topic:
                `RZ Store | rzstore-user:${interaction.user.id} | Compra de ${interaction.user.tag} | robux:${quantidade} | ` +
                `valor-original-centavos:${valorOriginalCentavos} | desconto-centavos:${descontoCentavos} | valor-centavos:${valorCentavos}` +
                (
                    cupomCodigo
                        ? ` | cupom:${cupomCodigo}`
                        : ""
                ),

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

        const reservaPedido =
            reservarPedidoEmAberto({
                channelId:
                    ticket.id,
                discordId:
                    interaction.user.id,
                quantidade
            });

        if (
            !reservaPedido.reservado
        ) {

            await ticket.delete(
                "Estoque indisponível durante a criação do pedido"
            );

            await interaction.update({
                content:
                    reservaPedido.motivo === "limite_metade"
                        ? `<:danger:1549129849904566392> O estoque disponível mudou enquanto seu pedido estava sendo criado. Para manter vendas abertas, o máximo atual por pedido é **${formatarRobux(reservaPedido.limite)} Robux**.`
                        : `<:danger:1549129849904566392> O estoque disponível mudou enquanto seu pedido estava sendo criado. Temos **${formatarRobux(reservaPedido.disponivel)} Robux** disponíveis agora.`,
                embeds: [],
                components: []
            });

            return;
        }

        await atualizarPainelEstoque(
            guild
        );

        agendarExpiracaoPedido(
            guild,
            ticket.id
        );

        const prazoExpiracaoUnix =
            Math.floor(Date.now() / 1000) +
            obterPrazoExpiracaoPedidoMinutos() * 60;

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
                (
                    cupomCodigo
                        ? `> <:cupom:1548097312046186559> **Cupom:** \`${cupomCodigo}\` — ${descontoPercentual}% OFF\n` +
                          `> **Desconto:** ${(descontoCentavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}\n`
                        : ""
                ) +
                `> <:pix:1548090281402966107> **Valor:** ${valorFormatado}\n\n` +

                `### <:ampulheta:1549129208557469786> Status\n` +
                `> Aguardando pagamento.\n` +
                `> **Prazo para pagar:** <t:${prazoExpiracaoUnix}:R>\n\n` +

                `Clique no botão **Gerar PIX** abaixo para criar sua cobrança.`
            )
            .setFooter({
                text: "RZ Store"
            })
            .setTimestamp();

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

        const mensagemPedido =
            await ticket.send({
                content: `${interaction.user} <@&${process.env.STAFF_ROLE_ID}>`,
                embeds: [embedTicket],
                components: [botoesTicket]
            });

        await ticket.setTopic(
            `${ticket.topic || ""} | ticket-msg:${mensagemPedido.id}`
        );

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

            const dadosItem =
                interaction.customId.replace(
                    "confirmar_item_",
                    ""
                );

            let opcao =
                dadosItem;

            let cupomCodigo =
                null;

            if (
                dadosItem.startsWith(
                    "cupom_"
                )
            ) {

                const match =
                    dadosItem.match(
                        /^cupom_([^_]+)_(.+)$/
                    );

                if (!match) {

                    await interaction.update({
                        content:
                            "<:x_:1549124126575165533> Não consegui identificar os dados deste cupom.",
                        embeds: [],
                        components: []
                    });

                    return;
                }

                opcao =
                    match[1];

                cupomCodigo =
                    normalizarCodigoCupom(
                        match[2]
                    );
            }

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

            const valorOriginalCentavos =
                Math.round(
                    produto.valor *
                    100
                );

            let valorCentavosItem =
                valorOriginalCentavos;

            let descontoCentavos = 0;
            let descontoPercentual = 0;

            if (cupomCodigo) {

                const validacao =
                    validarCupom(
                        cupomCodigo,
                        {
                            discordId:
                                interaction.user.id,
                            quantidadeRobux:
                                produto.robux,
                            isBooster:
                                Boolean(
                                    interaction.member
                                        ?.premiumSinceTimestamp ||
                                    interaction.member
                                        ?.premiumSince
                                )
                        }
                    );

                if (
                    !validacao.valido
                ) {

                    await interaction.update({
                        content:
                            `<:x_:1549124126575165533> ${validacao.motivo}`,
                        embeds: [],
                        components: []
                    });

                    return;
                }

                const calculo =
                    calcularDescontoCupom(
                        valorOriginalCentavos,
                        validacao.cupom
                    );

                valorCentavosItem =
                    calculo.valorFinalCentavos;

                descontoCentavos =
                    calculo.descontoCentavos;

                descontoPercentual =
                    calculo.descontoPercentual;
            }

            const estoqueAtual =
                obterEstoqueDisponivel();

            const validacaoLimitePedido =
                validarLimiteMaximoPedido({
                    quantidade:
                        produto.robux
                });

            if (
                !validacaoLimitePedido.valido
            ) {

                await interaction.update({
                    content:
                        `<:danger:1549129849904566392> ${validacaoLimitePedido.motivo}`,
                    embeds: [],
                    components: []
                });

                return;
            }

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
            const valorFormatado =
                (
                    valorCentavosItem /
                    100
                ).toLocaleString(
                    "pt-BR",
                    {
                        style:
                            "currency",
                        currency:
                            "BRL"
                    }
                );

            try {

                const ticket = await guild.channels.create({

                    name: `${opcao}-${nomeUsuario}`,

                    type: ChannelType.GuildText,

                    parent: process.env.CATEGORY_TICKETS_ID,

                    topic:
                        `RZ Store | rzstore-user:${interaction.user.id} | Produto: ${produto.nome} | Compra de ${interaction.user.tag} | robux:${produto.robux} | ` +
                        `valor-original-centavos:${valorOriginalCentavos} | desconto-centavos:${descontoCentavos} | valor-centavos:${valorCentavosItem}` +
                        (
                            cupomCodigo
                                ? ` | cupom:${cupomCodigo}`
                                : ""
                        ),

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

                const reservaPedido =
                    reservarPedidoEmAberto({
                        channelId:
                            ticket.id,
                        discordId:
                            interaction.user.id,
                        quantidade:
                            produto.robux
                    });

                if (
                    !reservaPedido.reservado
                ) {

                    await ticket.delete(
                        "Estoque indisponível durante a criação do pedido"
                    );

                    await interaction.update({
                        content:
                            reservaPedido.motivo === "limite_metade"
                                ? `<:danger:1549129849904566392> O estoque disponível mudou enquanto seu pedido estava sendo criado. Para manter vendas abertas, o máximo atual por pedido é **${formatarRobux(reservaPedido.limite)} Robux**.`
                                : `<:danger:1549129849904566392> O estoque disponível mudou enquanto seu pedido estava sendo criado. Temos **${formatarRobux(reservaPedido.disponivel)} Robux** disponíveis agora.`,
                        embeds: [],
                        components: []
                    });

                    return;
                }

                await atualizarPainelEstoque(
                    guild
                );

                agendarExpiracaoPedido(
                    guild,
                    ticket.id
                );

                const prazoExpiracaoUnix =
                    Math.floor(Date.now() / 1000) +
                    obterPrazoExpiracaoPedidoMinutos() * 60;

                const embedTicketItem = new EmbedBuilder()
                    .setColor("#00db0f")
                    .setTitle("<:greencart:1548089836647485591> Novo pedido — RZ Store")
                    .setDescription(
                        `Olá ${interaction.user}! Seu ticket de compra foi criado com sucesso.\n\n` +

                        `### <:esmeralda:1548188465508909118> Detalhes do pedido\n` +
                        `> **Cliente:** ${interaction.user}\n` +
                        `> **Produto:** ${produto.nome}\n` +
                        `> <:greenrbx:1548088739677470881> **Preço em Robux:** ${robuxFormatado}\n` +
                        (
                            cupomCodigo
                                ? `> <:cupom:1548097312046186559> **Cupom:** \`${cupomCodigo}\` — ${descontoPercentual}% OFF\n` +
                                  `> **Desconto:** ${(descontoCentavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}\n`
                                : ""
                        ) +
                        `> <:pix:1548090281402966107> **Valor:** ${valorFormatado}\n\n` +

                        `### <:ampulheta:1549129208557469786> Status\n` +
                        `> Aguardando pagamento.\n` +
                        `> **Prazo para pagar:** <t:${prazoExpiracaoUnix}:R>\n\n` +

                        `Clique no botão **Gerar PIX** abaixo para criar sua cobrança.`
                    )
                    .setFooter({
                        text: "RZ Store"
                    })
                    .setTimestamp();

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

                const mensagemPedido =
                    await ticket.send({
                        content: `${interaction.user} <@&${process.env.STAFF_ROLE_ID}>`,
                        embeds: [embedTicketItem],
                        components: [botoesTicketItem]
                    });

                await ticket.setTopic(
                    `${ticket.topic || ""} | ticket-msg:${mensagemPedido.id}`
                );

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

            const pedidoFoiEncerrado =
                encerrarPedidoEmAberto(
                    interaction.channel.id,
                    "cancelado"
                );

            if (
                pedidoFoiEncerrado
            ) {

                limparTimerExpiracaoPedido(
                    interaction.channel.id
                );

                await atualizarPainelEstoque(
                    interaction.guild
                );
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