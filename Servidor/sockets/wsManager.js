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
 * Obtiene el chat_id configurado para el Maestro en Telegram (por defecto "7155239838")
 */
function getMaestroChatId() {
    return String(process.env.ID_MAESTRO || process.env.TELEGRAM_MAESTRO_CHAT_ID || '7155239838').trim();
}

/**
 * Verifica si un chat_id corresponde al maestro.
 * Si ID_MAESTRO="*" o no se envió chat_id (ej. prueba interna desde simulador), permite el paso.
 */
function esChatDeMaestro(chatId) {
    if (!chatId) return true;
    const idMaestro = getMaestroChatId();
    if (!idMaestro || idMaestro === '*') return true;
    return String(chatId).trim() === idMaestro;
}

/**
 * Normaliza el nombre del módulo para aceptar alias comunes entre compañeros
 */
function normalizeModuleName(raw) {
    const val = String(raw || '').toLowerCase().trim();
    if (['android', 'movil', 'mobile', 'app_android', 'telegram'].includes(val)) return 'android';
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
 * Helper para mandar texto de regreso a Android y que éste lo envíe a Telegram
 */
function responderATelegram(wsAndroid, chatId, texto) {
    if (!chatId) return;
    const payload = {
        tipo: 'respuesta_telegram',
        chat_id: chatId,
        mensaje: texto
    };

    if (wsAndroid && wsAndroid.readyState === WebSocket.OPEN) {
        sendJson(wsAndroid, payload);
    } else {
        broadcastToModules(['android'], payload);
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
function notifyStudentRegistered(alumno, notifyDesktopImmediately = true) {
    if (notifyDesktopImmediately) {
        broadcastToModules(['desktop'], {
            tipo: 'nuevo_alumno_qr',
            msg: 'Nuevo alumno registrado. Generar código QR y enviar al servidor.',
            alumno
        });
    }

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
    if (currentScanSession && currentScanSession.finishArduino) {
        currentScanSession.finishArduino(statusCode, payload);
    } else {
        clearTempSession();
        broadcastToModules(['arduino'], payload);
    }

    // Si la asistencia ya estaba registrada hoy, no enviamos un duplicado "nueva_asistencia" a React Web
    if (!payload.ya_registrada) {
        broadcastToModules(['web'], {
            tipo: payload.success ? 'nueva_asistencia' : 'intento_asistencia_fallido',
            ...payload
        });
    }
}

/**
 * Procesa los mensajes entrantes por WebSocket desde cualquiera de los 4 módulos:
 * - Android (Puente con Bot de Telegram)
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
        const chatId = datos.chat_id || message.chat_id || null;

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

                if (ws.modulo === 'desktop' && currentScanSession && fs.existsSync(TEMP_PHOTO_PATH)) {
                    const buf = fs.readFileSync(TEMP_PHOTO_PATH);
                    sendJson(ws, {
                        tipo: 'decodificar_foto_qr',
                        pendiente: true,
                        timestamp: currentScanSession.createdAt,
                        imagen_base64: buf.toString('base64')
                    });
                }

                broadcastToModules(['web'], {
                    tipo: 'estado_modulos',
                    modulos: getConnectedModulesStatus()
                });
                break;
            }

            // ----------------------------------------------------------------
            // 1. COMANDOS DE TELEGRAM DEL MAESTRO (Vía Android)
            // ----------------------------------------------------------------

            // 1.1 MAESTRO: Registrar alumno (Formato: Apellidos y después Nombre(s))
            case 'registrar_alumno': {
                if (ws.modulo === 'desconocido') ws.modulo = 'android';

                if (!esChatDeMaestro(chatId)) {
                    return responderATelegram(ws, chatId, '⛔ Solo el maestro puede registrar alumnos.');
                }

                let alumno;
                try {
                    alumno = await sigaService.registerOrUpdateStudent(datos);
                } catch (regErr) {
                    if (chatId) {
                        responderATelegram(ws, chatId, `⚠️ ${regErr.message}`);
                    }
                    return sendJson(ws, {
                        tipo: 'error',
                        success: false,
                        msg: regErr.message
                    });
                }

                // Si viene desde un comando de Telegram con chat_id del maestro, enviar respuesta_telegram
                if (chatId) {
                    responderATelegram(
                        ws,
                        chatId,
                        `✅ Alumno ${alumno.nombre_completo} (${alumno.numero_control}) registrado. Pendiente que vincule su chat.`
                    );
                }

                // Confirmación técnica adicional por WS
                sendJson(ws, {
                    tipo: 'alumno_registrado_ack',
                    success: true,
                    msg: 'Alumno guardado en la base de datos.',
                    alumno
                });

                // Si el alumno ya trae chat_id_telegram vinculado, pedir QR a Escritorio de inmediato;
                // siempre notificar en vivo al Cliente Web (React).
                notifyStudentRegistered(alumno, Boolean(alumno.chat_id_telegram));
                break;
            }

            // 1.1b MAESTRO: Borrar / Eliminar alumno por número de control
            case 'borrar_alumno':
            case 'eliminar_alumno':
            case 'baja_alumno': {
                if (ws.modulo === 'desconocido') ws.modulo = 'android';

                if (!esChatDeMaestro(chatId)) {
                    return responderATelegram(ws, chatId, '⛔ Solo el maestro puede eliminar alumnos.');
                }

                const numero_control = String(
                    datos.numero_control || datos.no_control || datos.matricula || message.numero_control || ''
                ).trim();

                if (!numero_control) {
                    return responderATelegram(
                        ws,
                        chatId,
                        '⚠️ Indica el número de control del alumno a borrar.'
                    );
                }

                const eliminado = await sigaService.deleteStudentByControlNumber(numero_control);

                if (!eliminado) {
                    if (chatId) {
                        responderATelegram(
                            ws,
                            chatId,
                            `❌ No se encontró ningún alumno con el número de control ${numero_control}.`
                        );
                    }
                    return sendJson(ws, {
                        tipo: 'alumno_eliminado_ack',
                        success: false,
                        numero_control,
                        msg: `No se encontró ningún alumno con el número de control ${numero_control}.`
                    });
                }

                if (chatId) {
                    responderATelegram(
                        ws,
                        chatId,
                        `🗑️ Alumno ${eliminado.nombre_completo} (${eliminado.numero_control}) eliminado correctamente.`
                    );
                }

                sendJson(ws, {
                    tipo: 'alumno_eliminado_ack',
                    success: true,
                    msg: 'Alumno eliminado correctamente.',
                    alumno: eliminado
                });

                // Notificar en tiempo real al Cliente Web (React) para quitarlo de la tabla
                broadcastToModules(['web'], {
                    tipo: 'alumno_eliminado',
                    id_alumno: eliminado.id_alumno,
                    numero_control: eliminado.numero_control,
                    alumno: eliminado
                });
                break;
            }

            // 1.2 MAESTRO: Ver alumnos registrados
            case 'listar_alumnos': {
                if (ws.modulo === 'desconocido') ws.modulo = 'android';

                if (!esChatDeMaestro(chatId)) {
                    return responderATelegram(ws, chatId, '⛔ Comando exclusivo del maestro.');
                }

                const rows = await sigaService.getAllStudents();
                if (rows.length === 0) {
                    return responderATelegram(ws, chatId, '📭 No hay alumnos registrados.');
                }

                const lista = rows
                    .map(
                        (a) =>
                            `• ${a.numero_control} - ${a.nombre_completo} (${
                                a.chat_id_telegram ? '🟢 Vinculado' : '🟡 Pendiente'
                            })`
                    )
                    .join('\n');

                responderATelegram(ws, chatId, `📋 Alumnos registrados:\n\n${lista}`);
                break;
            }

            // 1.3 MAESTRO: Reporte general de asistencias
            case 'reporte_asistencias': {
                if (ws.modulo === 'desconocido') ws.modulo = 'android';

                if (!esChatDeMaestro(chatId)) {
                    return responderATelegram(ws, chatId, '⛔ Comando exclusivo del maestro.');
                }

                const rows = await sigaService.getAttendanceSummaryByStudent();
                const reporte = rows
                    .map((r) => `• ${r.nombre_completo} (${r.numero_control}): ${r.total} asistencias`)
                    .join('\n');

                responderATelegram(ws, chatId, `📊 Reporte de asistencias:\n\n${reporte || 'Sin datos.'}`);
                break;
            }

            // ----------------------------------------------------------------
            // 2. COMANDOS DE TELEGRAM DEL ALUMNO (Vía Android)
            // ----------------------------------------------------------------

            // 2.1 ALUMNO: Vincular su chat_id con su número de control (/vincular 22070319)
            case 'vincular_alumno': {
                if (ws.modulo === 'desconocido') ws.modulo = 'android';

                const numero_control = datos.numero_control || datos.no_control || message.numero_control;
                const chatParaVincular = chatId || datos.chat_id_telegram;

                const alumnoVinculado = await sigaService.linkStudentTelegramChat(
                    numero_control,
                    chatParaVincular
                );

                if (!alumnoVinculado) {
                    return responderATelegram(
                        ws,
                        chatParaVincular,
                        '❌ Aún no has sido registrado por el maestro. Contacta a tu profesor.'
                    );
                }

                responderATelegram(
                    ws,
                    chatParaVincular,
                    `✅ ¡Listo ${alumnoVinculado.nombre_completo}! Tu chat quedó vinculado. Ya puedes usar /asistencias o /miqr.`
                );

                // Notificar al Cliente Web (React) que el alumno ya vinculó su Telegram
                broadcastToModules(['web'], {
                    tipo: 'alumno_registrado',
                    alumno: alumnoVinculado
                });
                break;
            }

            // 2.2 ALUMNO: Consultar sus propias asistencias (/asistencias)
            case 'consultar_asistencias': {
                if (ws.modulo === 'desconocido') ws.modulo = 'android';

                const chatAlumno = chatId || datos.chat_id_telegram;
                const alumno = await sigaService.getStudentByTelegramChatId(chatAlumno);

                if (!alumno) {
                    return responderATelegram(
                        ws,
                        chatAlumno,
                        '⚠️ Primero vincula tu cuenta enviando: /vincular TU_NUMERO_CONTROL'
                    );
                }

                const asistencias = await sigaService.getAttendancesByStudentId(alumno.id_alumno);
                if (asistencias.length === 0) {
                    return responderATelegram(
                        ws,
                        chatAlumno,
                        `📅 ${alumno.nombre_completo}, aún no tienes asistencias.`
                    );
                }

                const lista = asistencias.map((a, i) => `${i + 1}. ${a.fecha_hora}`).join('\n');
                responderATelegram(
                    ws,
                    chatAlumno,
                    `📅 Tus asistencias (${alumno.nombre_completo}):\n\n${lista}`
                );
                break;
            }

            // 2.3 ALUMNO: Pedir QR a la App de Escritorio (/miqr)
            case 'solicitar_qr':
            case 'solicitar_qr_alumno':
            case 'miqr': {
                if (ws.modulo === 'desconocido') ws.modulo = 'android';

                const chatAlumno = chatId || datos.chat_id_telegram || message.chat_id_telegram;
                const numero_control = datos.numero_control || datos.no_control || message.numero_control;

                let alumno = null;

                // Si enviaron numero_control además de chat_id, lo vinculamos y buscamos;
                // si solo enviaron chat_id (como en case "solicitar_qr"), buscamos por chat_id_telegram.
                if (numero_control) {
                    alumno = await sigaService.linkStudentTelegramChat(numero_control, chatAlumno);
                } else if (chatAlumno) {
                    alumno = await sigaService.getStudentByTelegramChatId(chatAlumno);
                }

                if (!alumno) {
                    return responderATelegram(
                        ws,
                        chatAlumno,
                        '⚠️ Primero vincula tu cuenta enviando: /vincular TU_NUMERO_CONTROL'
                    );
                }

                // Reenviar la orden por WebSocket a la App de Escritorio para que genere el QR
                broadcastToModules(['desktop'], {
                    tipo: 'nuevo_alumno_qr',
                    msg: 'Generar imagen QR con el número de control y enviarla al servidor.',
                    alumno
                });

                responderATelegram(
                    ws,
                    chatAlumno,
                    '⏳ Generando tu código QR, te llegará en unos segundos...'
                );
                break;
            }

            // ----------------------------------------------------------------
            // 3. RECEPCIÓN DE IMAGEN QR DESDE ESCRITORIO Y ENVÍO A ANDROID
            // ----------------------------------------------------------------
            case 'qr_generado':
            case 'enviar_qr_generado': {
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

                await sigaService.markQrSent(numero_control, chat_id_telegram);

                // 1. Enviar la imagen del QR y el chat_id a ANDROID para que la mande a Telegram
                broadcastToModules(['android'], {
                    tipo: 'enviar_qr_telegram',
                    success: true,
                    msg: 'Imagen QR generada por Escritorio. Enviar al alumno por Telegram.',
                    id_alumno: alumno.id_alumno,
                    numero_control: alumno.numero_control,
                    nombre_completo: alumno.nombre_completo,
                    chat_id: chat_id_telegram,
                    chat_id_telegram,
                    imagen_qr_base64: cleanQrBase64
                });

                // 2. Confirmar a la App de Escritorio
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
            // 4. FLUJO DE ASISTENCIA: Arduino -> Servidor -> Desktop -> BD -> Arduino & React
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

                const result = await sigaService.verifyTokenAndCreateAttendance({
                    token: datos.token || message.token || datos.qr || message.qr,
                    numero_control: datos.numero_control || datos.no_control || message.numero_control,
                    chat_id_telegram: datos.chat_id_telegram || datos.chat_id || message.chat_id_telegram || message.chat_id,
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
            // 5. CONSULTAS PARA EL CLIENTE WEB (REACT) Y OTROS MÓDULOS
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
                        'borrar_alumno',
                        'eliminar_alumno',
                        'listar_alumnos',
                        'reporte_asistencias',
                        'vincular_alumno',
                        'consultar_asistencias',
                        'solicitar_qr',
                        'qr_generado',
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

        sendJson(ws, {
            tipo: 'conexion_exitosa',
            proyecto: 'SIGA - Servidor WebSocket',
            modulo_asignado: ws.modulo,
            estado_modulos: getConnectedModulesStatus()
        });

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
    responderATelegram,
    startPhotoScanSession,
    notifyStudentRegistered,
    notifyAttendanceResult,
    getTempPhotoInfo,
    getConnectedModulesStatus
};
