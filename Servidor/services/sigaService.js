const { pool } = require('../config/db');

/**
 * Registra un alumno nuevo únicamente con numero_control y nombre_completo
 * en formato "Apellidos Nombre(s)" (el id_alumno se asigna automáticamente de 1 en 1).
 */
async function registerOrUpdateStudent(data) {
    const numero_control = String(
        data.numero_control || data.no_control || data.matricula || ''
    ).trim();

    // Soportar tanto "apellidos" + "nombre(s)" separados como "nombre_completo" directo ("Apellidos Nombre(s)")
    const apellidos = String(data.apellidos || data.apellido || '').trim();
    const nombres = String(data.nombres || (apellidos ? data.nombre || '' : '')).trim();

    let nombre_completo = '';
    if (apellidos && nombres) {
        nombre_completo = `${apellidos} ${nombres}`;
    } else {
        nombre_completo = String(
            data.nombre_completo || data.nombre || ''
        ).trim();
    }
    nombre_completo = nombre_completo.replace(/\s+/g, ' ');

    const chat_id_telegram = data.chat_id_telegram
        ? String(data.chat_id_telegram).trim()
        : null;

    if (!numero_control || !nombre_completo) {
        const err = new Error('Los campos "numero_control" y "nombre_completo" (Apellidos y Nombre) son obligatorios.');
        err.statusCode = 400;
        throw err;
    }

    if (nombre_completo.split(' ').length < 2) {
        const err = new Error('El registro debe incluir Apellidos y después Nombre(s) (ej. "Vazquez Esquivel Kevin Isai").');
        err.statusCode = 400;
        throw err;
    }

    if (numero_control.length > 10) {
        const err = new Error('El "numero_control" no debe exceder 10 caracteres.');
        err.statusCode = 400;
        throw err;
    }

    // Verificar si el alumno ya existe para no consumir un nuevo ID
    const existente = await getStudentByControlNumber(numero_control);

    if (existente) {
        await pool.execute(
            `UPDATE alumnos
             SET nombre_completo = ?,
                 chat_id_telegram = COALESCE(?, chat_id_telegram),
                 qr_enviado = 0
             WHERE numero_control = ?`,
            [nombre_completo, chat_id_telegram, numero_control]
        );
    } else {
        // Calcular el siguiente id_alumno estrictamente consecutivo (1, 2, 3...)
        // para evitar los saltos de bloques de 4000 en TiDB Cloud Serverless
        const [maxRows] = await pool.execute(
            'SELECT COALESCE(MAX(id_alumno), 0) + 1 AS next_id FROM alumnos'
        );
        const nextId = Number(maxRows[0].next_id) || 1;

        await pool.execute(
            `INSERT INTO alumnos (id_alumno, numero_control, nombre_completo, chat_id_telegram, qr_enviado)
             VALUES (?, ?, ?, ?, 0)`,
            [nextId, numero_control, nombre_completo, chat_id_telegram]
        );
    }

    return await getStudentByControlNumber(numero_control);
}

/**
 * Elimina un alumno por su numero_control (y sus asistencias en cascada).
 * Devuelve los datos del alumno eliminado o null si no existía.
 */
async function deleteStudentByControlNumber(numero_control) {
    const cleanControl = String(numero_control || '').trim();
    if (!cleanControl) return null;

    const alumno = await getStudentByControlNumber(cleanControl);
    if (!alumno) {
        return null;
    }

    await pool.execute('DELETE FROM alumnos WHERE numero_control = ?', [cleanControl]);
    return alumno;
}

/**
 * Obtiene los alumnos que tienen pendiente la generación/envío de su QR (qr_enviado = 0)
 */
async function getPendingQrStudents() {
    const [rows] = await pool.execute(
        'SELECT id_alumno, numero_control, nombre_completo, chat_id_telegram, qr_enviado, fecha_registro FROM alumnos WHERE qr_enviado = 0 ORDER BY id_alumno ASC'
    );
    return rows;
}

/**
 * Obtiene el último alumno registrado
 */
async function getLatestStudent() {
    const [rows] = await pool.execute(
        'SELECT id_alumno, numero_control, nombre_completo, chat_id_telegram, qr_enviado, fecha_registro FROM alumnos ORDER BY id_alumno DESC LIMIT 1'
    );
    return rows[0] || null;
}

/**
 * Marca que la App de Escritorio ya generó y envió el código QR por Telegram
 */
async function markQrSent(numero_control, chat_id_telegram = null) {
    let query = 'UPDATE alumnos SET qr_enviado = 1 WHERE numero_control = ?';
    let params = [String(numero_control).trim()];

    if (chat_id_telegram) {
        query = 'UPDATE alumnos SET qr_enviado = 1, chat_id_telegram = ? WHERE numero_control = ?';
        params = [String(chat_id_telegram).trim(), String(numero_control).trim()];
    }

    const [result] = await pool.execute(query, params);
    return result.affectedRows > 0;
}

/**
 * Lista todos los alumnos registrados ordenados alfabéticamente por Apellidos y Nombre(s)
 */
async function getAllStudents() {
    const [rows] = await pool.execute(
        'SELECT id_alumno, numero_control, nombre_completo, chat_id_telegram, qr_enviado, fecha_registro FROM alumnos ORDER BY nombre_completo ASC'
    );
    return rows;
}

/**
 * Busca un alumno por su numero_control
 */
async function getStudentByControlNumber(numero_control) {
    const [rows] = await pool.execute(
        'SELECT id_alumno, numero_control, nombre_completo, chat_id_telegram, qr_enviado, fecha_registro FROM alumnos WHERE numero_control = ?',
        [String(numero_control).trim()]
    );
    return rows[0] || null;
}

/**
 * Busca un alumno por su chat_id_telegram vinculado
 */
async function getStudentByTelegramChatId(chat_id_telegram) {
    const [rows] = await pool.execute(
        'SELECT id_alumno, numero_control, nombre_completo, chat_id_telegram, qr_enviado, fecha_registro FROM alumnos WHERE chat_id_telegram = ?',
        [String(chat_id_telegram || '').trim()]
    );
    return rows[0] || null;
}

/**
 * Vincula el chat_id_telegram de un alumno existente (cuando manda /vincular o /miqr <numero_control>)
 */
async function linkStudentTelegramChat(numero_control, chat_id_telegram) {
    const cleanControl = String(numero_control || '').trim();
    const cleanChatId = chat_id_telegram ? String(chat_id_telegram).trim() : null;

    const alumno = await getStudentByControlNumber(cleanControl);
    if (!alumno) {
        return null;
    }

    if (cleanChatId) {
        await pool.execute(
            'UPDATE alumnos SET chat_id_telegram = ?, qr_enviado = 0 WHERE numero_control = ?',
            [cleanChatId, cleanControl]
        );
    }

    return await getStudentByControlNumber(cleanControl);
}

/**
 * Obtiene el resumen de asistencias y faltas por alumno (para el comando "reporte_asistencias" del maestro)
 */
async function getAttendanceSummaryByStudent() {
    const [rows] = await pool.execute(`
        SELECT
            a.id_alumno,
            a.numero_control,
            a.nombre_completo,
            COALESCE(SUM(CASE WHEN asist.estado IN ('presente', 'retardo', 'justificado') THEN 1 ELSE 0 END), 0) AS total,
            COALESCE(SUM(CASE WHEN asist.estado = 'falta' THEN 1 ELSE 0 END), 0) AS total_faltas
        FROM alumnos a
        LEFT JOIN asistencias asist ON a.id_alumno = asist.id_alumno
        GROUP BY a.id_alumno, a.numero_control, a.nombre_completo
        ORDER BY a.nombre_completo ASC
    `);
    return rows;
}

/**
 * Marca con estado = 'falta' a todos los alumnos registrados que NO tengan
 * ningún registro en la tabla asistencias en la fecha actual (CURRENT_DATE).
 */
async function markAbsencesForMissingStudentsToday() {
    // 1. Obtener todos los alumnos registrados
    const [alumnos] = await pool.execute(
        'SELECT id_alumno, numero_control, nombre_completo, chat_id_telegram FROM alumnos ORDER BY id_alumno ASC'
    );

    if (alumnos.length === 0) {
        return {
            total_alumnos: 0,
            total_presentes: 0,
            total_faltas_nuevas: 0,
            faltas_registradas: []
        };
    }

    // 2. Obtener los registros que ya existen el día de hoy en asistencias
    const [registrosHoy] = await pool.execute(
        'SELECT id_alumno, estado FROM asistencias WHERE fecha = CURRENT_DATE'
    );

    const idsConRegistroHoy = new Set(registrosHoy.map((r) => Number(r.id_alumno)));
    const totalPresentesHoy = registrosHoy.filter((r) => r.estado !== 'falta').length;

    // 3. Filtrar los alumnos que no se registraron hoy
    const alumnosFaltantes = alumnos.filter((a) => !idsConRegistroHoy.has(Number(a.id_alumno)));

    if (alumnosFaltantes.length === 0) {
        return {
            total_alumnos: alumnos.length,
            total_presentes: totalPresentesHoy,
            total_faltas_nuevas: 0,
            faltas_registradas: []
        };
    }

    // 4. Obtener el último id_asistencia para insertar consecutivamente de 1 en 1
    const [maxRows] = await pool.execute(
        'SELECT COALESCE(MAX(id_asistencia), 0) AS max_id FROM asistencias'
    );
    let currentNextId = Number(maxRows[0].max_id) || 0;

    const insertedIds = [];
    for (const alumno of alumnosFaltantes) {
        currentNextId += 1;
        await pool.execute(
            `INSERT INTO asistencias (id_asistencia, id_alumno, numero_control, fecha, hora, estado, dispositivo_origen, observaciones)
             VALUES (?, ?, ?, CURRENT_DATE, CURRENT_TIME, 'falta', 'cierre_automatico', 'Falta por cierre de periodo de asistencia')`,
            [currentNextId, alumno.id_alumno, alumno.numero_control]
        );
        insertedIds.push(currentNextId);
    }

    // 5. Recuperar las filas recién insertadas con el mismo formato que getAttendances
    const placeholders = insertedIds.map(() => '?').join(',');
    const [faltasRows] = await pool.execute(
        `SELECT
            a.id_asistencia,
            a.id_alumno,
            a.numero_control,
            al.nombre_completo,
            DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
            a.hora,
            a.fecha_hora,
            a.estado,
            a.dispositivo_origen,
            a.observaciones
         FROM asistencias a
         INNER JOIN alumnos al ON a.id_alumno = al.id_alumno
         WHERE a.id_asistencia IN (${placeholders})
         ORDER BY a.id_asistencia ASC`,
        insertedIds
    );

    return {
        total_alumnos: alumnos.length,
        total_presentes: totalPresentesHoy,
        total_faltas_nuevas: faltasRows.length,
        faltas_registradas: faltasRows
    };
}

/**
 * Obtiene las asistencias de un alumno específico por su id_alumno (para "consultar_asistencias" del alumno)
 */
async function getAttendancesByStudentId(id_alumno) {
    const [rows] = await pool.execute(
        `SELECT
            id_asistencia,
            DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha,
            hora,
            DATE_FORMAT(fecha_hora, '%Y-%m-%d %H:%i:%s') AS fecha_hora,
            estado
         FROM asistencias
         WHERE id_alumno = ?
         ORDER BY fecha_hora DESC`,
        [id_alumno]
    );
    return rows;
}

/**
 * Extrae { numero_control, chat_id_telegram } desde cualquier formato que envíe
 * la App de Escritorio tras decodificar el QR:
 * 1) Campos directos: { numero_control: "23070039", chat_id_telegram: "8868902263" }
 * 2) String JSON dentro de token/qr: { token: '{"numero_control":"23070039","chat_id_telegram":"8868902263"}' }
 * 3) Objeto dentro de token/datos: { token: { numero_control: "23070039", chat_id_telegram: "8868902263" } }
 * 4) String simple: { token: "23070039" }
 */
function parseQrPayload(input = {}) {
    let numero_control = input.numero_control || input.no_control || input.matricula || null;
    let chat_id_telegram = input.chat_id_telegram || input.chat_id || null;
    const rawToken = input.token !== undefined ? input.token : input.qr_data || input.qr;

    if (rawToken && typeof rawToken === 'object') {
        numero_control = numero_control || rawToken.numero_control || rawToken.no_control || rawToken.matricula || null;
        chat_id_telegram = chat_id_telegram || rawToken.chat_id_telegram || rawToken.chat_id || null;
    } else if (typeof rawToken === 'string') {
        const trimmed = rawToken.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                const parsed = JSON.parse(trimmed);
                numero_control = numero_control || parsed.numero_control || parsed.no_control || parsed.matricula || null;
                chat_id_telegram = chat_id_telegram || parsed.chat_id_telegram || parsed.chat_id || null;
            } catch (_) {
                numero_control = numero_control || trimmed;
            }
        } else if (!numero_control && trimmed) {
            numero_control = trimmed;
        }
    }

    return {
        numero_control: numero_control ? String(numero_control).trim() : '',
        chat_id_telegram: chat_id_telegram ? String(chat_id_telegram).trim() : ''
    };
}

/**
 * Verifica si los datos decodificados del QR (numero_control y chat_id_telegram)
 * pertenecen a un alumno registrado en la BD y registra la asistencia.
 */
async function verifyTokenAndCreateAttendance(input = {}) {
    const { estado = 'presente', observaciones = null, error = null } = input;
    const { numero_control, chat_id_telegram } = parseQrPayload(input);

    if (!numero_control || error) {
        return {
            found: false,
            statusCode: 400,
            payload: {
                tipo: 'resultado_asistencia',
                success: false,
                led: 'ROJO',
                msg: error || 'No se detectó un código QR válido en la imagen.'
            }
        };
    }

    // Buscar al alumno en la base de datos por numero_control
    let alumno = await getStudentByControlNumber(numero_control);

    if (!alumno) {
        return {
            found: false,
            statusCode: 404,
            payload: {
                tipo: 'resultado_asistencia',
                success: false,
                led: 'ROJO',
                msg: `No se encontró ningún alumno con el número de control "${numero_control}".`,
                numero_control,
                chat_id_telegram: chat_id_telegram || null
            }
        };
    }

    // Si el QR trae chat_id_telegram, validamos que coincida con el del alumno en la BD
    if (chat_id_telegram) {
        if (alumno.chat_id_telegram && String(alumno.chat_id_telegram).trim() !== chat_id_telegram) {
            return {
                found: false,
                statusCode: 403,
                payload: {
                    tipo: 'resultado_asistencia',
                    success: false,
                    led: 'ROJO',
                    msg: `El chat_id_telegram (${chat_id_telegram}) no coincide con el registrado para el alumno ${numero_control}.`,
                    numero_control,
                    chat_id_telegram
                }
            };
        }

        // Si el alumno aún no tenía su chat_id_telegram guardado en la BD, lo actualizamos
        if (!alumno.chat_id_telegram) {
            alumno = await linkStudentTelegramChat(numero_control, chat_id_telegram);
        }
    }

    // Verificar si el alumno YA tiene asistencia registrada el día de hoy
    const [existingToday] = await pool.execute(
        `SELECT
            a.id_asistencia,
            a.id_alumno,
            a.numero_control,
            DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
            a.hora,
            a.fecha_hora,
            a.estado,
            a.dispositivo_origen,
            a.observaciones
         FROM asistencias a
         WHERE a.id_alumno = ? AND a.fecha = CURRENT_DATE
         LIMIT 1`,
        [alumno.id_alumno]
    );

    if (existingToday.length > 0) {
        return {
            found: true,
            alreadyRegistered: true,
            statusCode: 200,
            payload: {
                tipo: 'resultado_asistencia',
                success: true,
                ya_registrada: true,
                led: 'VERDE',
                msg: 'El alumno ya cuenta con asistencia registrada el día de hoy.',
                alumno: {
                    id_alumno: alumno.id_alumno,
                    numero_control: alumno.numero_control,
                    nombre_completo: alumno.nombre_completo,
                    chat_id_telegram: alumno.chat_id_telegram
                },
                asistencia: existingToday[0]
            }
        };
    }

    // Calcular el siguiente id_asistencia consecutivo (1, 2, 3...)
    const [maxAsist] = await pool.execute(
        'SELECT COALESCE(MAX(id_asistencia), 0) + 1 AS next_id FROM asistencias'
    );
    const nextAsistenciaId = Number(maxAsist[0].next_id) || 1;

    await pool.execute(
        `INSERT INTO asistencias (id_asistencia, id_alumno, numero_control, fecha, hora, estado, dispositivo_origen, observaciones)
         VALUES (?, ?, ?, CURRENT_DATE, CURRENT_TIME, ?, 'arduino_qr', ?)`,
        [nextAsistenciaId, alumno.id_alumno, alumno.numero_control, estado, observaciones]
    );

    const [asistenciaRows] = await pool.execute(
        `SELECT
            a.id_asistencia,
            a.id_alumno,
            a.numero_control,
            DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
            a.hora,
            a.fecha_hora,
            a.estado,
            a.dispositivo_origen,
            a.observaciones
         FROM asistencias a
         WHERE a.id_asistencia = ?`,
        [nextAsistenciaId]
    );

    const asistencia = asistenciaRows[0];

    return {
        found: true,
        statusCode: 201,
        payload: {
            tipo: 'resultado_asistencia',
            success: true,
            led: 'VERDE',
            msg: 'Asistencia registrada exitosamente.',
            alumno: {
                id_alumno: alumno.id_alumno,
                numero_control: alumno.numero_control,
                nombre_completo: alumno.nombre_completo,
                chat_id_telegram: alumno.chat_id_telegram
            },
            asistencia
        }
    };
}

/**
 * Obtiene el historial de asistencias con JOIN a la tabla alumnos
 */
async function getAttendances(filters = {}) {
    const { fecha, numero_control } = filters;

    let query = `
        SELECT
            a.id_asistencia,
            a.id_alumno,
            a.numero_control,
            al.nombre_completo,
            DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha,
            a.hora,
            a.fecha_hora,
            a.estado,
            a.dispositivo_origen,
            a.observaciones
        FROM asistencias a
        INNER JOIN alumnos al ON a.id_alumno = al.id_alumno
        WHERE 1=1
    `;
    const params = [];

    if (fecha) {
        query += ' AND a.fecha = ?';
        params.push(fecha);
    }
    if (numero_control) {
        query += ' AND a.numero_control = ?';
        params.push(numero_control);
    }

    query += ' ORDER BY a.fecha_hora DESC';

    const [rows] = await pool.execute(query, params);
    return rows;
}

module.exports = {
    registerOrUpdateStudent,
    deleteStudentByControlNumber,
    getPendingQrStudents,
    getLatestStudent,
    markQrSent,
    getAllStudents,
    getStudentByControlNumber,
    getStudentByTelegramChatId,
    linkStudentTelegramChat,
    getAttendanceSummaryByStudent,
    markAbsencesForMissingStudentsToday,
    getAttendancesByStudentId,
    verifyTokenAndCreateAttendance,
    getAttendances
};
