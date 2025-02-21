const sessions = {};

const createSession = (chargePointId) => {
  if (!sessions[chargePointId]) {
    sessions[chargePointId] = { transactions: {}, status: 'Available' };
  }
};

const startTransaction = (chargePointId, transactionId, connectorId) => {
  sessions[chargePointId].transactions[transactionId] = {
    connectorId,
    startTime: new Date().toISOString(),
  };
};

const stopTransaction = (chargePointId, transactionId) => {
  const transaction = sessions[chargePointId]?.transactions[transactionId];
  if (transaction) {
    transaction.endTime = new Date().toISOString();
  }
};

const updateStatus = (chargePointId, status) => {
  sessions[chargePointId].status = status;
};

const getSessionInfo = (chargePointId) => sessions[chargePointId];

module.exports = {
  createSession,
  startTransaction,
  stopTransaction,
  updateStatus,
  getSessionInfo,
};
