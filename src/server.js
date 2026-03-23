// src/server.js
// Orquestrador — sem lógica de negócio
// ADICIONADO: Cron job pra mapear LIDs automaticamente

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
const { initSupervisionRoutes } = require('./modules/supervision');
const { initUsersRoutes } = require('./modules/users');
const { initQuickRepliesRoutes } = require('./modules/quick-replies');
const { initTagsRoutes } = require('./modules/tags');
const { initConfigRoutes } = require('./modules/config');
const { initAiRoutes, initIaTables } = require('./modules/ai');
const { initReportsRoutes } = require('./modules/reports');

// WebSocket
const { inicializarWebSocket, broadcast, obterContagemConectados } = require('./websocket');

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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
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
initSupervisionRoutes(app);

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
    await initIaTables();               // tabelas de IA/aprendizado
    logger.info('[Server] Migrations executadas');

    // 4. Seed do admin padrão (se não existir)
    await _criarAdminPadrao();

    // 4b. Garantir coluna is_group em contatos
    await pool.query(`ALTER TABLE contatos ADD COLUMN IF NOT EXISTS is_group BOOLEAN DEFAULT FALSE`).catch(() => {});
    // Marcar grupos existentes pelo padrão do telefone
    await pool.query(`UPDATE contatos SET is_group = TRUE WHERE is_group IS NOT TRUE AND telefone LIKE '120363%'`).catch(() => {});

    // 5. Inicializar WebSocket
    inicializarWebSocket(server);
    logger.info('[Server] WebSocket inicializado');

    // 6. Subir servidor HTTP ANTES do WhatsApp
    server.listen(env.PORT, () => {
      logger.info(`[Server] Rodando na porta ${env.PORT}`);
      logger.info(`[Server] Frontend URL: ${env.FRONTEND_URL}`);
      logger.info('========================================');
    });

    // 7. Inicializar WhatsApp Cloud API
    try {
      await inicializarWhatsApp(broadcast);
      logger.info('[Server] WhatsApp Cloud API inicializado');
    } catch (err) {
      logger.error({ err: err.message }, '[Server] WhatsApp falhou — servidor continua rodando');
    }

    // 8. Iniciar cron jobs
    _iniciarCronJobs();

  } catch (err) {
    logger.error({ err }, '[Server] Falha na inicialização');
    process.exit(1);
  }
}

// ============================================================
// CRON JOBS
// ============================================================

function _iniciarCronJobs() {
  // ---- Mapear LIDs de contatos novos ----
  // Fase 1: A cada 5 minutos com batch de 200, até mapear TUDO
  // Fase 2: Quando acabar, muda pra a cada 6 horas (manutenção)
  const INTERVALO_RAPIDO = 5 * 60 * 1000;    // 5 minutos
  const INTERVALO_MANUTENCAO = 6 * 60 * 60 * 1000; // 6 horas
  let intervaloAtual = null;
  let totalMapeadoGlobal = 0;

  async function executarMapeamento() {
    try {
      const whatsappService = require('./modules/whatsapp/whatsapp.service');
      const resultado = await whatsappService.mapearLidsContatos({ limite: 200 });
      totalMapeadoGlobal += resultado.mapeados;

      logger.info({
        batch: resultado.mapeados,
        erros: resultado.erros,
        restantes: resultado.total - resultado.mapeados,
        totalGlobal: totalMapeadoGlobal,
      }, '[Cron] Mapeamento de LIDs');

      // Se não tem mais contatos pra mapear, mudar pra intervalo de manutenção
      if (resultado.total === 0) {
        logger.info(`[Cron] ✅ Todos os LIDs mapeados! Total: ${totalMapeadoGlobal}. Mudando pra modo manutenção (6h).`);

        if (intervaloAtual) clearInterval(intervaloAtual);
        intervaloAtual = setInterval(executarMapeamento, INTERVALO_MANUTENCAO);
      }
    } catch (err) {
      logger.error({ err: err.message }, '[Cron] Erro no mapeamento de LIDs');
    }
  }

  // Primeira execução 2 minutos após o boot
  setTimeout(() => {
    logger.info('[Cron] Iniciando mapeamento rápido de LIDs (a cada 5 min)...');
    executarMapeamento();

    // Depois repete a cada 5 minutos até acabar
    intervaloAtual = setInterval(executarMapeamento, INTERVALO_RAPIDO);
  }, 2 * 60 * 1000);

  logger.info('[Server] Cron jobs iniciados (mapear LIDs: 2min após boot, depois a cada 5min até acabar)');

  // ---- Cron IA: aprender de tickets fechados ----
  // A cada 6 horas, analisa tickets fechados e extrai exemplos
  setInterval(async () => {
    try {
      const { aprenderDeTicketsFechados } = require('./modules/ai/ai.service');
      await aprenderDeTicketsFechados();
    } catch (err) {
      logger.error({ err: err.message }, '[Cron] Erro no aprendizado IA');
    }
  }, 6 * 60 * 60 * 1000); // 6 horas

  // Primeira execução do aprendizado 10 min após boot
  setTimeout(async () => {
    try {
      const { aprenderDeTicketsFechados } = require('./modules/ai/ai.service');
      await aprenderDeTicketsFechados();
      logger.info('[Cron] Aprendizado IA executado (boot)');
    } catch (err) {
      logger.error({ err: err.message }, '[Cron] Erro no aprendizado IA (boot)');
    }
  }, 10 * 60 * 1000); // 10 min

  // ---- Cron Resumo Diário às 19h ----
  const _checkResumoDiario = async () => {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bahia' }));
    if (agora.getHours() === 19 && agora.getMinutes() < 5) {
      try {
        const { gerarResumoDiario } = require('./modules/ai/ai.service');
        const resultado = await gerarResumoDiario();
        if (resultado) {
          const conexaoWA = require('./modules/whatsapp/whatsapp.connection');
          if (conexaoWA.status === 'conectado' || (conexaoWA.instanceId && conexaoWA.token)) {
            await conexaoWA.enviarTexto(resultado.telefone, resultado.resumo);
            logger.info('[Cron] Resumo diário enviado');
          }
        }
      } catch (err) {
        logger.error({ err: err.message }, '[Cron] Erro no resumo diário');
      }
    }
  };
  setInterval(_checkResumoDiario, 5 * 60 * 1000); // Check a cada 5 min
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
