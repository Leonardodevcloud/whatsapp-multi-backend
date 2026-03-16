// src/modules/tickets/tickets.migration.js
const logger = require('../../shared/logger');

const SQL = `
  CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY,
    contato_id INT REFERENCES contatos(id) ON DELETE SET NULL,
    fila_id INT REFERENCES filas(id) ON DELETE SET NULL,
    usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
    status VARCHAR(20) DEFAULT 'pendente' CHECK (status IN ('pendente', 'aberto', 'aguardando', 'resolvido', 'fechado')),
    protocolo VARCHAR(20) UNIQUE,
    assunto VARCHAR(300),
    prioridade VARCHAR(10) DEFAULT 'normal' CHECK (prioridade IN ('baixa', 'normal', 'alta', 'urgente')),
    ultima_mensagem_em TIMESTAMPTZ,
    ultima_mensagem_preview TEXT,
    is_bot BOOLEAN DEFAULT FALSE,
    avaliacao INT CHECK (avaliacao BETWEEN 1 AND 5),
    tempo_primeira_resposta_seg INT,
    tempo_resolucao_seg INT,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW(),
    fechado_em TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_fila ON tickets(fila_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_usuario ON tickets(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_contato ON tickets(contato_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_criado ON tickets(criado_em DESC);
  CREATE INDEX IF NOT EXISTS idx_tickets_cursor ON tickets(id DESC);
  CREATE INDEX IF NOT EXISTS idx_tickets_status_fila ON tickets(status, fila_id);
`;

async function initTicketsTables(pool) {
  try {
    await pool.query(SQL);
    logger.info('[Migration] Tabela tickets criada/verificada');
  } catch (err) {
    logger.error({ err }, '[Migration] Falha ao criar tabela tickets');
    throw err;
  }
}

module.exports = { initTicketsTables };
