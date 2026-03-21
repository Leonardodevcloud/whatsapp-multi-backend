const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const p = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_yIwfo4mxcO3t@ep-nameless-salad-an7d95nx-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function testLogin() {
  console.log('1. Buscando usuario...');
  const user = await p.query("SELECT id, nome, email, senha_hash, perfil, ativo FROM usuarios WHERE email = 'admin@centraltutts.com'");
  console.log('   OK:', user.rows[0]?.nome);

  console.log('2. Comparando senha...');
  const ok = await bcrypt.compare('Tutts@2025', user.rows[0].senha_hash);
  console.log('   Senha OK:', ok);
  if (!ok) {
    const ok2 = await bcrypt.compare('admin123', user.rows[0].senha_hash);
    console.log('   Tentando admin123:', ok2);
  }

  console.log('3. UPDATE ultimo_acesso...');
  try {
    await p.query('UPDATE usuarios SET ultimo_acesso = NOW(), online = TRUE WHERE id = $1', [user.rows[0].id]);
    console.log('   OK');
  } catch (e) { console.log('   ERRO:', e.message); }

  console.log('4. INSERT auditoria...');
  try {
    await p.query(
      "INSERT INTO auditoria (usuario_id, acao, entidade, entidade_id, ip, criado_em) VALUES ($1, 'login', 'usuario', $1, '127.0.0.1', NOW())",
      [user.rows[0].id]
    );
    console.log('   OK');
  } catch (e) { console.log('   ERRO:', e.message); }

  console.log('5. SELECT configuracoes...');
  try {
    const cfg = await p.query('SELECT * FROM configuracoes');
    console.log('   OK:', cfg.rows.length, 'configs');
  } catch (e) { console.log('   ERRO:', e.message); }

  console.log('6. SELECT filas...');
  try {
    const filas = await p.query('SELECT * FROM filas');
    console.log('   OK:', filas.rows.length, 'filas');
  } catch (e) { console.log('   ERRO:', e.message); }

  await p.end();
  console.log('\nTudo OK — o erro deve ser em outro lugar');
}
testLogin().catch(e => { console.error('FALHOU:', e.message); p.end(); });
