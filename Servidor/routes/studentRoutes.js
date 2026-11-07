const express = require('express');
const router = express.Router();
const studentController = require('../controllers/studentController');

const rawImageParser = express.raw({
    type: ['image/png', 'image/jpeg', 'image/jpg', 'application/octet-stream'],
    limit: '10mb'
});

// 1. Flujo de registro: Android envía al servidor los datos recibidos desde Telegram
router.post('/', studentController.registerStudent);

// 2. Flujo de generación de QR: La App de Escritorio consulta alumnos pendientes de QR
router.get('/pendientes-qr', studentController.getPendingQrStudents);

// 3. Alternativa: Obtener el último alumno registrado
router.get('/ultimo', studentController.getLatestStudent);

// 4. La App de Escritorio envía la imagen del QR generada al Servidor para que éste la reenvíe a Android
router.post('/:numero_control/qr-generado', rawImageParser, studentController.receiveGeneratedQrFromDesktop);

// 5. Confirmación de QR enviado
router.put('/:numero_control/qr-enviado', studentController.markQrSent);
router.post('/:numero_control/qr-enviado', studentController.markQrSent);

// 6. Consultas generales de alumnos
router.get('/', studentController.getAllStudents);
router.get('/:numero_control', studentController.getStudentByControlNumber);

module.exports = router;
