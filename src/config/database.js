// src/config/database.js
// Pool PostgreSQL (Neon) com connection pooling

const { Pool } = require('pg');
const env = require('./env');
const logger = require('../shared/logger');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: { rejectUnauthorized: false },
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
 */
async function query(text, params) {
  const inicio = Date.now();
  const resultado = await pool.query(text, params);
  const duracao = Date.now() - inicio;

  if (duracao > 500) {
    logger.warn({ duracao, query: text.substring(0, 100) }, '[DB] Query lenta');
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
