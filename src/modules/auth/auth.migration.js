// src/modules/auth/auth.migration.js
// Migration do módulo auth — cria tabela de usuários

const logger = require('../../shared/logger');

const SQL = `
  CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    senha_hash VARCHAR(255) NOT NULL,
    perfil VARCHAR(20) DEFAULT 'atendente' CHECK (perfil IN ('admin', 'supervisor', 'atendente')),
    avatar_url TEXT,
    online BOOLEAN DEFAULT FALSE,
    max_tickets_simultaneos INT DEFAULT 5,
    ativo BOOLEAN DEFAULT TRUE,
    ultimo_acesso TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
`;

async function initAuthTables(pool) {
  try {
    await pool.query(SQL);
    logger.info('[Migration] Tabela usuarios criada/verificada');
  } catch (err) {
    logger.error({ err }, '[Migration] Falha ao criar tabela usuarios');
    throw err;
  }
}

module.exports = { initAuthTables };
