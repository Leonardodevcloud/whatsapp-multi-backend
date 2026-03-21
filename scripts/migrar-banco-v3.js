// scripts/migrar-banco-v3.js
// Migração EXATA baseada no schema real — 17 tabelas
// Uso: node scripts/migrar-banco-v3.js

const { Pool } = require('pg');

const ORIGEM = 'postgresql://neondb_owner:npg_Emo9Y6pwfgBI@ep-muddy-star-acnlj99x-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require';
const DESTINO = 'postgresql://neondb_owner:npg_yIwfo4mxcO3t@ep-nameless-salad-an7d95nx-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require';

const poolOrigem = new Pool({ connectionString: ORIGEM, ssl: { rejectUnauthorized: false }, max: 2 });
const poolDestino = new Pool({ connectionString: DESTINO, ssl: { rejectUnauthorized: false }, max: 2 });

// Ordem de DELEÇÃO (reversa — filhos primeiro)
const ORDEM_DELETE = [
  'auditoria', 'contato_tags', 'ticket_tags', 'usuario_filas',
  'mensagens', 'stickers_galeria', 'tickets',
  'respostas_rapidas', 'refresh_tokens_revogados', 'whatsapp_sessoes',
  'horarios_funcionamento', 'motivos_atendimento', 'configuracoes',
  'tags', 'filas', 'contatos', 'usuarios',
];

// Ordem de INSERÇÃO (pais primeiro)
// Cada entrada: { tabela, pk (pra sequence reset), orderBy (pra INSERT ordenado) }
const TABELAS = [
  { tabela: 'usuarios', pk: 'id', orderBy: 'id' },
  { tabela: 'contatos', pk: 'id', orderBy: 'id' },
  { tabela: 'filas', pk: 'id', orderBy: 'id' },
  { tabela: 'tags', pk: 'id', orderBy: 'id' },
  { tabela: 'configuracoes', pk: null, orderBy: 'chave' },
  { tabela: 'motivos_atendimento', pk: 'id', orderBy: 'id' },
  { tabela: 'horarios_funcionamento', pk: 'id', orderBy: 'id' },
  { tabela: 'refresh_tokens_revogados', pk: 'id', orderBy: 'id' },
  { tabela: 'whatsapp_sessoes', pk: 'id', orderBy: 'id' },
  { tabela: 'respostas_rapidas', pk: 'id', orderBy: 'id' },
  { tabela: 'stickers_galeria', pk: 'id', orderBy: 'id' },
  { tabela: 'tickets', pk: 'id', orderBy: 'id' },
  { tabela: 'mensagens', pk: 'id', orderBy: 'id' },
  { tabela: 'usuario_filas', pk: null, orderBy: 'usuario_id' },
  { tabela: 'ticket_tags', pk: null, orderBy: 'ticket_id' },
  { tabela: 'contato_tags', pk: null, orderBy: 'contato_id' },
  { tabela: 'auditoria', pk: 'id', orderBy: 'id' },
];

async function migrar() {
  console.log('🚀 Migração v3 — schema exato\n');

  await poolOrigem.query('SELECT 1');
  console.log('✅ Origem (BR) OK');
  await poolDestino.query('SELECT 1');
  console.log('✅ Destino (US) OK\n');

  // 1. Criar todas as tabelas no destino (DDL exato)
  console.log('📦 Criando schema no destino...');
  const DDL = getDDL();
  for (const sql of DDL) {
    try { await poolDestino.query(sql); } catch (e) {
      if (!e.message.includes('already exists')) console.warn('  ⚠️', e.message.substring(0, 100));
    }
  }
  console.log('  ✅ Schema pronto\n');

  // 2. Limpar destino (ordem reversa pra FKs)
  console.log('🧹 Limpando destino...');
  for (const t of ORDEM_DELETE) {
    try { await poolDestino.query(`DELETE FROM ${t}`); } catch (_) {}
  }
  console.log('  ✅ Limpo\n');

  // 3. Migrar dados
  console.log('📋 Migrando dados...\n');
  let totalGeral = 0;

  for (const { tabela, pk, orderBy } of TABELAS) {
    const inicio = Date.now();

    // Contar
    const { rows: [{ total }] } = await poolOrigem.query(`SELECT COUNT(*) as total FROM ${tabela}`);
    const count = parseInt(total);
    if (count === 0) { console.log(`  ⏭️  ${tabela}: vazia`); continue; }

    // Pegar colunas da ORIGEM
    const { rows: colRows } = await poolOrigem.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [tabela]
    );
    const colunas = colRows.map(r => r.column_name);
    const colList = colunas.join(', ');

    // Buscar todos os dados
    const { rows: allRows } = await poolOrigem.query(`SELECT ${colList} FROM ${tabela} ORDER BY ${orderBy}`);

    // Inserir em batches de 50
    let inserted = 0;
    const BATCH = 50;

    for (let i = 0; i < allRows.length; i += BATCH) {
      const batch = allRows.slice(i, i + BATCH);
      const allValues = [];
      const rowPlaceholders = [];
      let idx = 1;

      for (const row of batch) {
        const ph = [];
        for (const col of colunas) {
          allValues.push(row[col]);
          ph.push(`$${idx++}`);
        }
        rowPlaceholders.push(`(${ph.join(',')})`);
      }

      try {
        await poolDestino.query(
          `INSERT INTO ${tabela} (${colList}) VALUES ${rowPlaceholders.join(',')} ON CONFLICT DO NOTHING`,
          allValues
        );
        inserted += batch.length;
      } catch (batchErr) {
        // Fallback: 1 por 1
        for (const row of batch) {
          try {
            const vals = colunas.map(c => row[c]);
            const ph = colunas.map((_, j) => `$${j + 1}`).join(',');
            await poolDestino.query(`INSERT INTO ${tabela} (${colList}) VALUES (${ph}) ON CONFLICT DO NOTHING`, vals);
            inserted++;
          } catch (_) {}
        }
      }

      // Progress a cada 500
      if (inserted > 0 && inserted % 500 === 0) {
        process.stdout.write(`  ${tabela}: ${inserted}/${count}...\r`);
      }
    }

    // Reset sequence se tem PK serial
    if (pk) {
      try {
        await poolDestino.query(`SELECT setval(pg_get_serial_sequence('${tabela}', '${pk}'), COALESCE((SELECT MAX(${pk}) FROM ${tabela}), 1))`);
      } catch (_) {}
    }

    totalGeral += inserted;
    const seg = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log(`  ✅ ${tabela}: ${inserted}/${count} (${seg}s)`);
  }

  console.log(`\n🏁 Migração concluída! ${totalGeral} registros migrados`);
  console.log('\n📌 Próximo passo — trocar DATABASE_URL no Railway:');
  console.log('   postgresql://neondb_owner:npg_yIwfo4mxcO3t@ep-nameless-salad-an7d95nx-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require');

  await poolOrigem.end();
  await poolDestino.end();
}

function getDDL() {
  return [
    // 1. Sem dependências
    `CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(100) NOT NULL,
      email VARCHAR(150) NOT NULL UNIQUE,
      senha_hash VARCHAR(255) NOT NULL,
      perfil VARCHAR(20) DEFAULT 'atendente',
      avatar_url TEXT,
      online BOOLEAN DEFAULT FALSE,
      max_tickets_simultaneos INT DEFAULT 5,
      ativo BOOLEAN DEFAULT TRUE,
      ultimo_acesso TIMESTAMPTZ,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS contatos (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(200),
      telefone VARCHAR(50) NOT NULL UNIQUE,
      avatar_url TEXT,
      email VARCHAR(200),
      notas TEXT,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW(),
      lid VARCHAR(50)
    )`,
    `CREATE TABLE IF NOT EXISTS filas (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(100) NOT NULL,
      cor VARCHAR(7) DEFAULT '#7C3AED',
      descricao TEXT,
      ordem INT DEFAULT 0,
      ativo BOOLEAN DEFAULT TRUE,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS tags (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(50) NOT NULL,
      cor VARCHAR(7) DEFAULT '#6B7280',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS configuracoes (
      chave VARCHAR(100) PRIMARY KEY,
      valor TEXT NOT NULL,
      descricao TEXT,
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS motivos_atendimento (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(200) NOT NULL,
      ativo BOOLEAN DEFAULT TRUE,
      ordem INT DEFAULT 0,
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS horarios_funcionamento (
      id SERIAL PRIMARY KEY,
      dia_semana INT NOT NULL,
      hora_inicio TIME NOT NULL,
      hora_fim TIME NOT NULL,
      ativo BOOLEAN DEFAULT TRUE
    )`,
    `CREATE TABLE IF NOT EXISTS refresh_tokens_revogados (
      id SERIAL PRIMARY KEY,
      token_hash VARCHAR(255) NOT NULL,
      revogado_em TIMESTAMPTZ DEFAULT NOW(),
      expira_em TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS whatsapp_sessoes (
      id SERIAL PRIMARY KEY,
      sessao_id VARCHAR(100) NOT NULL,
      dados JSONB NOT NULL,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    )`,
    // 2. Com FKs
    `CREATE TABLE IF NOT EXISTS respostas_rapidas (
      id SERIAL PRIMARY KEY,
      atalho VARCHAR(50) NOT NULL,
      titulo VARCHAR(200) NOT NULL,
      corpo TEXT NOT NULL,
      media_url TEXT,
      fila_id INT REFERENCES filas(id) ON DELETE SET NULL,
      criado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      media_tipo VARCHAR(20)
    )`,
    `CREATE TABLE IF NOT EXISTS stickers_galeria (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      recebido_de INT,
      ticket_id INT,
      usado_em TIMESTAMPTZ DEFAULT NOW(),
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      favorito BOOLEAN DEFAULT TRUE
    )`,
    `CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      contato_id INT REFERENCES contatos(id) ON DELETE SET NULL,
      fila_id INT REFERENCES filas(id) ON DELETE SET NULL,
      usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
      status VARCHAR(20) DEFAULT 'pendente',
      protocolo VARCHAR(20),
      assunto VARCHAR(300),
      prioridade VARCHAR(10) DEFAULT 'normal',
      ultima_mensagem_em TIMESTAMPTZ,
      ultima_mensagem_preview TEXT,
      is_bot BOOLEAN DEFAULT FALSE,
      avaliacao INT,
      tempo_primeira_resposta_seg INT,
      tempo_resolucao_seg INT,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW(),
      fechado_em TIMESTAMPTZ,
      motivo_fechamento_id INT,
      motivo_fechamento_texto VARCHAR(500)
    )`,
    `CREATE TABLE IF NOT EXISTS mensagens (
      id SERIAL PRIMARY KEY,
      ticket_id INT REFERENCES tickets(id) ON DELETE CASCADE,
      contato_id INT REFERENCES contatos(id) ON DELETE SET NULL,
      usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
      corpo TEXT,
      tipo VARCHAR(20) DEFAULT 'texto',
      media_url TEXT,
      media_tipo VARCHAR(50),
      media_nome VARCHAR(255),
      wa_message_id VARCHAR(100),
      is_from_me BOOLEAN DEFAULT FALSE,
      is_internal BOOLEAN DEFAULT FALSE,
      status_envio VARCHAR(20) DEFAULT 'enviada',
      quoted_message_id INT,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      nome_participante VARCHAR(200),
      atualizado_em TIMESTAMPTZ,
      reacao VARCHAR(10),
      deletada BOOLEAN DEFAULT FALSE,
      deletada_por VARCHAR(20)
    )`,
    `CREATE TABLE IF NOT EXISTS usuario_filas (
      usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      fila_id INT NOT NULL REFERENCES filas(id) ON DELETE CASCADE,
      PRIMARY KEY (usuario_id, fila_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_tags (
      ticket_id INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      tag_id INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (ticket_id, tag_id)
    )`,
    `CREATE TABLE IF NOT EXISTS contato_tags (
      contato_id INT NOT NULL REFERENCES contatos(id) ON DELETE CASCADE,
      tag_id INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (contato_id, tag_id)
    )`,
    `CREATE TABLE IF NOT EXISTS auditoria (
      id SERIAL PRIMARY KEY,
      usuario_id INT,
      acao VARCHAR(100) NOT NULL,
      entidade VARCHAR(50),
      entidade_id INT,
      dados_anteriores JSONB,
      dados_novos JSONB,
      ip VARCHAR(45),
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )`,
  ];
}

migrar().catch(err => { console.error('❌', err.message); process.exit(1); });
