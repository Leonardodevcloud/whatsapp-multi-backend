// src/modules/messages/messages.migration.js
const logger = require('../../shared/logger');

const SQL = `
  CREATE TABLE IF NOT EXISTS mensagens (
    id SERIAL PRIMARY KEY,
    ticket_id INT REFERENCES tickets(id) ON DELETE CASCADE,
    contato_id INT REFERENCES contatos(id) ON DELETE SET NULL,
    usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
    corpo TEXT,
    tipo VARCHAR(20) DEFAULT 'texto' CHECK (tipo IN ('texto', 'imagem', 'audio', 'video', 'documento', 'localizacao', 'contato', 'sticker', 'sistema')),
    media_url TEXT,
    media_tipo VARCHAR(50),
    media_nome VARCHAR(255),
    wa_message_id VARCHAR(100),
    is_from_me BOOLEAN DEFAULT FALSE,
    is_internal BOOLEAN DEFAULT FALSE,
    status_envio VARCHAR(20) DEFAULT 'enviada' CHECK (status_envio IN ('pendente', 'enviada', 'entregue', 'lida', 'erro')),
    quoted_message_id INT REFERENCES mensagens(id),
    criado_em TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_mensagens_ticket ON mensagens(ticket_id, criado_em ASC);
  CREATE INDEX IF NOT EXISTS idx_mensagens_wa_id ON mensagens(wa_message_id);
  CREATE INDEX IF NOT EXISTS idx_mensagens_cursor ON mensagens(ticket_id, id ASC);
`;

async function initMessagesTables(pool) {
  try {
    await pool.query(SQL);
    logger.info('[Migration] Tabela mensagens criada/verificada');
  } catch (err) {
    logger.error({ err }, '[Migration] Falha ao criar tabela mensagens');
    throw err;
  }
}

module.exports = { initMessagesTables };
