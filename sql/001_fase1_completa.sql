-- ============================================================
-- WHATSAPP MULTI-ATENDIMENTO — SQL COMPLETO (FASE 1)
-- Executar manualmente no Neon antes do primeiro deploy
-- ============================================================

-- Usuários (atendentes e admins)
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

-- Sessão WhatsApp (persistência do auth state do Baileys)
CREATE TABLE IF NOT EXISTS whatsapp_sessoes (
    id SERIAL PRIMARY KEY,
    sessao_id VARCHAR(100) UNIQUE NOT NULL,
    dados JSONB NOT NULL,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_sessoes_id ON whatsapp_sessoes(sessao_id);

-- Contatos (quem manda mensagem)
CREATE TABLE IF NOT EXISTS contatos (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(200),
    telefone VARCHAR(20) UNIQUE NOT NULL,
    avatar_url TEXT,
    email VARCHAR(200),
    notas TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contatos_telefone ON contatos(telefone);

-- Filas de atendimento (setores)
CREATE TABLE IF NOT EXISTS filas (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    cor VARCHAR(7) DEFAULT '#7C3AED',
    descricao TEXT,
    ordem INT DEFAULT 0,
    ativo BOOLEAN DEFAULT TRUE,
    criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Relação N:N usuários <-> filas
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

-- Tickets
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

-- Mensagens
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

-- Tags de tickets e contatos
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

-- ============================================================
-- SEED: Horários de funcionamento padrão (Seg-Sex 08:00-19:00)
-- ============================================================
INSERT INTO horarios_funcionamento (dia_semana, hora_inicio, hora_fim, ativo) VALUES
  (1, '08:00', '19:00', TRUE),  -- Segunda
  (2, '08:00', '19:00', TRUE),  -- Terça
  (3, '08:00', '19:00', TRUE),  -- Quarta
  (4, '08:00', '19:00', TRUE),  -- Quinta
  (5, '08:00', '19:00', TRUE),  -- Sexta
  (6, '08:00', '13:00', TRUE),  -- Sábado
  (0, '00:00', '00:00', FALSE)  -- Domingo (inativo)
ON CONFLICT DO NOTHING;

-- ============================================================
-- SEED: Configurações padrão
-- ============================================================
INSERT INTO configuracoes (chave, valor, descricao) VALUES
  ('distribuicao_tickets', 'menos_tickets', 'Modo de distribuição: round_robin, menos_tickets, manual'),
  ('tempo_reabrir_ticket_min', '120', 'Tempo em minutos para reabrir ticket do mesmo contato'),
  ('mensagem_fora_horario', 'Olá! No momento estamos fora do horário de atendimento. Retornaremos em breve.', 'Mensagem automática fora do horário'),
  ('mensagem_boas_vindas', 'Olá! Seja bem-vindo ao nosso atendimento. Em breve um de nossos atendentes irá te ajudar.', 'Mensagem de boas-vindas para novos contatos'),
  ('ia_ativa', 'false', 'Ativar/desativar sugestões de IA'),
  ('ia_modelo', 'claude-haiku', 'Modelo de IA para sugestões'),
  ('ia_system_prompt', 'Você é um assistente de atendimento ao cliente profissional e empático. Sua empresa opera no setor de logística e entregas. Responda de forma clara, educada e objetiva em português brasileiro.', 'System prompt customizável para a IA')
ON CONFLICT (chave) DO NOTHING;

-- Índice para busca full-text em mensagens (melhora ILIKE)
CREATE INDEX IF NOT EXISTS idx_mensagens_corpo_trgm ON mensagens USING gin (corpo gin_trgm_ops);
-- NOTA: requer extensão pg_trgm. Execute: CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- SEED: Fila padrão
-- ============================================================
INSERT INTO filas (nome, cor, descricao, ordem) VALUES
  ('Geral', '#7C3AED', 'Fila padrão de atendimento', 0)
ON CONFLICT DO NOTHING;
