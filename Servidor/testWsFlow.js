/**
 * Simulador de pruebas WebSocket para los 4 módulos de SIGA:
 * - Android (?modulo=android)
 * - App de Escritorio (?modulo=desktop)
 * - Arduino (?modulo=arduino)
 * - Cliente Web React (?modulo=web)
 *
 * Ejecutar con el servidor encendido:
 *   npm run test:ws
 */

const WebSocket = require('ws');

const WS_URL = `ws://127.0.0.1:${process.env.PORT || 3010}`;

function connectModule(modulo) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${WS_URL}?modulo=${modulo}`);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

async function runSimulation() {
    console.log('Conectando los 4 módulos por WebSocket (android, desktop, arduino, web)...\n');

    const [wsAndroid, wsDesktop, wsArduino, wsReact] = await Promise.all([
        connectModule('android'),
        connectModule('desktop'),
        connectModule('arduino'),
        connectModule('web')
    ]);

    // 1. Escuchar eventos en Android (cuando el Servidor le manda la imagen QR generada por Escritorio)
    wsAndroid.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.tipo === 'enviar_qr_telegram') {
            console.log(
                `📱 [Android] Recibida imagen QR del Servidor para ${msg.numero_control} (${msg.nombre_completo}) -> Enviando a Telegram (chat_id: ${msg.chat_id_telegram}, ${msg.imagen_qr_base64.length} chars Base64)`
            );
        }
    });

    // 2. Escuchar eventos en el Cliente Web (React)
    wsReact.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (['alumno_registrado', 'nueva_asistencia', 'intento_asistencia_fallido', 'qr_actualizado'].includes(msg.tipo)) {
            console.log(`🌐 [React Web] Evento en tiempo real recibido (${msg.tipo}):`, JSON.stringify(msg));
        }
    });

    // 3. Escuchar eventos en la App de Escritorio (generar imagen QR y decodificar foto de cámara)
    wsDesktop.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());

        if (msg.tipo === 'nuevo_alumno_qr') {
            console.log(`🖥️  [Desktop] Recibida orden para generar QR del alumno: ${msg.alumno.numero_control} (${msg.alumno.nombre_completo})`);
            // Simular que Desktop genera la imagen PNG del QR en Base64 y se la envía al Servidor
            setTimeout(() => {
                const dummyPngQrBase64 = Buffer.from('IMAGEN_QR_GENERADA_POR_ESCRITORIO_22070319').toString('base64');
                console.log(`🖥️  [Desktop] Imagen QR generada. Enviándola al Servidor para que la pase a Android...`);
                wsDesktop.send(JSON.stringify({
                    tipo: 'qr_generado',
                    numero_control: msg.alumno.numero_control,
                    imagen_qr_base64: dummyPngQrBase64
                }));
            }, 400);
        }

        if (msg.tipo === 'decodificar_foto_qr' && msg.pendiente) {
            console.log(`🖥️  [Desktop] Foto temporal de Arduino recibida por WS (${msg.imagen_base64.length} chars Base64). Decodificando QR...`);
            setTimeout(() => {
                const tokenSimulado = wsDesktop.nextTokenToDecode || '22070319';
                console.log(`🖥️  [Desktop] Enviando token decodificado "${tokenSimulado}" al servidor...`);
                wsDesktop.send(JSON.stringify({
                    tipo: 'verificar_qr',
                    token: tokenSimulado
                }));
            }, 600);
        }
    });

    // 4. Escuchar respuesta final en Arduino (LED VERDE o ROJO)
    wsArduino.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.tipo === 'resultado_asistencia') {
            console.log(`🤖 [Arduino] Respuesta del servidor: LED = ${msg.led} | ${msg.msg}`);
        }
    });

    // --- PASO 1: Android registra un alumno -> Servidor -> Desktop genera QR -> Servidor -> Android -> Telegram ---
    console.log('--- PASO 1: Flujo Registro + Generación de QR (Android -> Servidor -> Desktop -> Servidor -> Android) ---');
    wsAndroid.send(JSON.stringify({
        tipo: 'registrar_alumno',
        datos: {
            numero_control: '22070319',
            nombre_completo: 'Kevin Isai Vazquez Esquivel',
            semestre: '8vo / Ago-Dic 2026',
            grupo: 'A',
            chat_id_telegram: '987654321'
        }
    }));

    await new Promise((r) => setTimeout(r, 1200));

    // --- PASO 2: Arduino toma foto y el token SÍ existe (LED VERDE) ---
    console.log('\n--- PASO 2: Arduino envía foto del QR (Caso exitoso -> LED VERDE) ---');
    wsDesktop.nextTokenToDecode = '22070319';
    const dummyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
    wsArduino.send(dummyJpeg, { binary: true });

    await new Promise((r) => setTimeout(r, 1500));

    // --- PASO 3: Arduino toma foto y el token NO existe (LED ROJO) ---
    console.log('\n--- PASO 3: Arduino envía foto del QR (Caso alumno no encontrado -> LED ROJO) ---');
    wsDesktop.nextTokenToDecode = '99999999';
    wsArduino.send(JSON.stringify({
        tipo: 'captura_qr',
        imagen: dummyJpeg.toString('base64')
    }));

    await new Promise((r) => setTimeout(r, 1500));

    wsAndroid.close();
    wsDesktop.close();
    wsArduino.close();
    wsReact.close();
    console.log('\nSimulación WebSocket finalizada.');
}

runSimulation().catch((err) => {
    console.error('Error en la simulación WebSocket (¿está encendido el servidor y MySQL?):', err.message);
    process.exit(1);
});
