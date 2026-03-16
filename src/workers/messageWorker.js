// src/workers/messageWorker.js
// Consumer BullMQ — processa mensagens recebidas do WhatsApp
// Pode rodar como serviço separado no Railway

const { Worker } = require('bullmq');
const { criarConexaoRedis } = require('../config/redis');
const { pool, query } = require('../config/database');
const { extrairTelefone } = require('../modules/whatsapp/whatsapp.service');
const { broadcast } = require('../websocket/index');
const logger = require('../shared/logger');

// Tipo de mensagem mapeado do Baileys
function mapearTipoMensagem(message) {
  if (message.conversation || message.extendedTextMessage) return 'texto';
  if (message.imageMessage) return 'imagem';
  if (message.audioMessage) return 'audio';
  if (message.videoMessage) return 'video';
  if (message.documentMessage || message.documentWithCaptionMessage) return 'documento';
  if (message.locationMessage || message.liveLocationMessage) return 'localizacao';
  if (message.contactMessage || message.contactsArrayMessage) return 'contato';
  if (message.stickerMessage) return 'sticker';
  return 'texto';
}

// Extrair corpo da mensagem
function extrairCorpo(message) {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.title) return message.documentMessage.title;
  if (message.documentWithCaptionMessage?.message?.documentMessage?.caption) {
    return message.documentWithCaptionMessage.message.documentMessage.caption;
  }
  if (message.locationMessage) {
    return `📍 Localização: ${message.locationMessage.degreesLatitude}, ${message.locationMessage.degreesLongitude}`;
  }
  if (message.contactMessage) return `👤 Contato: ${message.contactMessage.displayName}`;
  return '';
}

// Gerar protocolo único: YYYYMMDD-XXXXX
function gerarProtocolo() {
  const data = new Date();
  const yyyymmdd = data.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(10000 + Math.random() * 90000);
  return `${yyyymmdd}-${random}`;
}

/**
 * Processar mensagem recebida
 */
async function processarMensagem(job) {
  const { key, message, pushName, waMessageId } = job.data;
  const telefone = extrairTelefone(key.remoteJid);

  if (!telefone || !message) {
    logger.warn({ waMessageId }, '[Worker] Mensagem sem telefone ou conteúdo');
    return;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Deduplicação — verificar se já processamos esta mensagem
    const duplicada = await client.query(
      `SELECT id FROM mensagens WHERE wa_message_id = $1`,
      [waMessageId]
    );
    if (duplicada.rows.length > 0) {
      logger.debug({ waMessageId }, '[Worker] Mensagem duplicada, ignorando');
      await client.query('COMMIT');
      return;
    }

    // 2. Identificar ou criar contato
    let contatoResult = await client.query(
      `SELECT id, nome FROM contatos WHERE telefone = $1`,
      [telefone]
    );

    let contatoId;
    if (contatoResult.rows.length === 0) {
      const novoContato = await client.query(
        `INSERT INTO contatos (nome, telefone) VALUES ($1, $2) RETURNING id, nome`,
        [pushName || telefone, telefone]
      );
      contatoId = novoContato.rows[0].id;
      logger.info({ contatoId, telefone }, '[Worker] Novo contato criado');
    } else {
      contatoId = contatoResult.rows[0].id;
      // Atualizar nome se veio pushName e o contato não tinha nome
      if (pushName && !contatoResult.rows[0].nome) {
        await client.query(
          `UPDATE contatos SET nome = $1, atualizado_em = NOW() WHERE id = $2`,
          [pushName, contatoId]
        );
      }
    }

    // 3. Identificar ou criar ticket
    // Regra: reabre último ticket do contato se criado há menos de 2h e não está fechado
    let ticketResult = await client.query(
      `SELECT id, status, usuario_id FROM tickets
       WHERE contato_id = $1 AND status NOT IN ('fechado')
       ORDER BY criado_em DESC LIMIT 1`,
      [contatoId]
    );

    let ticketId;
    let ticketNovo = false;

    if (ticketResult.rows.length > 0) {
      ticketId = ticketResult.rows[0].id;

      // Se estava resolvido, reabrir como pendente
      if (ticketResult.rows[0].status === 'resolvido') {
        await client.query(
          `UPDATE tickets SET status = 'pendente', usuario_id = NULL, atualizado_em = NOW() WHERE id = $1`,
          [ticketId]
        );
      }
    } else {
      // Criar novo ticket
      const protocolo = gerarProtocolo();
      const novoTicket = await client.query(
        `INSERT INTO tickets (contato_id, status, protocolo, ultima_mensagem_em)
         VALUES ($1, 'pendente', $2, NOW())
         RETURNING id`,
        [contatoId, protocolo]
      );
      ticketId = novoTicket.rows[0].id;
      ticketNovo = true;
      logger.info({ ticketId, protocolo, contatoId }, '[Worker] Novo ticket criado');
    }

    // 4. Salvar mensagem
    const tipo = mapearTipoMensagem(message);
    const corpo = extrairCorpo(message);

    const msgResult = await client.query(
      `INSERT INTO mensagens (ticket_id, contato_id, corpo, tipo, wa_message_id, is_from_me, status_envio)
       VALUES ($1, $2, $3, $4, $5, FALSE, 'entregue')
       RETURNING id, ticket_id, corpo, tipo, is_from_me, criado_em`,
      [ticketId, contatoId, corpo, tipo, waMessageId]
    );

    // 5. Atualizar preview do ticket
    await client.query(
      `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW()
       WHERE id = $2`,
      [(corpo || '📎 Mídia').substring(0, 200), ticketId]
    );

    // 5.1 Distribuição automática (só para tickets novos sem atendente)
    let atendenteAtribuido = null;
    if (ticketNovo) {
      atendenteAtribuido = await _distribuirTicketAutomaticamente(client, ticketId);
    }

    await client.query('COMMIT');

    // 6. Emitir via WebSocket para atendentes
    const mensagemCompleta = {
      ...msgResult.rows[0],
      contato: {
        id: contatoId,
        nome: pushName || telefone,
        telefone,
      },
      ticketNovo,
    };

    broadcast('mensagem:nova', mensagemCompleta);

    if (ticketNovo) {
      broadcast('ticket:novo', {
        id: ticketId,
        contato: mensagemCompleta.contato,
        status: 'pendente',
        ultimaMensagemPreview: (corpo || '📎 Mídia').substring(0, 200),
      });
    }

    logger.info({ ticketId, waMessageId, tipo }, '[Worker] Mensagem processada');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, waMessageId }, '[Worker] Erro ao processar mensagem');
    throw err; // BullMQ vai retentar
  } finally {
    client.release();
  }
}

/**
 * Distribuição automática de tickets para atendentes
 * Regra: 'menos_tickets' = atribui ao atendente online com menos tickets ativos
 */
async function _distribuirTicketAutomaticamente(client, ticketId) {
  try {
    // Buscar config de distribuição
    const configResult = await client.query(
      `SELECT valor FROM configuracoes WHERE chave = 'distribuicao_tickets'`
    );
    const modo = configResult.rows[0]?.valor || 'manual';

    if (modo === 'manual') return null;

    // Buscar ticket para saber a fila
    const ticketResult = await client.query(`SELECT fila_id FROM tickets WHERE id = $1`, [ticketId]);
    const filaId = ticketResult.rows[0]?.fila_id;

    // Buscar atendentes online elegíveis
    let queryAtendentes = `
      SELECT u.id, u.nome, u.max_tickets_simultaneos,
             (SELECT COUNT(*) FROM tickets t WHERE t.usuario_id = u.id AND t.status IN ('aberto', 'aguardando')) as tickets_ativos
      FROM usuarios u
      WHERE u.online = TRUE AND u.ativo = TRUE AND u.perfil != 'admin'
    `;
    const paramsAtendentes = [];

    if (filaId) {
      queryAtendentes += ` AND EXISTS (SELECT 1 FROM usuario_filas uf WHERE uf.usuario_id = u.id AND uf.fila_id = $1)`;
      paramsAtendentes.push(filaId);
    }

    queryAtendentes += ` ORDER BY tickets_ativos ASC LIMIT 1`;

    const atendentes = await client.query(queryAtendentes, paramsAtendentes);
    if (atendentes.rows.length === 0) return null;

    const atendente = atendentes.rows[0];

    // Verificar se não ultrapassou o limite
    if (parseInt(atendente.tickets_ativos) >= atendente.max_tickets_simultaneos) return null;

    // Atribuir
    await client.query(
      `UPDATE tickets SET usuario_id = $1, status = 'aberto', atualizado_em = NOW() WHERE id = $2`,
      [atendente.id, ticketId]
    );

    // Mensagem de sistema
    await client.query(
      `INSERT INTO mensagens (ticket_id, corpo, tipo, is_from_me, is_internal)
       VALUES ($1, $2, 'sistema', TRUE, TRUE)`,
      [ticketId, `Ticket atribuído automaticamente para ${atendente.nome}`]
    );

    logger.info({ ticketId, atendenteId: atendente.id, modo }, '[Worker] Ticket distribuído automaticamente');

    return { id: atendente.id, nome: atendente.nome };
  } catch (err) {
    logger.error({ err, ticketId }, '[Worker] Erro na distribuição automática');
    return null;
  }
}

/**
 * Inicializar worker (pode rodar no mesmo processo ou separado)
 */
function inicializarMessageWorker(redisConnection) {
  const worker = new Worker('mensagens-recebidas', processarMensagem, {
    connection: redisConnection,
    concurrency: 5,
    limiter: {
      max: 50,
      duration: 1000,
    },
  });

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, '[Worker] Job concluído');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message, attempts: job?.attemptsMade }, '[Worker] Job falhou');
  });

  worker.on('error', (err) => {
    logger.error({ err }, '[Worker] Erro no worker');
  });

  logger.info('[Worker] Message worker inicializado (concurrency: 5)');

  return worker;
}

module.exports = { inicializarMessageWorker };
