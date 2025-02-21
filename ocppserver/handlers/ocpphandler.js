const { v4: uuidv4 } = require('uuid');
const { log } = require('../utils/logger');
const { createSession, startTransaction, stopTransaction, updateStatus, getSessionInfo } = require('../utils/sessions');

const sendMessage = (ws, message) => {
  ws.send(JSON.stringify(message));
  log('outgoing', JSON.stringify(message));
};

const handleIncomingMessage = (ws, message) => {
  try {
    const [messageTypeId, uniqueId, action, payload] = JSON.parse(message);
    log('incoming', `Type: ${messageTypeId}, Action: ${action}, Payload: ${JSON.stringify(payload)}`);

    switch (action) {
      case 'BootNotification':
        handleBootNotification(ws, uniqueId, payload);
        break;
      case 'Heartbeat':
        handleHeartbeat(ws, uniqueId);
        break;
      case 'StatusNotification':
        handleStatusNotification(ws, uniqueId, payload);
        break;
      case 'StartTransaction':
        handleStartTransaction(ws, uniqueId, payload);
        break;
      case 'StopTransaction':
        handleStopTransaction(ws, uniqueId, payload);
        break;
      default:
        sendError(ws, uniqueId, `Unsupported action: ${action}`);
    }
  } catch (error) {
    log('error', `Invalid message format: ${error.message}`);
  }
};

const handleBootNotification = (ws, uniqueId, payload) => {
  const { chargePointModel, chargePointVendor } = payload;
  const chargePointId = ws._socket.remoteAddress;

  createSession(chargePointId);
  const response = [3, uniqueId, { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 }];
  sendMessage(ws, response);

  log('info', `BootNotification received from ${chargePointVendor} - ${chargePointModel}`);
};

const handleHeartbeat = (ws, uniqueId) => {
  const response = [3, uniqueId, { currentTime: new Date().toISOString() }];
  sendMessage(ws, response);
};

const handleStatusNotification = (ws, uniqueId, payload) => {
  const { status } = payload;
  const chargePointId = ws._socket.remoteAddress;

  updateStatus(chargePointId, status);
  const response = [3, uniqueId, {}];
  sendMessage(ws, response);

  log('info', `Charge point ${chargePointId} status updated to ${status}`);
};

const handleStartTransaction = (ws, uniqueId, payload) => {
  const { connectorId, idTag } = payload;
  const transactionId = Math.floor(Math.random() * 100000);
  const chargePointId = ws._socket.remoteAddress;

  startTransaction(chargePointId, transactionId, connectorId);

  const response = [3, uniqueId, { transactionId, idTagInfo: { status: 'Accepted' } }];
  sendMessage(ws, response);

  log('info', `Transaction ${transactionId} started on connector ${connectorId} with idTag ${idTag}`);
};

const handleStopTransaction = (ws, uniqueId, payload) => {
  const { transactionId } = payload;
  const chargePointId = ws._socket.remoteAddress;

  stopTransaction(chargePointId, transactionId);

  const response = [3, uniqueId, { idTagInfo: { status: 'Accepted' } }];
  sendMessage(ws, response);

  log('info', `Transaction ${transactionId} stopped for charge point ${chargePointId}`);
};

const sendError = (ws, uniqueId, errorMsg) => {
  const response = [4, uniqueId, 'ProtocolError', errorMsg, {}];
  sendMessage(ws, response);
};

module.exports = { handleIncomingMessage };
