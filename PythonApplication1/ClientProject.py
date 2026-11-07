"""
Simulador de pruebas para el Servidor SIGA (Node.js + Express + MySQL)
Permite probar de extremo a extremo los dos flujos del equipo:
1. Flujo de Registro de Alumno (Android -> Servidor -> App de Escritorio)
2. Flujo de Asistencia con conexión retenida (Arduino -> Servidor <-> App de Escritorio)
"""

import base64
import threading
import time
import requests

BASE_URL = "http://127.0.0.1:3010"


def probar_flujo_registro():
    print("\n=== 1. PROBANDO FLUJO DE REGISTRO DE ALUMNO ===")

    # Paso 1: Android envía el registro recibido desde Telegram
    nuevo_alumno = {
        "numero_control": "22070319",
        "nombre_completo": "Kevin Isai Vazquez Esquivel",
        "semestre": "8vo / Ago-Dic 2026",
        "grupo": "A",
        "chat_id_telegram": "987654321"
    }
    res = requests.post(f"{BASE_URL}/api/alumnos", json=nuevo_alumno)
    print(f"[Android -> Servidor] POST /api/alumnos ({res.status_code}):", res.json())

    # Paso 2: La App de Escritorio consulta los alumnos pendientes de QR
    res_pendientes = requests.get(f"{BASE_URL}/api/alumnos/pendientes-qr")
    print(f"[Desktop <- Servidor] GET /api/alumnos/pendientes-qr ({res_pendientes.status_code}):", res_pendientes.json())

    # Paso 3: La App de Escritorio marca el QR como enviado por Telegram
    res_qr = requests.put(f"{BASE_URL}/api/alumnos/22070319/qr-enviado")
    print(f"[Desktop -> Servidor] PUT /api/alumnos/22070319/qr-enviado ({res_qr.status_code}):", res_qr.json())


def probar_flujo_asistencia(token_a_enviar="22070319"):
    print(f"\n=== 2. PROBANDO FLUJO DE ASISTENCIA (Token: {token_a_enviar}) ===")

    # Creamos una imagen JPEG mínima de prueba en Base64
    dummy_jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00`\x00`\x00\x00\xff\xd9"
    imagen_b64 = base64.b64encode(dummy_jpeg).decode("utf-8")

    def tarea_arduino():
        print("[Arduino] Enviando foto y dejando la conexión abierta...")
        inicio = time.time()
        resp = requests.post(
            f"{BASE_URL}/api/asistencias/captura",
            json={"imagen": imagen_b64},
            timeout=35
        )
        duracion = round(time.time() - inicio, 2)
        datos = resp.json()
        print(f"[Arduino] Respuesta recibida en {duracion}s ({resp.status_code}): LED = {datos.get('led')} | {datos}")

    # Iniciamos la petición de Arduino en un hilo separado porque queda abierta esperando
    hilo_arduino = threading.Thread(target=tarea_arduino)
    hilo_arduino.start()

    # Simulamos que la App de Escritorio tarda 1.5 segundos en pedir la foto y decodificar el QR
    time.sleep(1.5)
    foto_resp = requests.get(f"{BASE_URL}/api/asistencias/foto-pendiente")
    print(f"[Desktop] Foto temporal descargada ({foto_resp.status_code}, {len(foto_resp.content)} bytes). Decodificando QR...")

    time.sleep(1.0)
    print(f"[Desktop] Enviando token decodificado '{token_a_enviar}' al servidor...")
    verif_resp = requests.post(
        f"{BASE_URL}/api/asistencias/verificar-qr",
        json={"token": token_a_enviar}
    )
    print(f"[Desktop] Respuesta del servidor ({verif_resp.status_code}):", verif_resp.json())

    hilo_arduino.join()


if __name__ == "__main__":
    probar_flujo_registro()
    # Caso exitoso -> Arduino prende LED VERDE
    probar_flujo_asistencia("22070319")
    # Caso alumno no registrado -> Arduino prende LED ROJO
    probar_flujo_asistencia("99999999")
