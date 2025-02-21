const WebSocket = require('ws');
const { handleIncomingMessage } = require('./handlers/ocpphandler');
const { log } = require('./utils/logger');

const PORT = 8080;
const wss = new WebSocket.Server({ port: PORT });

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  log('info', `New connection from ${clientIP}`);

  ws.on('message', (message) => handleIncomingMessage(ws, message));
  ws.on('close', () => log('info', `Connection closed by ${clientIP}`));
  ws.on('error', (error) => log('error', `Connection error from ${clientIP}: ${error.message}`));
});

log('info', `OCPP 1.6 WebSocket server is running on ws://localhost:${PORT}`);
