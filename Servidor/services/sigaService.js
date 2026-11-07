const { pool } = require('../config/db');

/**
 * Registra un alumno nuevo o actualiza sus datos si el numero_control ya existe.
 * Deja qr_enviado = 0 para que la App de Escritorio genere y envíe el código QR.
 */
async function registerOrUpdateStudent(data) {
    const numero_control = String(
        data.numero_control || data.no_control || data.matricula || ''
    ).trim();
    const nombre_completo = String(
        data.nombre_completo || data.nombre || ''
    ).trim();
    const semestre = data.semestre ? String(data.semestre).trim() : null;
    const grupo = data.grupo ? String(data.grupo).trim() : null;
    const chat_id_telegram = data.chat_id_telegram || data.chat_id
        ? String(data.chat_id_telegram || data.chat_id).trim()
        : null;

    if (!numero_control || !nombre_completo) {
        const err = new Error('Los campos "numero_control" y "nombre_completo" son obligatorios.');
        err.statusCode = 400;
        throw err;
    }

    if (numero_control.length > 10) {
        const err = new Error('El "numero_control" no debe exceder 10 caracteres.');
        err.statusCode = 400;
        throw err;
    }

    const query = `
        INSERT INTO alumnos (numero_control, nombre_completo, semestre, grupo, chat_id_telegram, qr_enviado)
        VALUES (?, ?, ?, ?, ?, 0)
        ON DUPLICATE KEY UPDATE
            nombre_completo = VALUES(nombre_completo),
            semestre = COALESCE(VALUES(semestre), semestre),
            grupo = COALESCE(VALUES(grupo), grupo),
            chat_id_telegram = COALESCE(VALUES(chat_id_telegram), chat_id_telegram),
            qr_enviado = 0
    `;

    await pool.execute(query, [
        numero_control,
        nombre_completo,
        semestre,
        grupo,
        chat_id_telegram
    ]);

    const [rows] = await pool.execute(
        'SELECT * FROM alumnos WHERE numero_control = ?',
        [numero_control]
    );

    return rows[0];
}

/**
 * Obtiene los alumnos que tienen pendiente la generación/envío de su QR (qr_enviado = 0)
 */
async function getPendingQrStudents() {
    const [rows] = await pool.execute(
        'SELECT * FROM alumnos WHERE qr_enviado = 0 ORDER BY id_alumno ASC'
    );
    return rows;
}

/**
 * Obtiene el último alumno registrado
 */
async function getLatestStudent() {
    const [rows] = await pool.execute(
        'SELECT * FROM alumnos ORDER BY id_alumno DESC LIMIT 1'
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
 * Lista todos los alumnos con filtros opcionales (grupo, semestre)
 */
async function getAllStudents(filters = {}) {
    const { grupo, semestre } = filters;
    let query = 'SELECT * FROM alumnos WHERE 1=1';
    const params = [];

    if (grupo) {
        query += ' AND grupo = ?';
        params.push(grupo);
    }
    if (semestre) {
        query += ' AND semestre = ?';
        params.push(semestre);
    }

    query += ' ORDER BY nombre_completo ASC';
    const [rows] = await pool.execute(query, params);
    return rows;
}

/**
 * Busca un alumno por su numero_control
 */
async function getStudentByControlNumber(numero_control) {
    const [rows] = await pool.execute(
        'SELECT * FROM alumnos WHERE numero_control = ?',
        [String(numero_control).trim()]
    );
    return rows[0] || null;
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
                nombre_completo: alumno.nombre_completo,
                semestre: alumno.semestre,
                grupo: alumno.grupo
            },
            asistencia
        }
    };
}

/**
 * Obtiene el historial de asistencias con JOIN a la tabla alumnos
 */
async function getAttendances(filters = {}) {
    const { fecha, grupo, numero_control } = filters;

    let query = `
        SELECT
            a.id_asistencia,
            a.id_alumno,
            a.numero_control,
            al.nombre_completo,
            al.semestre,
            al.grupo,
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
    if (grupo) {
        query += ' AND al.grupo = ?';
        params.push(grupo);
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
    getPendingQrStudents,
    getLatestStudent,
    markQrSent,
    getAllStudents,
    getStudentByControlNumber,
    verifyTokenAndCreateAttendance,
    getAttendances
};

