// src/server.js
// Orquestrador — sem lógica de negócio

const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');

// Config
const env = require('./config/env');
const { pool, verificarConexao } = require('./config/database');
const { criarConexaoRedis, verificarConexaoRedis } = require('./config/redis');

// Shared
const logger = require('./shared/logger');

// Middleware
const errorHandler = require('./middleware/errorHandler');
const { limiteGeral } = require('./middleware/rateLimiter');
const requestLogger = require('./middleware/requestLogger');
const inputSanitizer = require('./middleware/inputSanitizer');

// Módulos
const { initAuthRoutes, initAuthTables } = require('./modules/auth');
const { initWhatsAppRoutes, initWhatsAppTables, inicializarWhatsApp } = require('./modules/whatsapp');
const { initTicketsRoutes, initTicketsTables } = require('./modules/tickets');
const { initMessagesRoutes, initMessagesTables } = require('./modules/messages');
const { initContactsRoutes, initContactsTables } = require('./modules/contacts');
const { initQueuesRoutes, initQueuesTables } = require('./modules/queues');
const { initUsersRoutes } = require('./modules/users');
const { initQuickRepliesRoutes } = require('./modules/quick-replies');
const { initTagsRoutes } = require('./modules/tags');
const { initConfigRoutes } = require('./modules/config');
const { initAiRoutes } = require('./modules/ai');
const { initReportsRoutes } = require('./modules/reports');

// WebSocket
const { inicializarWebSocket, broadcast, obterContagemConectados } = require('./websocket');

// Workers
const { inicializarMessageWorker } = require('./workers/messageWorker');

// WhatsApp Connection (para status no health check)
const conexaoWA = require('./modules/whatsapp/whatsapp.connection');

const app = express();
const server = http.createServer(app);

// ============================================================
// Middlewares globais
// ============================================================

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: env.FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
}));

app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(cookieParser());
app.use(inputSanitizer);
app.use(limiteGeral);
app.use(requestLogger);

// ============================================================
// Health check
// ============================================================

app.get('/health', async (req, res) => {
  const db = await verificarConexao();
  const redis = await verificarConexaoRedis();
  const wa = conexaoWA.obterStatus();

  const saudavel = db.conectado && redis.conectado;

  res.status(saudavel ? 200 : 503).json({
    status: saudavel ? 'saudavel' : 'degradado',
    timestamp: new Date().toISOString(),
    servicos: {
      database: db,
      redis: redis,
      whatsapp: {
        conectado: wa.conectado,
        status: wa.status,
        tempoOnline: wa.tempoOnline,
      },
      websocket: {
        clientesConectados: obterContagemConectados(),
      },
    },
  });
});

// ============================================================
// Rotas dos módulos
// ============================================================

initAuthRoutes(app);
initWhatsAppRoutes(app);
initTicketsRoutes(app);
initMessagesRoutes(app);
initContactsRoutes(app);
initQueuesRoutes(app);
initUsersRoutes(app);
initQuickRepliesRoutes(app);
initTagsRoutes(app);
initConfigRoutes(app);
initAiRoutes(app);
initReportsRoutes(app);

// ============================================================
// Error handler (deve ser o último middleware)
// ============================================================

app.use(errorHandler);

// ============================================================
// Inicialização
// ============================================================

async function iniciar() {
  try {
    logger.info('========================================');
    logger.info('[Server] Iniciando aplicação...');
    logger.info(`[Server] Ambiente: ${env.NODE_ENV}`);
    logger.info('========================================');

    // 1. Verificar conexão com banco
    const db = await verificarConexao();
    if (!db.conectado) {
      logger.error('[Server] Falha na conexão com o banco de dados');
      process.exit(1);
    }
    logger.info('[Server] Banco de dados conectado');

    // 2. Conectar Redis
    const redis = criarConexaoRedis();
    logger.info('[Server] Redis conectado');

    // 3. Rodar migrations (ordem importa — respeitar foreign keys)
    await initAuthTables(pool);
    await initWhatsAppTables(pool);
    await initContactsTables(pool);
    await initQueuesTables(pool);      // filas, tags, auditoria, etc
    await initTicketsTables(pool);     // depende de contatos e filas
    await initMessagesTables(pool);    // depende de tickets
    logger.info('[Server] Migrations executadas');

    // 4. Seed do admin padrão (se não existir)
    await _criarAdminPadrao();

    // 5. Inicializar WebSocket
    inicializarWebSocket(server);
    logger.info('[Server] WebSocket inicializado');

    // 6. Inicializar Message Worker (no mesmo processo)
    inicializarMessageWorker(redis);
    logger.info('[Server] Message Worker inicializado');

    // 7. Subir servidor HTTP ANTES do WhatsApp (pra health check funcionar)
    server.listen(env.PORT, () => {
      logger.info(`[Server] Rodando na porta ${env.PORT}`);
      logger.info(`[Server] Frontend URL: ${env.FRONTEND_URL}`);
      logger.info('========================================');
    });

    // 8. Inicializar WhatsApp (conexão Baileys) — em try/catch separado pra não derrubar o server
    try {
      await inicializarWhatsApp(broadcast);
      logger.info('[Server] WhatsApp inicializado');
    } catch (err) {
      logger.error({ err: err.message }, '[Server] WhatsApp falhou ao inicializar — servidor continua rodando sem WhatsApp');
    }
  } catch (err) {
    logger.error({ err }, '[Server] Falha na inicialização');
    process.exit(1);
  }
}

/**
 * Criar admin padrão se não existir nenhum usuário
 */
async function _criarAdminPadrao() {
  try {
    const resultado = await pool.query('SELECT COUNT(*) as total FROM usuarios');
    if (parseInt(resultado.rows[0].total) === 0) {
      const bcrypt = require('bcrypt');
      const senhaHash = await bcrypt.hash('admin123', 12);
      await pool.query(
        `INSERT INTO usuarios (nome, email, senha_hash, perfil)
         VALUES ('Administrador', 'admin@centraltutts.com', $1, 'admin')`,
        [senhaHash]
      );
      logger.info('[Server] Admin padrão criado (admin@centraltutts.com / admin123)');
      logger.warn('[Server] ⚠️  TROQUE A SENHA DO ADMIN PADRÃO!');
    }
  } catch (err) {
    // Se a tabela não existe ainda, ignora
    if (err.code !== '42P01') {
      logger.error({ err }, '[Server] Erro ao criar admin padrão');
    }
  }
}

// ============================================================
// Graceful shutdown
// ============================================================

async function gracefulShutdown(sinal) {
  logger.info({ sinal }, '[Server] Recebido sinal de shutdown...');

  // Fechar conexão WhatsApp
  try {
    await conexaoWA.desconectar();
  } catch {
    // Ignorar
  }

  // Fechar WebSocket
  server.close(() => {
    logger.info('[Server] HTTP server fechado');
  });

  // Fechar pool do banco
  try {
    await pool.end();
    logger.info('[Server] Pool do banco fechado');
  } catch {
    // Ignorar
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason: String(reason) }, '[Server] Unhandled Rejection');
});

process.on('uncaughtException', (err) => {
  console.error('[Server] UNCAUGHT EXCEPTION DETALHADO:', err);
  console.error('[Server] Mensagem:', err?.message);
  console.error('[Server] Stack:', err?.stack);
  console.error('[Server] Nome:', err?.name);
  console.error('[Server] Código:', err?.code);
  logger.warn('[Server] Processo mantido ativo apesar do erro');
});

// Iniciar
iniciar();