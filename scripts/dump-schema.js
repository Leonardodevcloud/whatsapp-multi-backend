// scripts/dump-schema.js
// Mostra schema exato do banco pra gerar migração certeira
const { Pool } = require('pg');
const ORIGEM = 'postgresql://neondb_owner:npg_Emo9Y6pwfgBI@ep-muddy-star-acnlj99x-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require';
const pool = new Pool({ connectionString: ORIGEM, ssl: { rejectUnauthorized: false }, max: 2 });

async function dump() {
  // Listar todas as tabelas
  const tabelas = await pool.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  
  console.log(`=== ${tabelas.rows.length} TABELAS ===\n`);

  for (const { table_name } of tabelas.rows) {
    // Colunas
    const cols = await pool.query(`
      SELECT column_name, data_type, character_maximum_length, column_default, is_nullable
      FROM information_schema.columns 
      WHERE table_schema='public' AND table_name=$1 
      ORDER BY ordinal_position
    `, [table_name]);

    // PK
    const pk = await pool.query(`
      SELECT kcu.column_name FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'
    `, [table_name]);

    // Count
    const count = await pool.query(`SELECT COUNT(*) as total FROM ${table_name}`);

    const pkCols = pk.rows.map(r => r.column_name);
    
    console.log(`--- ${table_name} (${count.rows[0].total} rows, PK: ${pkCols.join(',')||'none'}) ---`);
    for (const c of cols.rows) {
      const tipo = c.character_maximum_length ? `${c.data_type}(${c.character_maximum_length})` : c.data_type;
      console.log(`  ${c.column_name}: ${tipo} ${c.is_nullable==='NO'?'NOT NULL':''} ${c.column_default||''}`);
    }
    console.log('');
  }

  await pool.end();
}
dump().catch(e => { console.error(e.message); process.exit(1); });
