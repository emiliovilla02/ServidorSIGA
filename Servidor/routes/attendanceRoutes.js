const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');

// Middleware para aceptar imagen binaria directa (image/jpeg, image/png, application/octet-stream)
// desde Arduino/ESP32-CAM con hasta 10MB de tamaño
const rawImageParser = express.raw({
    type: ['image/jpeg', 'image/jpg', 'image/png', 'application/octet-stream'],
    limit: '10mb'
});

// 1. Arduino envía la foto tomada a la cámara y la conexión queda abierta esperando el resultado
router.post('/captura', rawImageParser, attendanceController.receiveArduinoPhotoAndHold);

// 2. La App de Escritorio solicita la foto temporal para decodificar el código QR
router.get('/foto-pendiente', attendanceController.getPendingPhotoForDesktop);

// 3. La App de Escritorio envía el token (número de control) decodificado:
//    El servidor valida contra la BD de alumnos, registra la asistencia y responde a Arduino (VERDE / ROJO)
router.post('/verificar-qr', attendanceController.verifyQrTokenAndRegisterAttendance);

// 4. Consulta general del historial de asistencias (con filtros ?fecha=YYYY-MM-DD, ?grupo=A, ?numero_control=...)
router.get('/', attendanceController.getAttendances);

module.exports = router;

