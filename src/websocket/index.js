// src/websocket/index.js
// WebSocket server — real-time para atendentes
// COM handler de ping do frontend (heartbeat)

const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const logger = require('../shared/logger');

let wss = null;
const clientesPorUsuario = new Map();

function inicializarWebSocket(server) {
  wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info, callback) => {
      try {
        const url = new URL(info.req.url, `http://${info.req.headers.host}`);
        const token = url.searchParams.get('token');
        if (!token) { callback(false, 401, 'Token não fornecido'); return; }
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

    if (!clientesPorUsuario.has(userId)) {
      clientesPorUsuario.set(userId, new Set());
    }
    clientesPorUsuario.get(userId).add(ws);

    logger.info({ userId, nome: usuario.nome }, '[WS] Cliente conectado');

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      try {
        const mensagem = JSON.parse(data.toString());
        _handleMensagemCliente(ws, usuario, mensagem);
      } catch { }
    });

    ws.on('close', () => {
      const conns = clientesPorUsuario.get(userId);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) clientesPorUsuario.delete(userId);
      }
      logger.info({ userId }, '[WS] Cliente desconectado');
    });

    ws.on('error', (err) => {
      logger.error({ err, userId }, '[WS] Erro no WebSocket');
    });

    _enviar(ws, 'conexao', { sucesso: true, usuario: { id: userId, nome: usuario.nome } });
  });

  // Heartbeat nativo — limpar conexões mortas a cada 30s
  const heartbeat = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => { clearInterval(heartbeat); });

  logger.info('[WS] WebSocket server inicializado em /ws');
  return wss;
}

function _handleMensagemCliente(ws, usuario, mensagem) {
  const { evento, dados } = mensagem;

  switch (evento) {
    // Heartbeat do frontend — responder imediatamente
    case 'ping':
      _enviar(ws, 'pong', { ts: Date.now() });
      ws.isAlive = true; // Manter vivo
      break;
    case 'ticket:visualizar':
      break;
    case 'digitando':
      broadcast('digitando', { ticketId: dados?.ticketId, usuarioId: usuario.id, nome: usuario.nome });
      break;
    default:
      break;
  }
}

function _enviar(ws, evento, dados) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ evento, dados, timestamp: new Date().toISOString() }));
  }
}

function enviarParaUsuario(userId, evento, dados) {
  const conns = clientesPorUsuario.get(userId);
  if (!conns) return;
  const payload = JSON.stringify({ evento, dados, timestamp: new Date().toISOString() });
  for (const ws of conns) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function broadcast(evento, dados) {
  if (!wss) return;
  const payload = JSON.stringify({ evento, dados, timestamp: new Date().toISOString() });
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  });
}

function obterContagemConectados() {
  return wss ? wss.clients.size : 0;
}

module.exports = { inicializarWebSocket, enviarParaUsuario, broadcast, obterContagemConectados };
