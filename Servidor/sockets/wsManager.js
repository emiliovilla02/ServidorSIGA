const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { WebSocketServer, WebSocket } = require('ws');
const sigaService = require('../services/sigaService');

// Directorio para almacenar temporalmente la foto enviada por Arduino
const TEMP_DIR = path.join(__dirname, '..', 'temp_photos');
const TEMP_PHOTO_PATH = path.join(TEMP_DIR, 'captura_qr.jpg');

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

let wss = null;

// Sesión activa de escaneo QR (puede venir de Arduino por WebSocket o por HTTP)
let currentScanSession = null;

/**
 * Normaliza el nombre del módulo para aceptar alias comunes entre compañeros
 */
function normalizeModuleName(raw) {
    const val = String(raw || '').toLowerCase().trim();
    if (['android', 'movil', 'mobile', 'app_android'].includes(val)) return 'android';
    if (['desktop', 'escritorio', 'pc', 'python', 'app_escritorio'].includes(val)) return 'desktop';
    if (['arduino', 'esp32', 'esp32cam', 'camara', 'hardware'].includes(val)) return 'arduino';
    if (['web', 'react', 'frontend', 'dashboard', 'cliente_web'].includes(val)) return 'web';
    return 'desconocido';
}

/**
 * Envía un mensaje JSON de forma segura a un cliente WebSocket
 */
function sendJson(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

/**
 * Envía un mensaje JSON a todos los clientes conectados de uno o varios módulos.
 * Si no hay ningún cliente identificado con ese módulo todavía, lo envía a los
 * clientes marcados como 'desconocido' para facilitar pruebas iniciales.
 */
function broadcastToModules(targetModules, payload, excludeWs = null) {
    if (!wss) return 0;
    const targets = Array.isArray(targetModules) ? targetModules : [targetModules];
    let sentCount = 0;

    for (const client of wss.clients) {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            if (targets.includes('todos') || targets.includes(client.modulo)) {
                sendJson(client, payload);
                sentCount++;
            }
        }
    }

    // Fallback: si se buscaba p. ej. 'desktop' pero el compañero aún no mandó "identificar",
    // enviamos a los clientes con módulo 'desconocido' para que no pierda el mensaje.
    if (sentCount === 0 && !targets.includes('todos')) {
        for (const client of wss.clients) {
            if (client !== excludeWs && client.readyState === WebSocket.OPEN && client.modulo === 'desconocido') {
                sendJson(client, payload);
                sentCount++;
            }
        }
    }

    return sentCount;
}

/**
 * Devuelve un resumen de cuántos clientes de cada módulo están conectados
 */
function getConnectedModulesStatus() {
    const counts = { android: 0, desktop: 0, arduino: 0, web: 0, desconocido: 0 };
    if (wss) {
        for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
                const mod = client.modulo || 'desconocido';
                counts[mod] = (counts[mod] || 0) + 1;
            }
        }
    }
    return counts;
}

/**
 * Limpia el archivo temporal de la foto y reinicia la sesión de escaneo activa
 */
function clearTempSession() {
    if (currentScanSession && currentScanSession.timeoutId) {
        clearTimeout(currentScanSession.timeoutId);
    }
    currentScanSession = null;
    try {
        if (fs.existsSync(TEMP_PHOTO_PATH)) {
            fs.unlinkSync(TEMP_PHOTO_PATH);
        }
    } catch (err) {
        console.warn('[WS/Asistencia] No se pudo eliminar la foto temporal:', err.message);
    }
}

/**
 * Inicia una nueva sesión de escaneo guardando la foto temporalmente y dejando
 * en espera a Arduino (ya sea por WebSocket o por conexión HTTP abierta).
 */
function startPhotoScanSession(imageBuffer, respondToArduinoCallback) {
    // Si había una captura previa sin resolver, cerrarla antes
    if (currentScanSession && currentScanSession.finishArduino) {
        currentScanSession.finishArduino(409, {
            tipo: 'resultado_asistencia',
            success: false,
            led: 'ROJO',
            msg: 'Captura reemplazada por una nueva foto recibida.'
        });
    }

    fs.writeFileSync(TEMP_PHOTO_PATH, imageBuffer);

    const timeoutMs = Number(process.env.QR_SCAN_TIMEOUT_MS) || 30000;
    const createdAt = new Date().toISOString();
    let responded = false;

    const finishArduino = (statusCode, payload) => {
        if (responded) return;
        responded = true;
        clearTempSession();
        respondToArduinoCallback(statusCode, payload);
    };

    const timeoutId = setTimeout(() => {
        console.warn('[WS/Asistencia] Timeout esperando decodificación de la App de Escritorio.');
        const timeoutPayload = {
            tipo: 'resultado_asistencia',
            success: false,
            led: 'ROJO',
            msg: 'Tiempo de espera agotado: la App de Escritorio no envió el token a tiempo.'
        };
        finishArduino(408, timeoutPayload);
        broadcastToModules(['web'], {
            tipo: 'intento_asistencia_fallido',
            ...timeoutPayload
        });
    }, timeoutMs);

    currentScanSession = {
        createdAt,
        photoPath: TEMP_PHOTO_PATH,
        timeoutId,
        finishArduino
    };

    const base64Image = imageBuffer.toString('base64');

    // 1. Enviar automáticamente la foto por WebSocket a la App de Escritorio para que la decodifique
    broadcastToModules(['desktop'], {
        tipo: 'decodificar_foto_qr',
        pendiente: true,
        timestamp: createdAt,
        imagen_base64: base64Image
    });

    // 2. Avisar al Cliente Web (React) que hay un escaneo en curso
    broadcastToModules(['web'], {
        tipo: 'escaneo_en_proceso',
        timestamp: createdAt
    });

    console.log(`[Asistencia] Foto guardada temporalmente (${imageBuffer.length} bytes) y enviada por WS a Escritorio.`);
    return currentScanSession;
}

/**
 * Notifica por WebSocket a Escritorio y React cuando se registra un alumno nuevo
 */
function notifyStudentRegistered(alumno) {
    // A la App de Escritorio: para que genere el QR con numero_control y lo mande a Telegram
    broadcastToModules(['desktop'], {
        tipo: 'nuevo_alumno_qr',
        msg: 'Nuevo alumno registrado. Generar código QR y enviar a Telegram.',
        alumno
    });

    // Al Cliente Web (React): para actualizar la tabla de alumnos en tiempo real
    broadcastToModules(['web'], {
        tipo: 'alumno_registrado',
        alumno
    });
}

/**
 * Notifica el resultado de la verificación de asistencia a Arduino, Escritorio y React Web
 */
function notifyAttendanceResult(statusCode, payload) {
    // 1. Si hay una sesión de espera activa de Arduino (WS o HTTP), responderle y limpiar foto temporal
    if (currentScanSession && currentScanSession.finishArduino) {
        currentScanSession.finishArduino(statusCode, payload);
    } else {
        // Si Arduino está conectado por WS pero no tenía sesión activa, enviarle el resultado de igual forma
        clearTempSession();
        broadcastToModules(['arduino'], payload);
    }

    // 2. Notificar en tiempo real al Cliente Web (React)
    broadcastToModules(['web'], {
        tipo: payload.success ? 'nueva_asistencia' : 'intento_asistencia_fallido',
        ...payload
    });
}

/**
 * Procesa los mensajes entrantes por WebSocket desde cualquiera de los 4 módulos:
 * - Android
 * - App de Escritorio (Desktop)
 * - Arduino (ESP32-CAM)
 * - Cliente Web (React)
 */
async function handleIncomingWsMessage(ws, rawData, isBinary) {
    try {
        // ====================================================================
        // CASO A: Trama binaria directa (Arduino enviando bytes JPEG directos)
        // ====================================================================
        if (isBinary) {
            if (ws.modulo === 'desconocido') {
                ws.modulo = 'arduino';
            }
            const imageBuffer = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);

            sendJson(ws, {
                tipo: 'captura_recibida_ack',
                msg: 'Foto recibida en el servidor. Esperando validación de QR...'
            });

            startPhotoScanSession(imageBuffer, (_status, resultPayload) => {
                sendJson(ws, resultPayload);
            });
            return;
        }

        // ====================================================================
        // CASO B: Mensaje de texto JSON
        // ====================================================================
        const text = rawData.toString('utf8').trim();
        let message;
        try {
            message = JSON.parse(text);
        } catch (_) {
            return sendJson(ws, {
                tipo: 'error',
                success: false,
                msg: 'Formato JSON inválido. Envía un objeto JSON con la propiedad "tipo".'
            });
        }

        const tipo = String(message.tipo || message.evento || message.action || '').trim();
        const datos = message.datos || message.data || message;

        switch (tipo) {
            // ----------------------------------------------------------------
            // 0. Identificación del módulo al conectarse
            // ----------------------------------------------------------------
            case 'identificar':
            case 'registro_modulo': {
                ws.modulo = normalizeModuleName(datos.modulo || message.modulo || datos.rol);
                console.log(`[WS] Cliente identificado como módulo: "${ws.modulo}"`);

                sendJson(ws, {
                    tipo: 'identificado_ack',
                    success: true,
                    modulo: ws.modulo,
                    estado_modulos: getConnectedModulesStatus()
                });

                // Si se acaba de conectar la App de Escritorio y hay una foto pendiente, enviársela
                if (ws.modulo === 'desktop' && currentScanSession && fs.existsSync(TEMP_PHOTO_PATH)) {
                    const buf = fs.readFileSync(TEMP_PHOTO_PATH);
                    sendJson(ws, {
                        tipo: 'decodificar_foto_qr',
                        pendiente: true,
                        timestamp: currentScanSession.createdAt,
                        imagen_base64: buf.toString('base64')
                    });
                }

                // Avisar al Cliente Web (React) el nuevo estado de los módulos
                broadcastToModules(['web'], {
                    tipo: 'estado_modulos',
                    modulos: getConnectedModulesStatus()
                });
                break;
            }

            // ----------------------------------------------------------------
            // 1. FLUJO DE REGISTRO Y GENERACIÓN DE QR:
            //    Telegram -> Android -> Servidor -> Escritorio (genera QR) -> Servidor -> Android -> Telegram
            // ----------------------------------------------------------------
            case 'registrar_alumno': {
                if (ws.modulo === 'desconocido') ws.modulo = 'android';

                const alumno = await sigaService.registerOrUpdateStudent(datos);

                // Responder a Android confirmando el alta en la BD
                sendJson(ws, {
                    tipo: 'alumno_registrado_ack',
                    success: true,
                    msg: 'Alumno guardado en la base de datos. Solicitando generación de QR a la App de Escritorio...',
                    alumno
                });

                // Empujar evento en tiempo real a Escritorio (para generar QR) y a React Web
                notifyStudentRegistered(alumno);
                break;
            }

            case 'solicitar_qr_alumno':
            case 'miqr': {
                // Cuando un alumno escribe "/miqr 22070319" en Telegram y Android lo reporta al Servidor
                if (ws.modulo === 'desconocido') ws.modulo = 'android';

                const numero_control = datos.numero_control || datos.no_control || datos.token || message.numero_control;
                const chat_id_telegram = datos.chat_id_telegram || datos.chat_id || message.chat_id_telegram;

                const alumno = await sigaService.linkStudentTelegramChat(numero_control, chat_id_telegram);

                if (!alumno) {
                    return sendJson(ws, {
                        tipo: 'error_qr_alumno',
                        success: false,
                        numero_control,
                        chat_id_telegram,
                        msg: `El número de control "${numero_control}" no se encuentra registrado en la base de datos.`
                    });
                }

                sendJson(ws, {
                    tipo: 'solicitud_qr_ack',
                    success: true,
                    msg: 'Alumno verificado. Solicitando generación de imagen QR a la App de Escritorio...',
                    alumno
                });

                // Pedir a la App de Escritorio que genere el QR para este alumno
                broadcastToModules(['desktop'], {
                    tipo: 'nuevo_alumno_qr',
                    msg: 'Generar imagen QR con el número de control y enviarla al servidor.',
                    alumno
                });
                break;
            }

            case 'qr_generado':
            case 'enviar_qr_generado': {
                // La App de Escritorio envía la imagen del QR generada al Servidor,
                // y el Servidor se la reenvía a Android para que Android la mande a Telegram.
                if (ws.modulo === 'desconocido') ws.modulo = 'desktop';

                const numero_control = String(
                    datos.numero_control || datos.no_control || message.numero_control || ''
                ).trim();
                const rawQrImage =
                    datos.imagen_qr_base64 ||
                    datos.imagen_qr ||
                    datos.imagen ||
                    datos.qr ||
                    message.imagen_qr_base64 ||
                    message.imagen;

                if (!numero_control || !rawQrImage) {
                    return sendJson(ws, {
                        tipo: 'error',
                        success: false,
                        msg: 'Se requieren los campos "numero_control" e "imagen_qr_base64".'
                    });
                }

                const cleanQrBase64 = String(rawQrImage).replace(/^data:image\/\w+;base64,/, '');
                const alumno = await sigaService.getStudentByControlNumber(numero_control);

                if (!alumno) {
                    return sendJson(ws, {
                        tipo: 'error',
                        success: false,
                        msg: `No se encontró al alumno con número de control "${numero_control}".`
                    });
                }

                const chat_id_telegram =
                    datos.chat_id_telegram ||
                    datos.chat_id ||
                    alumno.chat_id_telegram ||
                    null;

                // Marcar en la base de datos que el QR ya fue generado/procesado
                await sigaService.markQrSent(numero_control, chat_id_telegram);

                // 1. Enviar la imagen del QR y los datos del alumno a ANDROID para que la mande a Telegram
                broadcastToModules(['android'], {
                    tipo: 'enviar_qr_telegram',
                    success: true,
                    msg: 'Imagen QR generada por Escritorio. Enviar al alumno por Telegram.',
                    numero_control: alumno.numero_control,
                    nombre_completo: alumno.nombre_completo,
                    semestre: alumno.semestre,
                    grupo: alumno.grupo,
                    chat_id_telegram,
                    imagen_qr_base64: cleanQrBase64
                });

                // 2. Confirmar a la App de Escritorio que el servidor recibió el QR y lo transfirió a Android
                sendJson(ws, {
                    tipo: 'qr_generado_ack',
                    success: true,
                    msg: `Imagen QR de ${numero_control} recibida y enviada a Android para su entrega en Telegram.`,
                    numero_control
                });

                // 3. Notificar en tiempo real al Cliente Web (React)
                broadcastToModules(['web'], {
                    tipo: 'qr_actualizado',
                    numero_control,
                    qr_enviado: 1
                });

                console.log(`[WS/QR] QR de "${numero_control}" recibido desde Escritorio y reenviado a Android (chat_id: ${chat_id_telegram}).`);
                break;
            }

            case 'obtener_pendientes_qr': {
                if (ws.modulo === 'desconocido') ws.modulo = 'desktop';
                const alumnos = await sigaService.getPendingQrStudents();
                sendJson(ws, {
                    tipo: 'alumnos_pendientes_qr',
                    success: true,
                    total: alumnos.length,
                    alumnos
                });
                break;
            }

            case 'obtener_ultimo_alumno': {
                const alumno = await sigaService.getLatestStudent();
                sendJson(ws, {
                    tipo: 'ultimo_alumno',
                    success: Boolean(alumno),
                    alumno
                });
                break;
            }

            case 'qr_enviado': {
                const numero_control = datos.numero_control || datos.no_control || datos.token;
                const actualizado = await sigaService.markQrSent(
                    numero_control,
                    datos.chat_id_telegram || datos.chat_id
                );

                sendJson(ws, {
                    tipo: 'qr_enviado_ack',
                    success: actualizado,
                    numero_control
                });

                if (actualizado) {
                    broadcastToModules(['web'], {
                        tipo: 'qr_actualizado',
                        numero_control,
                        qr_enviado: 1
                    });
                }
                break;
            }

            // ----------------------------------------------------------------
            // 2. FLUJO DE ASISTENCIA: Arduino -> Servidor -> Desktop -> BD -> Arduino & React
            // ----------------------------------------------------------------
            case 'captura_qr':
            case 'enviar_foto': {
                if (ws.modulo === 'desconocido') ws.modulo = 'arduino';
                const base64Raw = datos.imagen || datos.foto || datos.imagen_base64 || message.imagen || message.foto;

                if (!base64Raw || typeof base64Raw !== 'string') {
                    return sendJson(ws, {
                        tipo: 'resultado_asistencia',
                        success: false,
                        led: 'ROJO',
                        msg: 'No se recibió el campo "imagen" en Base64.'
                    });
                }

                const cleanBase64 = base64Raw.replace(/^data:image\/\w+;base64,/, '');
                const imageBuffer = Buffer.from(cleanBase64, 'base64');

                sendJson(ws, {
                    tipo: 'captura_recibida_ack',
                    msg: 'Foto recibida temporalmente. Esperando que Escritorio decodifique el QR...'
                });

                startPhotoScanSession(imageBuffer, (_status, resultPayload) => {
                    sendJson(ws, resultPayload);
                });
                break;
            }

            case 'solicitar_foto_qr': {
                if (ws.modulo === 'desconocido') ws.modulo = 'desktop';
                const hasPending = Boolean(currentScanSession && fs.existsSync(TEMP_PHOTO_PATH));

                if (!hasPending) {
                    return sendJson(ws, {
                        tipo: 'decodificar_foto_qr',
                        pendiente: false,
                        msg: 'No hay foto pendiente de decodificar.'
                    });
                }

                const buffer = fs.readFileSync(TEMP_PHOTO_PATH);
                sendJson(ws, {
                    tipo: 'decodificar_foto_qr',
                    pendiente: true,
                    timestamp: currentScanSession.createdAt,
                    imagen_base64: buffer.toString('base64')
                });
                break;
            }

            case 'verificar_qr':
            case 'enviar_token': {
                if (ws.modulo === 'desconocido') ws.modulo = 'desktop';

                const token = datos.token || datos.numero_control || datos.no_control || message.token;
                const result = await sigaService.verifyTokenAndCreateAttendance({
                    token,
                    estado: datos.estado || 'presente',
                    observaciones: datos.observaciones || null,
                    error: datos.error || message.error || null
                });

                // 1. Notificar a Arduino (LED VERDE o LED ROJO) y al Cliente Web (React)
                notifyAttendanceResult(result.statusCode, result.payload);

                // 2. Confirmar también a la App de Escritorio
                sendJson(ws, {
                    tipo: 'verificacion_qr_ack',
                    ...result.payload
                });
                break;
            }

            // ----------------------------------------------------------------
            // 3. CONSULTAS PARA EL CLIENTE WEB (REACT) Y OTROS MÓDULOS
            // ----------------------------------------------------------------
            case 'obtener_alumnos': {
                const alumnos = await sigaService.getAllStudents(datos.filtros || datos);
                sendJson(ws, {
                    tipo: 'lista_alumnos',
                    success: true,
                    total: alumnos.length,
                    alumnos
                });
                break;
            }

            case 'obtener_asistencias': {
                const asistencias = await sigaService.getAttendances(datos.filtros || datos);
                sendJson(ws, {
                    tipo: 'lista_asistencias',
                    success: true,
                    total: asistencias.length,
                    asistencias
                });
                break;
            }

            case 'obtener_estado_modulos': {
                sendJson(ws, {
                    tipo: 'estado_modulos',
                    modulos: getConnectedModulesStatus()
                });
                break;
            }

            case 'ping': {
                sendJson(ws, { tipo: 'pong', timestamp: new Date().toISOString() });
                break;
            }

            default: {
                sendJson(ws, {
                    tipo: 'error',
                    success: false,
                    msg: `Evento WebSocket desconocido: "${tipo}".`,
                    eventos_validos: [
                        'identificar',
                        'registrar_alumno',
                        'obtener_pendientes_qr',
                        'obtener_ultimo_alumno',
                        'qr_enviado',
                        'captura_qr',
                        'solicitar_foto_qr',
                        'verificar_qr',
                        'obtener_alumnos',
                        'obtener_asistencias',
                        'obtener_estado_modulos'
                    ]
                });
            }
        }
    } catch (error) {
        console.error('[WS] Error procesando mensaje:', error);
        sendJson(ws, {
            tipo: 'error',
            success: false,
            led: 'ROJO',
            msg: error.message || 'Error interno en el servidor WebSocket.'
        });
    }
}

/**
 * Inicializa el servidor WebSocket acoplado al servidor HTTP de Express
 */
function initWebSocketServer(httpServer) {
    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws, req) => {
        // Permitir identificar el módulo desde la URL: ws://IP:3010/?modulo=desktop
        let initialMod = 'desconocido';
        try {
            const parsedUrl = new URL(req.url, 'http://localhost');
            const modParam = parsedUrl.searchParams.get('modulo') || parsedUrl.searchParams.get('rol');
            if (modParam) {
                initialMod = normalizeModuleName(modParam);
            }
        } catch (_) {
            // Ignorar si la URL no tiene query params
        }

        ws.modulo = initialMod;
        ws.isAlive = true;

        ws.on('pong', () => {
            ws.isAlive = true;
        });

        console.log(`[WS] Nueva conexión WebSocket desde ${req.socket.remoteAddress} (módulo: ${ws.modulo})`);

        // Mensaje de bienvenida al conectarse
        sendJson(ws, {
            tipo: 'conexion_exitosa',
            proyecto: 'SIGA - Servidor WebSocket',
            modulo_asignado: ws.modulo,
            estado_modulos: getConnectedModulesStatus()
        });

        // Actualizar al Cliente Web (React) sobre los módulos conectados
        broadcastToModules(['web'], {
            tipo: 'estado_modulos',
            modulos: getConnectedModulesStatus()
        });

        ws.on('message', (data, isBinary) => {
            handleIncomingWsMessage(ws, data, isBinary);
        });

        ws.on('close', () => {
            console.log(`[WS] Conexión cerrada (módulo: ${ws.modulo})`);
            broadcastToModules(['web'], {
                tipo: 'estado_modulos',
                modulos: getConnectedModulesStatus()
            });
        });

        ws.on('error', (err) => {
            console.error(`[WS] Error en cliente (${ws.modulo}):`, err.message);
        });
    });

    // Heartbeat cada 30s para detectar desconexiones silenciosas (ej. Arduino sin energía)
    const heartbeatInterval = setInterval(() => {
        if (!wss) return;
        for (const ws of wss.clients) {
            if (ws.isAlive === false) {
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            ws.ping();
        }
    }, 30000);

    wss.on('close', () => {
        clearInterval(heartbeatInterval);
    });

    return wss;
}

function getTempPhotoInfo() {
    const exists = Boolean(currentScanSession && fs.existsSync(TEMP_PHOTO_PATH));
    return {
        exists,
        path: TEMP_PHOTO_PATH,
        createdAt: currentScanSession ? currentScanSession.createdAt : null
    };
}

module.exports = {
    initWebSocketServer,
    broadcastToModules,
    startPhotoScanSession,
    notifyStudentRegistered,
    notifyAttendanceResult,
    getTempPhotoInfo,
    getConnectedModulesStatus
};

