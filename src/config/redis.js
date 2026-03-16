// src/config/redis.js
// Conexão Redis para BullMQ, cache e sessões WS

const Redis = require('ioredis');
const env = require('./env');
const logger = require('../shared/logger');

let redis = null;

function criarConexaoRedis() {
  if (redis) return redis;

  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null, // BullMQ exige null
    enableReadyCheck: true,
    retryStrategy(times) {
      const delay = Math.min(times * 500, 30000);
      logger.warn({ tentativa: times, delay }, '[Redis] Reconectando...');
      return delay;
    },
  });

  redis.on('connect', () => {
    logger.info('[Redis] Conectado');
  });

  redis.on('error', (err) => {
    logger.error({ err }, '[Redis] Erro de conexão');
  });

  redis.on('close', () => {
    logger.warn('[Redis] Conexão fechada');
  });

  return redis;
}

/**
 * Verificar conexão com Redis
 */
async function verificarConexaoRedis() {
  try {
    if (!redis) return { conectado: false, erro: 'Não inicializado' };
    const pong = await redis.ping();
    return { conectado: pong === 'PONG' };
  } catch (err) {
    return { conectado: false, erro: err.message };
  }
}

/**
 * Cache helper — get/set com TTL
 */
async function cacheGet(chave) {
  try {
    const valor = await redis.get(chave);
    return valor ? JSON.parse(valor) : null;
  } catch {
    return null;
  }
}

async function cacheSet(chave, valor, ttlSegundos = 600) {
  try {
    await redis.set(chave, JSON.stringify(valor), 'EX', ttlSegundos);
  } catch (err) {
    logger.error({ err, chave }, '[Redis] Erro ao setar cache');
  }
}

async function cacheDel(chave) {
  try {
    await redis.del(chave);
  } catch (err) {
    logger.error({ err, chave }, '[Redis] Erro ao deletar cache');
  }
}

module.exports = {
  criarConexaoRedis,
  getRedis: () => redis,
  verificarConexaoRedis,
  cacheGet,
  cacheSet,
  cacheDel,
};
