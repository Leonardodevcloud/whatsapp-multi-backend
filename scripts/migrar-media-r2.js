// ============================================================
// INSTRUÇÕES DE INTEGRAÇÃO — Cloudflare R2
// ============================================================
//
// 1. INSTALAR DEPENDÊNCIA:
//    npm install @aws-sdk/client-s3
//
// 2. VARIÁVEIS DE AMBIENTE (Railway):
//    R2_ACCOUNT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//    R2_ACCESS_KEY_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//    R2_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//    R2_BUCKET_NAME=synapse-media
//    R2_PUBLIC_URL=https://media.centraltutts.online  (ou R2.dev URL)
//
// 3. NO server.js — ADICIONAR ANTES de inicializar rotas:
//
//    const { inicializarR2 } = require('./config/r2');
//    inicializarR2(); // Se vars não configuradas, opera em modo legado (base64 no banco)
//
// 4. CLOUDFLARE DASHBOARD:
//    a) R2 > Create Bucket > nome: synapse-media
//    b) R2 > synapse-media > Settings > Public Access > Enable (gera URL .r2.dev)
//       OU configure custom domain (ex: media.centraltutts.online)
//    c) R2 > Manage R2 API Tokens > Create Token:
//       - Permissions: Object Read & Write
//       - Bucket: synapse-media
//       - Copie Access Key ID e Secret Access Key
//    d) Account ID está na URL do dashboard: dash.cloudflare.com/<ACCOUNT_ID>
//
// ============================================================

// ============================================================
// SCRIPT DE MIGRAÇÃO — Mover base64 existentes para R2
// Executar UMA VEZ depois de configurar R2:
//   node scripts/migrar-media-r2.js
// ============================================================

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
const crypto = require('crypto');

// Configuração — preencher ou usar env vars
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'synapse-media';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const DATABASE_URL = process.env.DATABASE_URL;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !DATABASE_URL) {
  console.error('Preencha as variáveis: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, DATABASE_URL');
  process.exit(1);
}

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const TIPO_MIME = {
  imagem: 'image/jpeg',
  audio: 'audio/ogg',
  video: 'video/mp4',
  documento: 'application/octet-stream',
  sticker: 'image/webp',
};

const TIPO_EXT = {
  imagem: 'jpg',
  audio: 'ogg',
  video: 'mp4',
  documento: 'bin',
  sticker: 'webp',
};

function detectarMime(base64) {
  const match = base64.match(/^data:([^;]+);base64,/);
  return match ? match[1] : null;
}

function extensaoDoMime(mime) {
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/webm': 'webm',
    'video/mp4': 'mp4', 'video/webm': 'webm',
    'application/pdf': 'pdf',
  };
  return map[mime] || 'bin';
}

async function migrar() {
  console.log('🚀 Iniciando migração de base64 → R2...\n');

  // Buscar mensagens com base64 na media_url
  // Critério: media_url começa com "data:" ou tem mais de 1000 caracteres
  const result = await pool.query(
    `SELECT id, tipo, media_url, criado_em
     FROM mensagens
     WHERE media_url IS NOT NULL
       AND (media_url LIKE 'data:%' OR LENGTH(media_url) > 1000)
     ORDER BY id ASC`
  );

  console.log(`📊 Encontradas ${result.rows.length} mensagens com base64 no banco\n`);

  let migradas = 0;
  let erros = 0;
  let totalBytes = 0;

  for (const msg of result.rows) {
    try {
      const { id, tipo, media_url, criado_em } = msg;

      // Detectar MIME e extensão
      const mimeDetectado = detectarMime(media_url);
      const mime = mimeDetectado || TIPO_MIME[tipo] || 'application/octet-stream';
      const ext = mimeDetectado ? extensaoDoMime(mimeDetectado) : (TIPO_EXT[tipo] || 'bin');

      // Extrair bytes
      const base64Puro = media_url.includes(',') ? media_url.split(',')[1] : media_url;
      const buffer = Buffer.from(base64Puro, 'base64');
      totalBytes += buffer.length;

      // Gerar key baseada na data da mensagem
      const data = new Date(criado_em);
      const ano = data.getFullYear();
      const mes = String(data.getMonth() + 1).padStart(2, '0');
      const hash = crypto.randomBytes(8).toString('hex');
      const key = `media/${ano}/${mes}/${hash}_msg${id}.${ext}`;

      // Upload para R2
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: mime,
      }));

      // Gerar URL pública
      const url = R2_PUBLIC_URL
        ? `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`
        : `https://${R2_BUCKET_NAME}.${R2_ACCOUNT_ID}.r2.dev/${key}`;

      // Atualizar no banco — substituir base64 pela URL
      await pool.query(
        `UPDATE mensagens SET media_url = $1 WHERE id = $2`,
        [url, id]
      );

      migradas++;
      if (migradas % 50 === 0) {
        const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
        console.log(`  ✅ ${migradas}/${result.rows.length} migradas (${totalMB}MB enviados ao R2)`);
      }
    } catch (err) {
      erros++;
      console.error(`  ❌ Erro na mensagem ${msg.id}: ${err.message}`);
    }

    // Rate limit: não sobrecarregar R2
    if (migradas % 10 === 0) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
  console.log(`\n🏁 Migração concluída!`);
  console.log(`   ✅ Migradas: ${migradas}`);
  console.log(`   ❌ Erros: ${erros}`);
  console.log(`   📦 Total enviado ao R2: ${totalMB}MB`);
  console.log(`   💾 Espaço liberado no PostgreSQL: ~${totalMB}MB`);

  // VACUUM pra liberar espaço de verdade no Neon
  console.log('\n🧹 Executando VACUUM ANALYZE para liberar espaço...');
  await pool.query('VACUUM ANALYZE mensagens');
  console.log('   ✅ VACUUM concluído');

  await pool.end();
  process.exit(0);
}

migrar().catch((err) => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});
