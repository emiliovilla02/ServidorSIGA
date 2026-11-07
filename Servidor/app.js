const http = require('http');
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const { testConnection } = require('./config/db');
const { initWebSocketServer, getConnectedModulesStatus } = require('./sockets/wsManager');

const studentRoutes = require('./routes/studentRoutes');
const attendanceRoutes = require('./routes/attendanceRoutes');

const app = express();
const server = http.createServer(app);

// Inicializar servidor WebSocket (ws) sobre el mismo servidor y puerto HTTP
initWebSocketServer(server);

// Configuración del puerto
const PORT = Number(process.env.PORT) || 3010;
app.set('port', PORT);

// Middlewares globales
app.use(cors()); // Permite peticiones desde React Web, Android, Escritorio y Arduino
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Endpoint de estado / Health check
app.get('/', (req, res) => {
    res.status(200).json({
        proyecto: 'SIGA - Servidor de Gestión de Asistencias (WebSockets + HTTP REST)',
        estado: 'activo',
        websocket_url: `ws://${req.headers.host || `localhost:${PORT}`}`,
        modulos_conectados_ws: getConnectedModulesStatus(),
        eventos_websocket: {
            identificacion: '{ "tipo": "identificar", "modulo": "android | desktop | arduino | web" }',
            flujo_registro_alumno: {
                android_envia_registro: '{ "tipo": "registrar_alumno", "datos": { "numero_control", "nombre_completo", "semestre", "grupo", "chat_id_telegram" } }',
                android_solicita_miqr: '{ "tipo": "solicitar_qr_alumno", "numero_control": "22070319", "chat_id_telegram": "987654321" }',
                desktop_recibe_orden: '{ "tipo": "nuevo_alumno_qr", "alumno": { ... } }',
                desktop_envia_imagen_qr: '{ "tipo": "qr_generado", "numero_control": "22070319", "imagen_qr_base64": "<base64>" }',
                android_recibe_qr_para_telegram: '{ "tipo": "enviar_qr_telegram", "numero_control": "22070319", "chat_id_telegram": "987654321", "imagen_qr_base64": "<base64>" }',
                react_recibe: '{ "tipo": "alumno_registrado", "alumno": { ... } }'
            },
            flujo_asistencia: {
                arduino_envia: 'Trama binaria JPEG o JSON { "tipo": "captura_qr", "imagen": "<base64>" }',
                desktop_recibe: '{ "tipo": "decodificar_foto_qr", "imagen_base64": "<base64>" }',
                desktop_envia_token: '{ "tipo": "verificar_qr", "token": "22070319" }',
                arduino_recibe: '{ "tipo": "resultado_asistencia", "success": true/false, "led": "VERDE | ROJO" }',
                react_recibe: '{ "tipo": "nueva_asistencia", "alumno": { ... }, "asistencia": { ... } }'
            },
            consultas_react: [
                '{ "tipo": "obtener_alumnos" }',
                '{ "tipo": "obtener_asistencias", "filtros": { "fecha": "YYYY-MM-DD", "grupo": "A" } }',
                '{ "tipo": "obtener_estado_modulos" }'
            ]
        },
        endpoints_http: {
            alumnos: '/api/alumnos',
            asistencias: '/api/asistencias'
        }
    });
});

// Rutas HTTP REST (compatibles en paralelo con WebSockets)
app.use('/api/alumnos', studentRoutes);
app.use('/api/asistencias', attendanceRoutes);

// Manejo de rutas no encontradas (404)
app.use((req, res) => {
    res.status(404).json({
        success: false,
        msg: `Ruta no encontrada: ${req.method} ${req.originalUrl}`
    });
});

// Iniciar servidor HTTP + WebSocket
if (require.main === module) {
    server.listen(PORT, '0.0.0.0', async () => {
        console.log(`============================================================`);
        console.log(`[SIGA] Servidor HTTP activo en      http://0.0.0.0:${PORT}`);
        console.log(`[SIGA] Servidor WebSocket activo en ws://0.0.0.0:${PORT}`);
        console.log(`============================================================`);
        await testConnection();
    });
}

module.exports = { app, server };
