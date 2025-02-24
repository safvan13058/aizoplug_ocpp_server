const http = require("http");
const WebSocket = require("ws");
const mqtt = require("mqtt");
const awsIot = require("aws-iot-device-sdk");
const url = require("url");
const fs = require("fs");

// 🌐 AWS IoT MQTT Broker Config
const AWS_IOT_HOST = "an1ua1ij15hp7-ats.iot.ap-south-1.amazonaws.com";
const MQTT_TOPIC_BASE = "ocpp/chargingpoint/";

// 🌍 Create HTTP Server for WebSocket
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

// 🚀 WebSocket (Charge Point) Connection Handling
wss.on("connection", (ws, req) => {
    // Assign temporary stationId from URL or IP
    let stationId = url.parse(req.url, true).query.stationId || req.socket.remoteAddress.replace(/^::ffff:/, "");
    console.log(`🔌 Charge Point Connected (Temporary ID): ${stationId}`);

    let deviceShadow;
    let isStationIdUpdated = false;

    const subscribeToRemoteCommands = (stationId) => {
        const remoteStartTopic = `${MQTT_TOPIC_BASE}${stationId}/RemoteStartTransaction`;
        const remoteStopTopic = `${MQTT_TOPIC_BASE}${stationId}/RemoteStopTransaction`;

        mqttClient.subscribe([remoteStartTopic, remoteStopTopic], (err) => {
            if (err) console.error(`❌ Subscription Error for ${stationId}:`, err);
            else console.log(`📡 Subscribed to Remote Start/Stop Topics for ${stationId}`);
        });
    };

    const initializeDeviceShadow = (stationId) => {
        deviceShadow = awsIot.thingShadow({
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
    };

    // 📥 Handle WebSocket Messages (from Charge Point)
    ws.on("message", (message) => {
        console.log("📩 Received OCPP Message:", message.toString());

        try {
            const [messageType, messageId, action, payload] = JSON.parse(message);

            // 🚀 Handle BootNotification to extract stationId
            if (action === "BootNotification" && payload.chargePointSerialNumber && !isStationIdUpdated) {
                stationId = payload.chargePointSerialNumber;  // Update stationId (e.g., "cp_3")
                isStationIdUpdated = true;

                console.log(`✅ Updated Station ID: ${stationId}`);
                initializeDeviceShadow(stationId);          // Initialize device shadow
                subscribeToRemoteCommands(stationId);       // Subscribe to remote commands

                const bootResponse = [3, messageId, {
                    currentTime: new Date().toISOString(),
                    interval: 300,
                    status: "Accepted"
                }];
                ws.send(JSON.stringify(bootResponse));
                console.log(`✅ Responded to BootNotification for ${stationId}`);
                return;
            }

            // 📡 Handle OCPP Actions and Respond
            let response;
            switch (action) {
                case "Authorize":
                    response = [3, messageId, { idTagInfo: { status: "Accepted" } }];
                    break;
                case "StartTransaction":
                    response = [3, messageId, {
                        transactionId: Math.floor(Math.random() * 100000),
                        idTagInfo: { status: "Accepted" }
                    }];
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
            console.log(`✅ Responded to ${action} for ${stationId}`);

            // 🔔 Publish payload to MQTT for monitoring
            const mqttTopic = `${MQTT_TOPIC_BASE}${stationId}/${action}`;
            mqttClient.publish(mqttTopic, JSON.stringify(payload));

            // 📢 Update Device Shadow on Start/Stop Transaction
            if (["StartTransaction", "StopTransaction"].includes(action)) {
                const status = action === "StartTransaction" ? "charging" : "idle";
                deviceShadow.update(stationId, {
                    state: {
                        reported: {
                            stationId,
                            status,
                            transactionId: payload.transactionId || null,
                            timestamp: new Date().toISOString(),
                        },
                    },
                }, (err) => {
                    if (err) console.error(`❌ Shadow Update Error:`, err);
                    else console.log(`✅ Shadow Updated (${status}) for ${stationId}`);
                });
            }

        } catch (err) {
            console.error("❌ Error parsing OCPP message:", err);
        }
    });

    // 📥 Handle MQTT Remote Start/Stop Commands
    mqttClient.on("message", (topic, message) => {
        console.log(`📥 MQTT Message on ${topic}:`, message.toString());
        if (!isStationIdUpdated) return; // Ignore if stationId not set

        const payload = JSON.parse(message.toString());
        const action = topic.includes("RemoteStartTransaction") ? "RemoteStartTransaction" : "RemoteStopTransaction";
        const command = [2, `${Date.now()}`, action, payload];

        ws.send(JSON.stringify(command));
        console.log(`▶️ Sent ${action} to Charge Point (${stationId})`);
    });

    // 🔌 Handle Charge Point Disconnection
    ws.on("close", () => {
        console.log(`🔌 Charge Point ${stationId} Disconnected`);
        if (deviceShadow) {
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
                else console.log(`✅ Shadow Updated: ${stationId} disconnected`);
            });
        }
    });
});

// 🌐 Start WebSocket Server
const PORT = 80;
server.listen(PORT, () => console.log(`🚀 WebSocket server running on port ${PORT}`));
