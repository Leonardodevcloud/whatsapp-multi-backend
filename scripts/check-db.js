const { Pool } = require('pg');
const p = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_yIwfo4mxcO3t@ep-nameless-salad-an7d95nx-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  const users = await p.query('SELECT id, nome, email, perfil FROM usuarios');
  console.log('USUARIOS:', users.rows);

  const tables = await p.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
  console.log('TABELAS:', tables.rows.map(x => x.table_name));

  // Testar login query exato
  try {
    const login = await p.query("SELECT id, nome, email, senha_hash, perfil, ativo FROM usuarios WHERE email = 'admin@centraltutts.com'");
    console.log('LOGIN QUERY:', login.rows);
  } catch (e) {
    console.log('LOGIN ERRO:', e.message);
  }

  await p.end();
}
check().catch(e => { console.error('ERRO:', e.message); p.end(); });
