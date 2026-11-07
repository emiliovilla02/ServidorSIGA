const sigaService = require('../services/sigaService');
const wsManager = require('../sockets/wsManager');

/**
 * POST /api/alumnos
 * Registra al alumno en la BD y notifica por WebSocket a la App de Escritorio y a React Web
 */
async function registerStudent(req, res) {
    try {
        const alumno = await sigaService.registerOrUpdateStudent(req.body);

        // Notificar en tiempo real por WebSocket a la App de Escritorio (generar QR) y a React
        wsManager.notifyStudentRegistered(alumno);

        return res.status(201).json({
            success: true,
            msg: 'Alumno registrado correctamente. Se notificó por WebSocket a la App de Escritorio y al Cliente Web.',
            alumno
        });
    } catch (error) {
        console.error('[studentController.registerStudent] Error:', error);
        const status = error.statusCode || 500;
        return res.status(status).json({
            success: false,
            msg: error.message || 'Error interno al registrar al alumno en la base de datos.'
        });
    }
}

/**
 * GET /api/alumnos/pendientes-qr
 */
async function getPendingQrStudents(req, res) {
    try {
        const alumnos = await sigaService.getPendingQrStudents();
        return res.status(200).json({
            success: true,
            total: alumnos.length,
            alumnos
        });
    } catch (error) {
        console.error('[studentController.getPendingQrStudents] Error:', error);
        return res.status(500).json({
            success: false,
            msg: 'Error al consultar alumnos pendientes de QR.',
            error: error.message
        });
    }
}

/**
 * GET /api/alumnos/ultimo
 */
async function getLatestStudent(req, res) {
    try {
        const alumno = await sigaService.getLatestStudent();
        if (!alumno) {
            return res.status(404).json({
                success: false,
                msg: 'No hay alumnos registrados todavía.'
            });
        }
        return res.status(200).json({
            success: true,
            alumno
        });
    } catch (error) {
        console.error('[studentController.getLatestStudent] Error:', error);
        return res.status(500).json({
            success: false,
            msg: 'Error al obtener el último alumno registrado.',
            error: error.message
        });
    }
}

/**
 * PUT/POST /api/alumnos/:numero_control/qr-enviado
 */
async function markQrSent(req, res) {
    try {
        const { numero_control } = req.params;
        const chat_id_telegram = req.body && (req.body.chat_id_telegram || req.body.chat_id);

        const updated = await sigaService.markQrSent(numero_control, chat_id_telegram);

        if (!updated) {
            return res.status(404).json({
                success: false,
                msg: `No se encontró un alumno con número de control ${numero_control}.`
            });
        }

        wsManager.broadcastToModules(['web'], {
            tipo: 'qr_actualizado',
            numero_control,
            qr_enviado: 1
        });

        return res.status(200).json({
            success: true,
            msg: `QR marcado como enviado para el número de control ${numero_control}.`
        });
    } catch (error) {
        console.error('[studentController.markQrSent] Error:', error);
        return res.status(500).json({
            success: false,
            msg: 'Error al actualizar el estado del QR del alumno.',
            error: error.message
        });
    }
}

/**
 * GET /api/alumnos
 */
async function getAllStudents(req, res) {
    try {
        const alumnos = await sigaService.getAllStudents(req.query);
        return res.status(200).json({
            success: true,
            total: alumnos.length,
            alumnos
        });
    } catch (error) {
        console.error('[studentController.getAllStudents] Error:', error);
        return res.status(500).json({
            success: false,
            msg: 'Error al consultar la lista de alumnos.',
            error: error.message
        });
    }
}

/**
 * GET /api/alumnos/:numero_control
 */
async function getStudentByControlNumber(req, res) {
    try {
        const alumno = await sigaService.getStudentByControlNumber(req.params.numero_control);
        if (!alumno) {
            return res.status(404).json({
                success: false,
                msg: `Alumno con número de control "${req.params.numero_control}" no encontrado.`
            });
        }
        return res.status(200).json({
            success: true,
            alumno
        });
    } catch (error) {
        console.error('[studentController.getStudentByControlNumber] Error:', error);
        return res.status(500).json({
            success: false,
            msg: 'Error al buscar el alumno.',
            error: error.message
        });
    }
}

/**
 * POST /api/alumnos/:numero_control/qr-generado
 * Recibe la imagen del QR generada por la App de Escritorio y la reenvía por WebSocket
 * a Android para que Android la mande por Telegram al alumno.
 */
async function receiveGeneratedQrFromDesktop(req, res) {
    try {
        const { numero_control } = req.params;
        let cleanQrBase64 = null;

        if (Buffer.isBuffer(req.body) && req.body.length > 0) {
            cleanQrBase64 = req.body.toString('base64');
        } else if (req.body && typeof req.body === 'object') {
            const rawQr =
                req.body.imagen_qr_base64 ||
                req.body.imagen_qr ||
                req.body.imagen ||
                req.body.qr;
            if (typeof rawQr === 'string' && rawQr.trim().length > 0) {
                cleanQrBase64 = rawQr.replace(/^data:image\/\w+;base64,/, '');
            }
        }

        if (!cleanQrBase64) {
            return res.status(400).json({
                success: false,
                msg: 'Debe enviar la imagen del código QR en "imagen_qr_base64" (o binario image/png).'
            });
        }

        const alumno = await sigaService.getStudentByControlNumber(numero_control);
        if (!alumno) {
            return res.status(404).json({
                success: false,
                msg: `No se encontró un alumno con número de control "${numero_control}".`
            });
        }

        const chat_id_telegram =
            (req.body && (req.body.chat_id_telegram || req.body.chat_id)) ||
            alumno.chat_id_telegram ||
            null;

        await sigaService.markQrSent(numero_control, chat_id_telegram);

        // Enviar por WebSocket a Android para que lo mande a Telegram
        wsManager.broadcastToModules(['android'], {
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

        // Avisar al Cliente Web (React)
        wsManager.broadcastToModules(['web'], {
            tipo: 'qr_actualizado',
            numero_control: alumno.numero_control,
            qr_enviado: 1
        });

        return res.status(200).json({
            success: true,
            msg: `Imagen QR de ${numero_control} recibida y enviada por WebSocket a Android para su entrega en Telegram.`
        });
    } catch (error) {
        console.error('[studentController.receiveGeneratedQrFromDesktop] Error:', error);
        return res.status(500).json({
            success: false,
            msg: 'Error al procesar y reenviar la imagen del QR.',
            error: error.message
        });
    }
}

module.exports = {
    registerStudent,
    getPendingQrStudents,
    getLatestStudent,
    markQrSent,
    receiveGeneratedQrFromDesktop,
    getAllStudents,
    getStudentByControlNumber
};
