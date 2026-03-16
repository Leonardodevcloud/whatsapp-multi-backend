// src/config/redis.js
// Conexão Redis para BullMQ, cache e sessões WS

const Redis = require('ioredis');
const env = require('./env');
const logger = require('../shared/logger');

let redis = null;

function criarConexaoRedis() {
  if (redis) return redis;

  const redisUrl = env.REDIS_URL;

  // Railway Redis pode usar rediss:// (TLS) — ioredis precisa de config especial
  const opcoes = {
    maxRetriesPerRequest: null, // BullMQ exige null
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy(times) {
      if (times > 20) {
        logger.error('[Redis] Máximo de tentativas atingido');
        return null;
      }
      const delay = Math.min(times * 1000, 30000);
      logger.warn({ tentativa: times, delay }, '[Redis] Reconectando...');
      return delay;
    },
    reconnectOnError(err) {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED'];
      return targetErrors.some(e => err.message.includes(e));
    },
  };

  // Se a URL usa rediss:// (TLS), configurar TLS
  if (redisUrl.startsWith('rediss://')) {
    opcoes.tls = { rejectUnauthorized: false };
  }

  redis = new Redis(redisUrl, opcoes);

  redis.on('connect', () => {
    logger.info('[Redis] Conectado');
  });

  redis.on('ready', () => {
    logger.info('[Redis] Pronto para uso');
  });

  redis.on('error', (err) => {
    logger.error({ erro: err.message }, '[Redis] Erro de conexão');
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