const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// Cargar variables del archivo .env sin requerir dependencias externas
function loadEnv() {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;

    if (typeof process.loadEnvFile === 'function') {
        try {
            process.loadEnvFile(envPath);
            return;
        } catch (_) {
            // Fallback al parser manual si falla
        }
    }

    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (!(key in process.env)) {
            process.env[key] = val;
        }
    }
}

loadEnv();

const dbHost = process.env.DB_HOST || '127.0.0.1';
// Activa SSL automáticamente si DB_SSL=true o si el host es de TiDB Cloud (*.tidbcloud.com)
const useSsl =
    String(process.env.DB_SSL || '').toLowerCase() === 'true' ||
    dbHost.includes('tidbcloud.com');

const dbConfig = {
    host: dbHost,
    port: Number(process.env.DB_PORT) || (dbHost.includes('tidbcloud.com') ? 4000 : 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '1234',
    database: process.env.DB_NAME || 'siga_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ...(useSsl
        ? {
              ssl: {
                  minVersion: 'TLSv1.2',
                  rejectUnauthorized: true
              }
          }
        : {})
};

const pool = mysql.createPool(dbConfig);

/**
 * Verifica la conexión inicial con MySQL / TiDB Cloud
 */
async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log(
            `[MySQL/TiDB] Conectado exitosamente a "${dbConfig.database}" en ${dbConfig.host}:${dbConfig.port} (SSL: ${useSsl ? 'Activo' : 'Inactivo'})`
        );
        connection.release();
        return true;
    } catch (error) {
        console.error(`[MySQL/TiDB] Error al conectar con la base de datos (${dbConfig.database}):`, error.message);
        console.error('             Verifica tus variables DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME y DB_SSL.');
        return false;
    }
}

module.exports = {
    pool,
    dbConfig,
    testConnection
};
