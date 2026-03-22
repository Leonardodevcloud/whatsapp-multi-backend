// Migration — módulo IA (inteligência artificial com aprendizado)
// Tabelas: ia_instrucoes, ia_conhecimento, ia_exemplos, ia_tags_regras

const { query } = require('../../config/database');
const logger = require('../../shared/logger');

async function initIATables() {
  try {
    // Instruções gerais (tom de voz, regras, persona)
    await query(`
      CREATE TABLE IF NOT EXISTS ia_instrucoes (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(200) NOT NULL,
        conteudo TEXT NOT NULL,
        ativo BOOLEAN DEFAULT TRUE,
        ordem INT DEFAULT 0,
        criado_em TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Base de conhecimento (FAQ, produtos, procedimentos)
    await query(`
      CREATE TABLE IF NOT EXISTS ia_conhecimento (
        id SERIAL PRIMARY KEY,
        categoria VARCHAR(100),
        pergunta TEXT NOT NULL,
        resposta TEXT NOT NULL,
        ativo BOOLEAN DEFAULT TRUE,
        criado_em TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Exemplos aprendidos de tickets fechados
    await query(`
      CREATE TABLE IF NOT EXISTS ia_exemplos (
        id SERIAL PRIMARY KEY,
        ticket_id INT,
        pergunta_contato TEXT NOT NULL,
        resposta_atendente TEXT NOT NULL,
        qualidade INT DEFAULT 3 CHECK (qualidade BETWEEN 1 AND 5),
        tag VARCHAR(100),
        aprovado BOOLEAN DEFAULT FALSE,
        rejeitado BOOLEAN DEFAULT FALSE,
        origem VARCHAR(50) DEFAULT 'auto',
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Regras de classificação de tags
    await query(`
      CREATE TABLE IF NOT EXISTS ia_tags_regras (
        id SERIAL PRIMARY KEY,
        tag VARCHAR(100) NOT NULL,
        palavras_chave TEXT NOT NULL,
        descricao TEXT,
        cor VARCHAR(20) DEFAULT '#7c3aed',
        ativo BOOLEAN DEFAULT TRUE,
        acertos INT DEFAULT 0,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Índices
    await query(`CREATE INDEX IF NOT EXISTS idx_ia_exemplos_aprovado ON ia_exemplos(aprovado) WHERE aprovado = TRUE`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ia_exemplos_tag ON ia_exemplos(tag)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ia_exemplos_qualidade ON ia_exemplos(qualidade DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ia_conhecimento_categoria ON ia_conhecimento(categoria)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ia_tags_regras_ativo ON ia_tags_regras(ativo) WHERE ativo = TRUE`);

    // Configurações da IA (toggles)
    await query(`
      CREATE TABLE IF NOT EXISTS ia_config (
        chave VARCHAR(100) PRIMARY KEY,
        valor VARCHAR(500) NOT NULL DEFAULT 'false',
        descricao VARCHAR(300),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Seed configs padrão
    const configs = [
      ['auto_resposta_ativa', 'false', 'IA responde automaticamente quando tem alta confiança'],
      ['auto_resposta_grupos', 'false', 'Permitir resposta automática em grupos'],
      ['detectar_urgencia', 'true', 'Detectar mensagens urgentes e priorizar chamado'],
      ['resumo_diario', 'true', 'Enviar resumo diário da operação às 19h'],
      ['resumo_diario_telefone', '', 'Telefone/grupo para enviar resumo diário'],
    ];
    for (const [chave, valor, descricao] of configs) {
      await query(`INSERT INTO ia_config (chave, valor, descricao) VALUES ($1, $2, $3) ON CONFLICT (chave) DO NOTHING`, [chave, valor, descricao]);
    }

    logger.info('[IA] Tabelas criadas/verificadas');
  } catch (err) {
    logger.error({ err: err.message }, '[IA] Erro na migration');
  }
}

module.exports = { initIATables };
