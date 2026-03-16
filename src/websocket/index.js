// src/websocket/index.js
// WebSocket server — real-time para atendentes

const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const logger = require('../shared/logger');

let wss = null;
const clientesPorUsuario = new Map(); // Map<userId, Set<ws>>

/**
 * Inicializar WebSocket server no mesmo HTTP server
 */
function inicializarWebSocket(server) {
  wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info, callback) => {
      // Autenticação JWT via query param (ws://host/ws?token=xxx)
      try {
        const url = new URL(info.req.url, `http://${info.req.headers.host}`);
        const token = url.searchParams.get('token');

        if (!token) {
          callback(false, 401, 'Token não fornecido');
          return;
        }

        const decoded = jwt.verify(token, env.JWT_SECRET);
        info.req.usuario = decoded;
        callback(true);
      } catch (err) {
        logger.warn({ err: err.message }, '[WS] Autenticação falhou');
        callback(false, 401, 'Token inválido');
      }
    },
  });

  wss.on('connection', (ws, req) => {
    const usuario = req.usuario;
    const userId = usuario.id;

    // Registrar cliente
    if (!clientesPorUsuario.has(userId)) {
      clientesPorUsuario.set(userId, new Set());
    }
    clientesPorUsuario.get(userId).add(ws);

    logger.info({ userId, nome: usuario.nome }, '[WS] Cliente conectado');

    // Heartbeat
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Mensagens recebidas do cliente
    ws.on('message', (data) => {
      try {
        const mensagem = JSON.parse(data.toString());
        _handleMensagemCliente(ws, usuario, mensagem);
      } catch {
        // Ignorar mensagens inválidas
      }
    });

    // Desconexão
    ws.on('close', () => {
      const conns = clientesPorUsuario.get(userId);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) {
          clientesPorUsuario.delete(userId);
        }
      }
      logger.info({ userId }, '[WS] Cliente desconectado');
    });

    ws.on('error', (err) => {
      logger.error({ err, userId }, '[WS] Erro no WebSocket');
    });

    // Enviar confirmação de conexão
    _enviar(ws, 'conexao', { sucesso: true, usuario: { id: userId, nome: usuario.nome } });
  });

  // Heartbeat interval — limpar conexões mortas
  const heartbeat = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  logger.info('[WS] WebSocket server inicializado em /ws');

  return wss;
}

/**
 * Handler de mensagens do cliente
 */
function _handleMensagemCliente(ws, usuario, mensagem) {
  const { evento, dados } = mensagem;

  switch (evento) {
    case 'ticket:visualizar':
      // Atendente está visualizando um ticket — marcar msgs como lidas
      // Será implementado na Fase 2
      break;
    case 'digitando':
      // Indicador de digitação
      broadcast('digitando', { ticketId: dados?.ticketId, usuarioId: usuario.id, nome: usuario.nome });
      break;
    default:
      break;
  }
}

/**
 * Enviar mensagem para um WebSocket específico
 */
function _enviar(ws, evento, dados) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ evento, dados, timestamp: new Date().toISOString() }));
  }
}

/**
 * Enviar para um usuário específico (todas as conexões dele)
 */
function enviarParaUsuario(userId, evento, dados) {
  const conns = clientesPorUsuario.get(userId);
  if (!conns) return;

  const payload = JSON.stringify({ evento, dados, timestamp: new Date().toISOString() });
  for (const ws of conns) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

/**
 * Broadcast para TODOS os clientes conectados
 */
function broadcast(evento, dados) {
  if (!wss) return;

  const payload = JSON.stringify({ evento, dados, timestamp: new Date().toISOString() });

  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  });
}

/**
 * Obter contagem de clientes conectados
 */
function obterContagemConectados() {
  return wss ? wss.clients.size : 0;
}

module.exports = {
  inicializarWebSocket,
  enviarParaUsuario,
  broadcast,
  obterContagemConectados,
};
