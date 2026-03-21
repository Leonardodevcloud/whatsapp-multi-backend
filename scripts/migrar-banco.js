// scripts/migrar-banco.js
// Migra todos os dados do Neon BR → Neon US sem precisar de pg_dump
// Uso: node scripts/migrar-banco.js

const { Pool } = require('pg');

const ORIGEM = 'postgresql://neondb_owner:npg_Emo9Y6pwfgBI@ep-muddy-star-acnlj99x-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require';
const DESTINO = 'postgresql://neondb_owner:npg_yIwfo4mxcO3t@ep-nameless-salad-an7d95nx-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require';

const poolOrigem = new Pool({ connectionString: ORIGEM, ssl: { rejectUnauthorized: false }, max: 3 });
const poolDestino = new Pool({ connectionString: DESTINO, ssl: { rejectUnauthorized: false }, max: 3 });

// Ordem de criação — respeita foreign keys
const TABELAS_DDL = [
  // 1. Tabelas sem dependências
  `CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    email VARCHAR(200) UNIQUE NOT NULL,
    senha VARCHAR(200) NOT NULL,
    perfil VARCHAR(20) DEFAULT 'atendente',
    cargo VARCHAR(100),
    avatar_url TEXT,
    online BOOLEAN DEFAULT FALSE,
    ativo BOOLEAN DEFAULT TRUE,
    max_tickets_simultaneos INT DEFAULT 10,
    refresh_token TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS contatos (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(200),
    telefone VARCHAR(20) UNIQUE NOT NULL,
    avatar_url TEXT,
    email VARCHAR(200),
    notas TEXT,
    lid VARCHAR(50),
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS filas (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    cor VARCHAR(10) DEFAULT '#7c3aed',
    ativo BOOLEAN DEFAULT TRUE,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(50) NOT NULL,
    cor VARCHAR(10) DEFAULT '#7c3aed',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS respostas_rapidas (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(100) NOT NULL,
    atalho VARCHAR(50) NOT NULL,
    mensagem TEXT NOT NULL,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS configuracoes (
    id SERIAL PRIMARY KEY,
    chave VARCHAR(100) UNIQUE NOT NULL,
    valor TEXT,
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS motivos_atendimento (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    ativo BOOLEAN DEFAULT TRUE,
    ordem INT DEFAULT 0,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS stickers_galeria (
    id SERIAL PRIMARY KEY,
    url TEXT UNIQUE NOT NULL,
    usado_em TIMESTAMPTZ DEFAULT NOW()
  )`,
  // 2. Tabelas com foreign keys
  `CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY,
    contato_id INT REFERENCES contatos(id) ON DELETE SET NULL,
    fila_id INT REFERENCES filas(id) ON DELETE SET NULL,
    usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
    status VARCHAR(20) DEFAULT 'pendente',
    protocolo VARCHAR(20) UNIQUE,
    assunto VARCHAR(300),
    prioridade VARCHAR(10) DEFAULT 'normal',
    ultima_mensagem_em TIMESTAMPTZ,
    ultima_mensagem_preview TEXT,
    is_bot BOOLEAN DEFAULT FALSE,
    avaliacao INT,
    tempo_primeira_resposta_seg INT,
    tempo_resolucao_seg INT,
    motivo_fechamento_id INT,
    motivo_fechamento_texto TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW(),
    fechado_em TIMESTAMPTZ
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
    nome_participante VARCHAR(200),
    reacao VARCHAR(10),
    deletada BOOLEAN DEFAULT FALSE,
    deletada_por VARCHAR(20),
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS usuario_filas (
    id SERIAL PRIMARY KEY,
    usuario_id INT REFERENCES usuarios(id) ON DELETE CASCADE,
    fila_id INT REFERENCES filas(id) ON DELETE CASCADE,
    UNIQUE(usuario_id, fila_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ticket_tags (
    id SERIAL PRIMARY KEY,
    ticket_id INT REFERENCES tickets(id) ON DELETE CASCADE,
    tag_id INT REFERENCES tags(id) ON DELETE CASCADE,
    UNIQUE(ticket_id, tag_id)
  )`,
  `CREATE TABLE IF NOT EXISTS contato_tags (
    id SERIAL PRIMARY KEY,
    contato_id INT REFERENCES contatos(id) ON DELETE CASCADE,
    tag_id INT REFERENCES tags(id) ON DELETE CASCADE,
    UNIQUE(contato_id, tag_id)
  )`,
  `CREATE TABLE IF NOT EXISTS auditoria (
    id SERIAL PRIMARY KEY,
    usuario_id INT,
    acao VARCHAR(100),
    entidade VARCHAR(50),
    entidade_id INT,
    dados_anteriores JSONB,
    dados_novos JSONB,
    ip VARCHAR(45),
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`,
];

// Tabelas na ordem de migração (respeita FKs)
const TABELAS_DADOS = [
  'usuarios',
  'contatos',
  'filas',
  'tags',
  'respostas_rapidas',
  'configuracoes',
  'motivos_atendimento',
  'stickers_galeria',
  'tickets',
  'mensagens',
  'usuario_filas',
  'ticket_tags',
  'contato_tags',
  'auditoria',
];

async function migrar() {
  console.log('🚀 Migrando banco Neon BR → Neon US...\n');

  // 1. Testar conexões
  try {
    const r1 = await poolOrigem.query('SELECT NOW()');
    console.log('✅ Origem (BR) conectado:', r1.rows[0].now);
  } catch (err) {
    console.error('❌ Erro ao conectar na origem:', err.message);
    process.exit(1);
  }

  try {
    const r2 = await poolDestino.query('SELECT NOW()');
    console.log('✅ Destino (US) conectado:', r2.rows[0].now);
  } catch (err) {
    console.error('❌ Erro ao conectar no destino:', err.message);
    process.exit(1);
  }

  // 2. Criar tabelas no destino
  console.log('\n📦 Criando tabelas no destino...');
  for (const ddl of TABELAS_DDL) {
    try {
      await poolDestino.query(ddl);
    } catch (err) {
      // Tabela pode já existir com schema diferente — ok
      console.warn('  ⚠️', err.message.substring(0, 80));
    }
  }
  console.log('  ✅ Tabelas criadas/verificadas');

  // 3. Migrar dados tabela por tabela
  console.log('\n📋 Migrando dados...\n');
  let totalRows = 0;

  for (const tabela of TABELAS_DADOS) {
    try {
      // Contar registros na origem
      const countResult = await poolOrigem.query(`SELECT COUNT(*) as total FROM ${tabela}`);
      const total = parseInt(countResult.rows[0].total);

      if (total === 0) {
        console.log(`  ⏭️  ${tabela}: vazia, pulando`);
        continue;
      }

      // Buscar colunas existentes no destino
      const colsDestino = await poolDestino.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [tabela]
      );
      const colunasDestino = new Set(colsDestino.rows.map(r => r.column_name));

      // Buscar colunas existentes na origem
      const colsOrigem = await poolOrigem.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [tabela]
      );
      // Usar apenas colunas que existem em AMBOS
      const colunas = colsOrigem.rows
        .map(r => r.column_name)
        .filter(c => colunasDestino.has(c));

      if (colunas.length === 0) {
        console.log(`  ⚠️  ${tabela}: nenhuma coluna em comum`);
        continue;
      }

      const colList = colunas.join(', ');

      // Limpar tabela destino (TRUNCATE com CASCADE pra evitar FK errors)
      await poolDestino.query(`TRUNCATE ${tabela} CASCADE`);

      // Migrar em lotes de 500
      const BATCH = 500;
      let offset = 0;
      let migrados = 0;

      while (offset < total) {
        const rows = await poolOrigem.query(
          `SELECT ${colList} FROM ${tabela} ORDER BY id LIMIT ${BATCH} OFFSET ${offset}`
        );

        if (rows.rows.length === 0) break;

        // Montar INSERT em batch
        for (const row of rows.rows) {
          const valores = colunas.map(c => row[c]);
          const placeholders = colunas.map((_, i) => `$${i + 1}`).join(', ');

          try {
            await poolDestino.query(
              `INSERT INTO ${tabela} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
              valores
            );
            migrados++;
          } catch (err) {
            // Ignorar erros de FK ou constraint — dados podem estar inconsistentes
          }
        }

        offset += BATCH;
      }

      // Atualizar sequence do ID
      try {
        await poolDestino.query(
          `SELECT setval(pg_get_serial_sequence('${tabela}', 'id'), COALESCE((SELECT MAX(id) FROM ${tabela}), 1))`
        );
      } catch (_) {}

      totalRows += migrados;
      console.log(`  ✅ ${tabela}: ${migrados}/${total} registros`);
    } catch (err) {
      console.error(`  ❌ ${tabela}: ${err.message}`);
    }
  }

  console.log(`\n🏁 Migração concluída! Total: ${totalRows} registros migrados`);
  console.log('\n📌 Próximo passo: trocar DATABASE_URL no Railway para a nova URL US');

  await poolOrigem.end();
  await poolDestino.end();
  process.exit(0);
}

migrar().catch(err => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});
