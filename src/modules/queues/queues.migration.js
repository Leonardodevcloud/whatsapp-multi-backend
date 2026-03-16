// src/modules/queues/queues.migration.js
const logger = require('../../shared/logger');

const SQL = `
  CREATE TABLE IF NOT EXISTS filas (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    cor VARCHAR(7) DEFAULT '#7C3AED',
    descricao TEXT,
    ordem INT DEFAULT 0,
    ativo BOOLEAN DEFAULT TRUE,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS usuario_filas (
    usuario_id INT REFERENCES usuarios(id) ON DELETE CASCADE,
    fila_id INT REFERENCES filas(id) ON DELETE CASCADE,
    PRIMARY KEY (usuario_id, fila_id)
  );

  -- Tags
  CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(50) UNIQUE NOT NULL,
    cor VARCHAR(7) DEFAULT '#6B7280',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS ticket_tags (
    ticket_id INT REFERENCES tickets(id) ON DELETE CASCADE,
    tag_id INT REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (ticket_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS contato_tags (
    contato_id INT REFERENCES contatos(id) ON DELETE CASCADE,
    tag_id INT REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (contato_id, tag_id)
  );

  -- Respostas rápidas
  CREATE TABLE IF NOT EXISTS respostas_rapidas (
    id SERIAL PRIMARY KEY,
    atalho VARCHAR(50) UNIQUE NOT NULL,
    titulo VARCHAR(200) NOT NULL,
    corpo TEXT NOT NULL,
    media_url TEXT,
    fila_id INT REFERENCES filas(id) ON DELETE SET NULL,
    criado_por INT REFERENCES usuarios(id),
    criado_em TIMESTAMPTZ DEFAULT NOW()
  );

  -- Auditoria
  CREATE TABLE IF NOT EXISTS auditoria (
    id SERIAL PRIMARY KEY,
    usuario_id INT REFERENCES usuarios(id),
    acao VARCHAR(100) NOT NULL,
    entidade VARCHAR(50),
    entidade_id INT,
    dados_anteriores JSONB,
    dados_novos JSONB,
    ip VARCHAR(45),
    criado_em TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_auditoria_criado ON auditoria(criado_em DESC);

  -- Horários de funcionamento
  CREATE TABLE IF NOT EXISTS horarios_funcionamento (
    id SERIAL PRIMARY KEY,
    dia_semana INT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
    hora_inicio TIME NOT NULL,
    hora_fim TIME NOT NULL,
    ativo BOOLEAN DEFAULT TRUE
  );

  -- Configurações do sistema
  CREATE TABLE IF NOT EXISTS configuracoes (
    chave VARCHAR(100) PRIMARY KEY,
    valor TEXT NOT NULL,
    descricao TEXT,
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  );

  -- Refresh tokens revogados (blacklist)
  CREATE TABLE IF NOT EXISTS refresh_tokens_revogados (
    id SERIAL PRIMARY KEY,
    token_hash VARCHAR(255) NOT NULL,
    revogado_em TIMESTAMPTZ DEFAULT NOW(),
    expira_em TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_refresh_revogados_hash ON refresh_tokens_revogados(token_hash);
`;

async function initQueuesTables(pool) {
  try {
    await pool.query(SQL);
    logger.info('[Migration] Tabelas auxiliares criadas/verificadas (filas, tags, auditoria, etc)');
  } catch (err) {
    logger.error({ err }, '[Migration] Falha ao criar tabelas auxiliares');
    throw err;
  }
}

module.exports = { initQueuesTables };
