// src/modules/whatsapp/whatsapp.migration.js
// Migration do módulo WhatsApp — tabela de sessões do Baileys

const logger = require('../../shared/logger');

const SQL = `
  CREATE TABLE IF NOT EXISTS whatsapp_sessoes (
    id SERIAL PRIMARY KEY,
    sessao_id VARCHAR(100) UNIQUE NOT NULL,
    dados JSONB NOT NULL,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_wa_sessoes_id ON whatsapp_sessoes(sessao_id);
`;

async function initWhatsAppTables(pool) {
  try {
    await pool.query(SQL);
    logger.info('[Migration] Tabela whatsapp_sessoes criada/verificada');
  } catch (err) {
    logger.error({ err }, '[Migration] Falha ao criar tabela whatsapp_sessoes');
    throw err;
  }
}

module.exports = { initWhatsAppTables };
