const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { dbConfig } = require('../config/db');

async function initializeDatabase() {
    let connection;
    try {
        console.log(`[InitDB] Conectando a MySQL/TiDB en ${dbConfig.host}:${dbConfig.port} con usuario "${dbConfig.user}"...`);
        connection = await mysql.createConnection({
            host: dbConfig.host,
            port: dbConfig.port,
            user: dbConfig.user,
            password: dbConfig.password,
            ssl: dbConfig.ssl,
            multipleStatements: true
        });

        const schemaPath = path.join(__dirname, 'schema.sql');
        const sql = fs.readFileSync(schemaPath, 'utf8');

        console.log('[InitDB] Ejecutando script schema.sql...');
        await connection.query(sql);

        console.log(`[InitDB] Base de datos "${dbConfig.database}" y tablas ("alumnos", "asistencias") listas.`);
    } catch (error) {
        console.error('[InitDB] Error al inicializar la base de datos:', error.message);
        process.exitCode = 1;
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

if (require.main === module) {
    initializeDatabase();
}

module.exports = initializeDatabase;
