// src/config/env.js
// Validação de variáveis de ambiente obrigatórias

const VARS_OBRIGATORIAS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
];

function validarEnv() {
  const faltando = VARS_OBRIGATORIAS.filter((v) => !process.env[v]);

  if (faltando.length > 0) {
    console.error(`[ENV] Variáveis obrigatórias não definidas: ${faltando.join(', ')}`);
    process.exit(1);
  }

  return {
    PORT: parseInt(process.env.PORT, 10) || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  };
}

const env = validarEnv();

module.exports = env;
