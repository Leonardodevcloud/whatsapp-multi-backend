// src/config/database.js
// Pool PostgreSQL (Neon) com connection pooling otimizado

const { Pool } = require('pg');
const env = require('./env');
const logger = require('../shared/logger');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Pool otimizado para 15+ atendentes simultâneos:
  // Cada atendente faz ~2-3 queries concorrentes (sidebar + chat + painel)
  // Com WS-driven updates, polling cai de ~20 req/s para ~3 req/s
  max: 30,                         // 20 → 30 (margem para picos)
  min: 5,                          // Manter 5 conexões quentes
  idleTimeoutMillis: 60000,        // 30s → 60s (Neon reconecta rápido, mas manter quente é melhor)
  connectionTimeoutMillis: 10000,
  ssl: { rejectUnauthorized: false },
  // Statement timeout: prevenir queries travadas
  statement_timeout: 15000,        // 15s max por query
});

pool.on('error', (err) => {
  logger.error({ err }, '[DB] Erro inesperado no pool');
});

pool.on('connect', () => {
  logger.debug('[DB] Nova conexão estabelecida');
});

/**
 * Helper para executar query com client do pool
 * Garante release no finally
 * Log de queries lentas (>300ms warning, >1000ms error)
 */
async function query(text, params) {
  const inicio = Date.now();
  const resultado = await pool.query(text, params);
  const duracao = Date.now() - inicio;

  if (duracao > 1000) {
    logger.error({ duracao, query: text.substring(0, 200), params: params?.length }, '[DB] Query MUITO lenta (>1s)');
  } else if (duracao > 300) {
    logger.warn({ duracao, query: text.substring(0, 150) }, '[DB] Query lenta (>300ms)');
  }

  return resultado;
}

/**
 * Obter client para transações
 * IMPORTANTE: sempre usar release() no finally
 */
async function getClient() {
  return pool.connect();
}

/**
 * Verificar conexão com o banco
 */
async function verificarConexao() {
  try {
    const resultado = await pool.query('SELECT NOW()');
    return { conectado: true, timestamp: resultado.rows[0].now };
  } catch (err) {
    logger.error({ err }, '[DB] Falha na verificação de conexão');
    return { conectado: false, erro: err.message };
  }
}

module.exports = { pool, query, getClient, verificarConexao };
