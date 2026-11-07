const fs = require('fs');
const sigaService = require('../services/sigaService');
const wsManager = require('../sockets/wsManager');

/**
 * Extrae el Buffer de imagen ya sea desde binario crudo (image/jpeg, application/octet-stream)
 * o desde un JSON con base64 ({ imagen / foto / image }).
 */
function extractImageBuffer(req) {
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        return req.body;
    }

    if (req.body && typeof req.body === 'object') {
        const base64Raw = req.body.imagen || req.body.foto || req.body.image || req.body.data;
        if (typeof base64Raw === 'string' && base64Raw.trim().length > 0) {
            const cleanBase64 = base64Raw.replace(/^data:image\/\w+;base64,/, '');
            return Buffer.from(cleanBase64, 'base64');
        }
    }

    return null;
}

/**
 * POST /api/asistencias/captura
 * Recibe la foto de Arduino por HTTP (manteniendo la conexión abierta) y además
 * la empuja automáticamente por WebSocket a la App de Escritorio.
 */
async function receiveArduinoPhotoAndHold(req, res) {
    try {
        const imageBuffer = extractImageBuffer(req);

        if (!imageBuffer || imageBuffer.length === 0) {
            return res.status(400).json({
                success: false,
                led: 'ROJO',
                msg: 'No se recibió ninguna imagen válida (envía binario image/jpeg o JSON con base64 en el campo "imagen").'
            });
        }

        wsManager.startPhotoScanSession(imageBuffer, (statusCode, payload) => {
            if (!res.headersSent) {
                res.status(statusCode).json(payload);
            }
        });
    } catch (error) {
        console.error('[attendanceController.receiveArduinoPhotoAndHold] Error:', error);
        return res.status(500).json({
            success: false,
            led: 'ROJO',
            msg: 'Error interno al procesar la foto enviada por Arduino.',
            error: error.message
        });
    }
}

/**
 * GET /api/asistencias/foto-pendiente
 * Permite a la App de Escritorio descargar la foto temporal por HTTP si lo requiere.
 */
async function getPendingPhotoForDesktop(req, res) {
    try {
        const info = wsManager.getTempPhotoInfo();
        const wantJson = String(req.query.formato || '').toLowerCase() === 'json';

        if (!info.exists) {
            if (wantJson) {
                return res.status(200).json({
                    success: true,
                    pendiente: false,
                    msg: 'No hay ninguna foto pendiente de decodificar.'
                });
            }
            return res.status(204).end();
        }

        if (wantJson) {
            const buffer = fs.readFileSync(info.path);
            return res.status(200).json({
                success: true,
                pendiente: true,
                createdAt: info.createdAt,
                imagen_base64: buffer.toString('base64')
            });
        }

        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        return res.sendFile(info.path);
    } catch (error) {
        console.error('[attendanceController.getPendingPhotoForDesktop] Error:', error);
        return res.status(500).json({
            success: false,
            msg: 'Error al obtener la foto temporal.',
            error: error.message
        });
    }
}

/**
 * POST /api/asistencias/verificar-qr
 * Verifica el token enviado por la App de Escritorio, registra la asistencia en BD
 * y notifica a Arduino (LED VERDE/ROJO) y al Cliente Web (React) por WebSocket.
 */
async function verifyQrTokenAndRegisterAttendance(req, res) {
    try {
        const token = req.body.token || req.body.numero_control || req.body.no_control;
        const result = await sigaService.verifyTokenAndCreateAttendance({
            token,
            estado: req.body.estado || 'presente',
            observaciones: req.body.observaciones || null,
            error: req.body.error || null
        });

        wsManager.notifyAttendanceResult(result.statusCode === 201 ? 200 : result.statusCode, result.payload);

        return res.status(result.statusCode).json(result.payload);
    } catch (error) {
        console.error('[attendanceController.verifyQrTokenAndRegisterAttendance] Error:', error);
        const errorPayload = {
            tipo: 'resultado_asistencia',
            success: false,
            led: 'ROJO',
            msg: 'Error de base de datos al verificar o registrar la asistencia.',
            error: error.message
        };
        wsManager.notifyAttendanceResult(500, errorPayload);
        return res.status(500).json(errorPayload);
    }
}

/**
 * GET /api/asistencias
 */
async function getAttendances(req, res) {
    try {
        const asistencias = await sigaService.getAttendances(req.query);
        return res.status(200).json({
            success: true,
            total: asistencias.length,
            asistencias
        });
    } catch (error) {
        console.error('[attendanceController.getAttendances] Error:', error);
        return res.status(500).json({
            success: false,
            msg: 'Error al consultar el historial de asistencias.',
            error: error.message
        });
    }
}

module.exports = {
    receiveArduinoPhotoAndHold,
    getPendingPhotoForDesktop,
    verifyQrTokenAndRegisterAttendance,
    getAttendances
};
