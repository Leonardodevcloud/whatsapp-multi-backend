// src/modules/contacts/contacts.migration.js
const logger = require('../../shared/logger');

const SQL = `
  CREATE TABLE IF NOT EXISTS contatos (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(200),
    telefone VARCHAR(30) UNIQUE NOT NULL,
    avatar_url TEXT,
    email VARCHAR(200),
    notas TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_contatos_telefone ON contatos(telefone);
`;

async function initContactsTables(pool) {
  try {
    await pool.query(SQL);
    // Garantir que telefone suporta IDs de grupo longos
    await pool.query(`ALTER TABLE contatos ALTER COLUMN telefone TYPE VARCHAR(30)`).catch(() => {});
    // Flag que impede o webhook de sobrescrever o nome editado manualmente
    await pool.query(`ALTER TABLE contatos ADD COLUMN IF NOT EXISTS nome_editado BOOLEAN DEFAULT FALSE`);
    logger.info('[Migration] Tabela contatos criada/verificada');
  } catch (err) {
    logger.error({ err }, '[Migration] Falha ao criar tabela contatos');
    throw err;
  }
}

module.exports = { initContactsTables };
