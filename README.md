# WasapKio Backend

Backend de WasapKio, un puente entre WhatsApp Web y clientes Nokia J2ME. Permite gestionar sesiones de WhatsApp mediante autenticación QR y conecta el cliente móvil con los servicios del servidor a través de una API REST y un canal TCP en tiempo real.

## Funcionalidades

- Autenticación de WhatsApp mediante código QR.
- Gestión de sesiones persistentes y reconexión automática.
- Envío y recepción de mensajes de texto.
- Envío y descarga de imágenes, documentos y audios.
- Sincronización de contactos, chats y mensajes.
- Notificaciones en tiempo real mediante servidor TCP.
- Almacenamiento de datos en MySQL.
- Cola de salida para mensajes pendientes.
- Procesamiento multimedia con FFmpeg y Sharp.
- Limpieza automática de sesiones y archivos inactivos.

## Tecnologías

- Node.js 20+
- Express
- WhatsApp Baileys
- MySQL / MariaDB
- TCP Server
- Docker
- FFmpeg
- Sharp

## Endpoints principales

- `POST /link` — crea una nueva sesión de WhatsApp.
- `GET /status/:userId` — consulta el estado y código QR.
- `GET /contacts/:userId` — obtiene la lista de contactos.
- `GET /chats/:userId` — obtiene los chats paginados.
- `GET /messages/:userId/:chatId` — obtiene los mensajes.
- `POST /send` — envía un mensaje de texto.
- `POST /sendimage` — envía una imagen.
- `POST /senddoc` — envía un documento.
- `POST /sendaudio` — envía un audio.
- `GET /media/:userId/:messageId` — descarga multimedia.
- `POST /logout/:userId` — cierra y elimina una sesión.

## Requisitos

- Node.js 20 o superior
- MySQL o MariaDB
- FFmpeg
- Dependencias de Node.js

## Instalación

```bash
npm install
Copia el archivo de ejemplo y configura tus variables:

cp env.example .env
Configura principalmente:

PORT=3000
TCP_PORT=3001
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=tu_password
DB_NAME=wpjava
SESSIONS_DIR=./sessions
DATA_DIR=./data
Importa la estructura de la base de datos:

mysql -u root -p wpjava < WPJava.sql
Inicia el servidor:

npm start
Docker
El proyecto incluye configuración para Node.js 20 y FFmpeg. El contenedor expone el servicio HTTP en el puerto 8080 y el servicio TCP en el puerto 3001.
