// src/shared/logger.js
// Logger estruturado com Pino — logs JSON para Railway

const pino = require('pino');
const env = require('../config/env');

const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
  base: { app: 'whatsapp-multi' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
