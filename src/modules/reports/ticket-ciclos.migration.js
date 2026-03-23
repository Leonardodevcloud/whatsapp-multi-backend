// src/modules/reports/ticket-ciclos.migration.js
// Tabela que registra cada ciclo de atendimento (abertura→fechamento)
// Backfill automático a partir das mensagens de sistema existentes

const logger = require('../../shared/logger');

async function initTicketCiclosTables(pool) {
  try {
    // 1. Criar tabela
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticket_ciclos (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL,
        usuario_id INTEGER,
        contato_id INTEGER,
        fila_id INTEGER,
        aberto_em TIMESTAMPTZ NOT NULL,
        fechado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        tempo_primeira_resposta_seg INTEGER,
        tempo_resolucao_seg INTEGER,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tc_ticket_id ON ticket_ciclos(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_tc_usuario_id ON ticket_ciclos(usuario_id);
      CREATE INDEX IF NOT EXISTS idx_tc_fechado_em ON ticket_ciclos(fechado_em);
      CREATE INDEX IF NOT EXISTS idx_tc_aberto_em ON ticket_ciclos(aberto_em);
    `);

    logger.info('[Migration] Tabela ticket_ciclos criada/verificada');

    // 2. Backfill — só roda se tabela está vazia
    const existing = await pool.query(`SELECT COUNT(*) as total FROM ticket_ciclos`);
    if (parseInt(existing.rows[0].total) > 0) return;

    logger.info('[Migration] Iniciando backfill de ticket_ciclos...');

    // Inserir um ciclo para cada mensagem de sistema de fechamento
    // fechado_em = timestamp da mensagem
    // aberto_em = melhor estimativa (timestamp da mensagem anterior de fechamento do mesmo ticket, ou criado_em do ticket)
    await pool.query(`
      WITH fechamentos AS (
        SELECT 
          m.ticket_id,
          m.usuario_id,
          t.contato_id,
          t.fila_id,
          m.criado_em as fechado_em,
          ROW_NUMBER() OVER (PARTITION BY m.ticket_id ORDER BY m.criado_em ASC) as ciclo_num,
          LAG(m.criado_em) OVER (PARTITION BY m.ticket_id ORDER BY m.criado_em ASC) as fechamento_anterior
        FROM mensagens m
        JOIN tickets t ON t.id = m.ticket_id
        WHERE m.tipo = 'sistema'
          AND (m.corpo ILIKE '%finalizou%' OR m.corpo ILIKE '%resolveu%' 
               OR m.corpo ILIKE '%encerrou%' OR m.corpo ILIKE '%fechou%' 
               OR m.corpo ILIKE '%Ticket fechado%')
      )
      INSERT INTO ticket_ciclos (ticket_id, usuario_id, contato_id, fila_id, aberto_em, fechado_em, tempo_primeira_resposta_seg, tempo_resolucao_seg)
      SELECT 
        f.ticket_id,
        f.usuario_id,
        f.contato_id,
        f.fila_id,
        -- Ciclo 1: não sabemos quando abriu exatamente, usar fechado - 1h como placeholder
        -- Ciclos 2+: abriu logo após o fechamento anterior
        CASE 
          WHEN f.ciclo_num = 1 THEN f.fechado_em - INTERVAL '1 hour'
          ELSE f.fechamento_anterior + INTERVAL '1 minute'
        END as aberto_em,
        f.fechado_em,
        NULL as tempo_primeira_resposta_seg,
        NULL as tempo_resolucao_seg
      FROM fechamentos f
      ORDER BY f.ticket_id, f.fechado_em
    `);

    // Para o ciclo mais recente de cada ticket resolvido, preencher TPR/TMA do ticket
    await pool.query(`
      UPDATE ticket_ciclos tc SET
        tempo_primeira_resposta_seg = t.tempo_primeira_resposta_seg,
        tempo_resolucao_seg = t.tempo_resolucao_seg,
        aberto_em = t.criado_em
      FROM tickets t
      WHERE tc.ticket_id = t.id
        AND tc.id = (SELECT MAX(tc2.id) FROM ticket_ciclos tc2 WHERE tc2.ticket_id = t.id)
        AND t.status IN ('resolvido', 'fechado')
    `);

    const count = await pool.query(`SELECT COUNT(*) as total FROM ticket_ciclos`);
    logger.info(`[Migration] Backfill concluído: ${count.rows[0].total} ciclos importados`);

  } catch (err) {
    logger.error({ err }, '[Migration] Falha ao criar/popular ticket_ciclos');
    throw err;
  }
}

module.exports = { initTicketCiclosTables };
