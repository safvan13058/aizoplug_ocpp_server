const http = require("http");
const WebSocket = require("ws");
const mqtt = require("mqtt");
const awsIot = require("aws-iot-device-sdk");
const url = require("url");
const fs = require("fs");

// 🌐 AWS IoT MQTT Broker Config
const AWS_IOT_HOST = "an1ua1ij15hp7-ats.iot.ap-south-1.amazonaws.com";
const MQTT_TOPIC_BASE = "ocpp/chargingpoint/";

// 🌍 Create HTTP Server for WebSocket (OCPP Communication)
const server = http.createServer();
const wss = new WebSocket.Server({ server });

console.log("🚀 WebSocket server starting on ws://host.aizoplug.com:80");

// 📡 Connect to AWS IoT Core (MQTT Broker)
const mqttClient = mqtt.connect(`mqtts://${AWS_IOT_HOST}`, {
    key: fs.readFileSync("private.pem.key"),
    cert: fs.readFileSync("certificate.pem.crt"),
    ca: fs.readFileSync("AmazonRootCA1.pem"),
});

mqttClient.on("connect", () => console.log("✅ Connected to AWS IoT Core (MQTT Broker)"));
mqttClient.on("error", (error) => console.error("❌ MQTT Connection Error:", error));

// 🌍 Handle WebSocket (Charge Point) Connections
wss.on("connection", (ws, req) => {
    const queryParams = url.parse(req.url, true).query;
    const stationId = queryParams.stationId || req.socket.remoteAddress.replace(/^::ffff:/, "");

    console.log(`🔌 Charge Point Connected: ${stationId}`);

    const deviceShadow = awsIot.thingShadow({
        keyPath: "private.pem.key",
        certPath: "certificate.pem.crt",
        caPath: "AmazonRootCA1.pem",
        clientId: stationId,
        host: AWS_IOT_HOST,
    });

    deviceShadow.on("connect", () => {
        console.log(`✅ Connected to Device Shadow for ${stationId}`);
        deviceShadow.register(stationId, {}, () => console.log(`✅ Registered Shadow for ${stationId}`));
    });

    // 🔄 Subscribe to MQTT Topics for Remote Commands
    const remoteStartTopic = `${MQTT_TOPIC_BASE}${stationId}/RemoteStartTransaction`;
    const remoteStopTopic = `${MQTT_TOPIC_BASE}${stationId}/RemoteStopTransaction`;
    mqttClient.subscribe([remoteStartTopic, remoteStopTopic], (err) => {
        if (err) console.error(`❌ Subscription Error:`, err);
        else console.log(`📡 Subscribed to Remote Start/Stop Topics for ${stationId}`);
    });

    // 📥 Handle Remote Start/Stop Commands from MQTT
    mqttClient.on("message", (topic, message) => {
        console.log(`📥 MQTT Message on ${topic}:`, message.toString());
        const payload = JSON.parse(message.toString());

        if (topic === remoteStartTopic) {
            const startCommand = [2, `${Date.now()}`, "RemoteStartTransaction", { idTag: payload.idTag }];
            ws.send(JSON.stringify(startCommand));
            console.log(`▶️ Sent RemoteStartTransaction to ${stationId}`);
        }

        if (topic === remoteStopTopic) {
            const stopCommand = [2, `${Date.now()}`, "RemoteStopTransaction", { transactionId: payload.transactionId }];
            ws.send(JSON.stringify(stopCommand));
            console.log(`⏹️ Sent RemoteStopTransaction to ${stationId}`);
        }
    });

    // 📩 Handle Messages from Charge Point (WebSocket)
    ws.on("message", (message) => {
        console.log("📩 Received OCPP Message:", message.toString());
        try {
            const parsedMessage = JSON.parse(message);
            const [messageType, messageId, action, payload] = parsedMessage;

            let response;

            switch (action) {
                case "BootNotification":
                    response = [3, messageId, { currentTime: new Date().toISOString(), interval: 300, status: "Accepted" }];
                    break;

                case "Authorize":
                    response = [3, messageId, { idTagInfo: { status: "Accepted" } }];
                    break;

                case "StartTransaction":
                    response = [3, messageId, { transactionId: Math.floor(Math.random() * 100000), idTagInfo: { status: "Accepted" } }];
                    break;

                case "StopTransaction":
                    response = [3, messageId, { idTagInfo: { status: "Accepted" } }];
                    break;

                case "Heartbeat":
                    response = [3, messageId, { currentTime: new Date().toISOString() }];
                    break;

                case "RemoteStartTransaction":
                case "RemoteStopTransaction":
                    response = [3, messageId, { status: "Accepted" }];
                    break;

                default:
                    response = [4, messageId, "NotImplemented", "Action not supported."];
            }

            ws.send(JSON.stringify(response));
            console.log(`✅ Responded to ${action} from ${stationId}`);

            // 📡 Publish to MQTT for Monitoring
            const mqttTopic = `${MQTT_TOPIC_BASE}${stationId}/${action}`;
            mqttClient.publish(mqttTopic, JSON.stringify(payload));

            // 📢 Update Device Shadow Status
            if (["StartTransaction", "StopTransaction"].includes(action)) {
                deviceShadow.update(stationId, {
                    state: {
                        reported: {
                            stationId,
                            status: action === "StartTransaction" ? "charging" : "idle",
                            transactionId: payload.transactionId || null,
                            timestamp: new Date().toISOString(),
                        },
                    },
                }, (err) => {
                    if (err) console.error(`❌ Shadow Update Error:`, err);
                    else console.log(`✅ Shadow Updated for ${stationId} (${action})`);
                });
            }

        } catch (error) {
            console.error("❌ Error handling OCPP message:", error);
        }
    });

    // 🔌 Handle WebSocket Disconnection
    ws.on("close", () => {
        console.log(`🔌 Charge Point ${stationId} Disconnected`);
        deviceShadow.update(stationId, {
            state: {
                reported: {
                    stationId,
                    status: "disconnected",
                    timestamp: new Date().toISOString(),
                },
            },
        }, (err) => {
            if (err) console.error(`❌ Shadow Update Error:`, err);
            else console.log(`✅ Shadow Updated: ${stationId} is disconnected`);
        });
    });
});

// 🌐 Start WebSocket Server
const PORT = 80;
server.listen(PORT, () => console.log(`🚀 WebSocket server running on port ${PORT}`));
