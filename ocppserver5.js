const http = require("http");
const WebSocket = require("ws");
const mqtt = require("mqtt");
const awsIot = require("aws-iot-device-sdk");
const url = require("url");
const fs = require("fs");

// 🌐 AWS IoT MQTT Broker Config
const AWS_IOT_HOST = "an1ua1ij15hp7-ats.iot.ap-south-1.amazonaws.com";

// ✅ Make deviceShadows global
const deviceShadows = {};

// 🌍 Create HTTP Server for WebSocket
const server = http.createServer();
const wss = new WebSocket.Server({ server });

console.log("🚀 WebSocket server starting on ws://host.aizoplug.com:80");
const disconnectTimers = {};
// 📡 Connect to AWS IoT Core (MQTT Broker)
const mqttClient = mqtt.connect(`mqtts://${AWS_IOT_HOST}`, {
  key: fs.readFileSync("private.pem.key"),
  cert: fs.readFileSync("certificate.pem.crt"),
  ca: fs.readFileSync("AmazonRootCA1.pem"),
});

mqttClient.on("connect", () => {
  console.log("✅ Connected to AWS IoT Core (MQTT Broker)");

  // 🌐 Subscribe to all incoming commands: +/in
  mqttClient.subscribe("+/in", (err) => {
    if (err) console.error("❌ Subscription Error:", err);
    else console.log("📡 Subscribed to +/in for incoming commands");
  });
});

mqttClient.on("error", (error) =>
  console.error("❌ MQTT Connection Error:", error)
);

// 🚀 WebSocket (Charge Point) Connection Handling
wss.on("connection", (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
  const stationIdFromPath = pathSegments[2];
  ws.stationId =
    stationIdFromPath || req.socket.remoteAddress.replace(/^::ffff:/, "");
  console.log(`🔌 Charge Point Connected (Temporary ID): ${ws.stationId}`);

  ws.isAlive = true;
  let isStationIdUpdated = false;

  const initializeDeviceShadow = (stationId) => {
    if (deviceShadows[stationId]) {
      console.log(
        `⚠️ Device Shadow already initialized for ${stationId}, skipping re-init.`
      );
      return;
    }

    deviceShadows[stationId] = awsIot.thingShadow({
      keyPath: "private.pem.key",
      certPath: "certificate.pem.crt",
      caPath: "AmazonRootCA1.pem",
      clientId: ws.stationId,
      host: AWS_IOT_HOST,
    });

    deviceShadows[stationId].on("connect", () => {
      console.log(`✅ Connected to Device Shadow for ${stationId}`);
      deviceShadows[stationId].register(stationId, {}, () =>
        console.log(`✅ Registered Shadow for ${stationId}`)
      );
    });
  };

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", async (message) => {
    console.log("📩 Received OCPP Message:",  JSON.parse(message.toString()));

    try {
      const parsed = JSON.parse(message);
      const messageType = parsed[0];
      const messageId = parsed[1];

      let action = null;
      let payload = null;

      if (messageType === 2) {
        // CALL
        action = parsed[2];
        payload = parsed[3];
      } else if (messageType === 3) {
        // CALLRESULT
        payload = parsed[2];
        action = `[CALLRESULT:${messageId}]`;
      } else if (messageType === 4) {
        // CALLERROR
        payload = { errorCode: parsed[2], errorDescription: parsed[3] };
        action = `[CALLERROR:${messageId}]`;
      } else {
        console.warn(`⚠️ Unknown message type: ${messageType}`);
        return;
      }

      if (messageType === 2) {
        if (action === "BootNotification") {
          console.log("isStationIdUpdated===========", isStationIdUpdated);
          if (payload.chargePointSerialNumber) {
            ws.stationId = payload.chargePointSerialNumber;
          }
          if (isStationIdUpdated) {
            console.log(
              `⚠️ BootNotification already processed for ${ws.stationId}, ignoring duplicate.`
            );
            return;
          }

          isStationIdUpdated = true;
          console.log(`✅ Updated Station ID: ${ws.stationId}`);

          initializeDeviceShadow(ws.stationId);

          const bootResponse = [
            3,
            messageId,
            {
              currentTime: new Date().toISOString(),
              interval: 300,
              status: "Accepted",
            },
          ];
          ws.send(JSON.stringify(bootResponse));

          console.log(`✅ Responded to BootNotification for ${ws.stationId}`);

          deviceShadows[ws.stationId].update(
            ws.stationId,
            {
              state: {
                reported: {
                  deviceData: {
                    action,
                    bootPayload: payload,
                    timestamp: new Date().toISOString(),
                  },
                },
              },
            },
            (err) => {
              if (err) console.error(`❌ Shadow Update Error:`, err);
              else
                console.log(`✅ Shadow Updated (deviceData) for ${ws.stationId}`);
            }
          );

          return;
        }

        let response;
        console.log("actions======",action);
        switch (action) {
        
          case "Authorize":
            response = [3, messageId, { idTagInfo: { status: "Accepted" } }];
            break;
          case "StartTransaction":
            response = [
              3,
              messageId,
              {
                transactionId: Math.floor(Math.random() * 100000),
                idTagInfo: { status: "Accepted" },
              },
            ];
            break;
          case "StopTransaction":
            response = [3, messageId, { idTagInfo: { status: "Accepted" } }];
            break;
          case "Heartbeat":
            response = [3, messageId, { currentTime: new Date().toISOString() }];
            break;
          case "StatusNotification":
            response = [3, messageId, {}];
            break;
          case "RemoteStartTransaction":
          case "RemoteStopTransaction":
            response = [3, messageId, { status: "Accepted" }];
            break;
          default:
            response = [4, messageId, "NotImplemented", "Action not supported."];
        }

        ws.send(JSON.stringify(response));
        console.log(`✅ Responded to ${action} for ${ws.stationId}`);

        if (action !== "Heartbeat") {
          const mqttTopic = `${ws.stationId}/out`;
          mqttClient.publish(mqttTopic, JSON.stringify({ action, payload }));
          console.log(`📤 Published response to ${mqttTopic}`);
        }

        if (action !== "Heartbeat") {
          if (deviceShadows[ws.stationId]) {
            deviceShadows[ws.stationId].update(
              ws.stationId,
              {
                state: {
                  reported: {
                    stationId: ws.stationId,
                    action,
                    status: payload,
                    transactionId: payload.transactionId || null,
                    timestamp: new Date().toISOString(),
                  },
                },
              },
              (err) => {
                if (err) console.error(`❌ Shadow Update Error:`, err);
                else
                  console.log(`✅ Shadow Updated (${action}) for ${ws.stationId}`);
              }
            );
          } else {
            console.warn(
              `⚠️ Device Shadow not initialized yet for ${ws.stationId} → skipping update for ${action}`
            );
            initializeDeviceShadow(ws.stationId);
          }
        }
      } else {
        // For CALLRESULT or CALLERROR
        const mqttTopic = `${ws.stationId}/out`;
        mqttClient.publish(mqttTopic, JSON.stringify({ action, payload }));
        console.log(`📤 Published response to ${mqttTopic}`);
      }
    } catch (err) {
      console.error("❌ Error parsing OCPP message:", err);
    }
  });

  mqttClient.on("message", (topic, message) => {
    console.log(`📥 MQTT Message on ${topic}:`, message.toString());

    const [incomingStationId, direction] = topic.split("/");

    if (direction !== "in" || ws.stationId !== incomingStationId) return;

    const trimmedMessage = message.toString().trim();

    if (!trimmedMessage.startsWith("{") || !trimmedMessage.endsWith("}")) {
      console.error("❌ Invalid JSON format in MQTT message:", trimmedMessage);
      return;
    }
    console.log("message", trimmedMessage);
    const payload = JSON.parse(trimmedMessage);
    const action = payload.action || "RemoteStartTransaction";

    const command = [2, `${Date.now()}`, action, payload.data || {}];
    ws.send(JSON.stringify(command));
    console.log(`▶️ Sent ${action} to Charge Point (${ws.stationId})`);
  });

  ws.on("close", () => {
    console.log(`🔌 Charge Point ${ws.stationId} Disconnected`);

    if (!ws.stationId || !deviceShadows[ws.stationId]) {
      console.log(`⚠️ Skipping Shadow Update: Missing stationId or deviceShadow`);
      return;
    }
    deviceShadows[ws.stationId].update(
      ws.stationId,
      {
        state: {
          desired: {
            command: "device_update",
            status: "disconnected",
            timestamp: new Date().toISOString(),
          },
        },
      },
      (err) => {
        if (err) console.error(`❌ Shadow Update Error (Close Event):`, err);
        else console.log(`✅ Shadow Updated: ${ws.stationId} disconnected`);
      }
    );

    delete deviceShadows[ws.stationId];
  });

  ws.pingInterval = setInterval(() => {
    if (!ws.isAlive) {
      console.log(`⚠️ Force closing inactive WebSocket for ${ws.stationId}`);

      clearInterval(ws.pingInterval);
      ws.pingInterval = null;

      if (ws._terminated) return;
      ws._terminated = true;

      if (ws.stationId && deviceShadows[ws.stationId]) {
        deviceShadows[ws.stationId].update(
          ws.stationId,
          {
            state: {
              desired: {
                command: "device_update",
                status: "disconnected",
                timestamp: new Date().toISOString(),
              },
            },
          },
          (err) => {
            if (err) console.error(`❌ Shadow Update Error (Timeout):`, err);
            else
              console.log(
                `✅ Shadow Updated: ${ws.stationId} disconnected due to timeout`
              );
          }
        );
      }

      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  }, 30000);
});

// 🌐 Start WebSocket Server
const PORT = 80;
server.listen(PORT, () =>
  console.log(`🚀 WebSocket server running on port ${PORT}`)
);
