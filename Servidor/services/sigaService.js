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

    const query = `
        INSERT INTO alumnos (numero_control, nombre_completo, chat_id_telegram, qr_enviado)
        VALUES (?, ?, ?, 0)
        ON DUPLICATE KEY UPDATE
            nombre_completo = VALUES(nombre_completo),
            chat_id_telegram = COALESCE(VALUES(chat_id_telegram), chat_id_telegram),
            qr_enviado = 0
    `;

    await pool.execute(query, [
        numero_control,
        nombre_completo,
        chat_id_telegram
    ]);

    const [rows] = await pool.execute(
        'SELECT id_alumno, numero_control, nombre_completo, chat_id_telegram, qr_enviado, fecha_registro FROM alumnos WHERE numero_control = ?',
        [numero_control]
    );

    return rows[0];
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
 * Obtiene el resumen de asistencias por alumno (para el comando "reporte_asistencias" del maestro)
 */
async function getAttendanceSummaryByStudent() {
    const [rows] = await pool.execute(`
        SELECT
            a.id_alumno,
            a.numero_control,
            a.nombre_completo,
            COUNT(asist.id_asistencia) AS total
        FROM alumnos a
        LEFT JOIN asistencias asist ON a.id_alumno = asist.id_alumno
        GROUP BY a.id_alumno, a.numero_control, a.nombre_completo
        ORDER BY a.nombre_completo ASC
    `);
    return rows;
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
 * Verifica si el token (numero_control) decodificado del QR pertenece a un alumno
 * y, de ser así, inserta el registro de asistencia en la BD.
 */
async function verifyTokenAndCreateAttendance({ token, estado = 'presente', observaciones = null, error = null }) {
    const cleanToken = String(token || '').trim();

    if (!cleanToken || error) {
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

    const alumno = await getStudentByControlNumber(cleanToken);

    if (!alumno) {
        return {
            found: false,
            statusCode: 404,
            payload: {
                tipo: 'resultado_asistencia',
                success: false,
                led: 'ROJO',
                msg: `No se encontró ningún alumno con el número de control "${cleanToken}".`,
                token_recibido: cleanToken
            }
        };
    }

    const [insertResult] = await pool.execute(
        `INSERT INTO asistencias (id_alumno, numero_control, fecha, hora, estado, dispositivo_origen, observaciones)
         VALUES (?, ?, CURRENT_DATE, CURRENT_TIME, ?, 'arduino_qr', ?)`,
        [alumno.id_alumno, alumno.numero_control, estado, observaciones]
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
        [insertResult.insertId]
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
                nombre_completo: alumno.nombre_completo
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
    getAttendancesByStudentId,
    verifyTokenAndCreateAttendance,
    getAttendances
};
