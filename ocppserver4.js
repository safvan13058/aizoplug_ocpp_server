const WebSocket = require("ws");
const mqtt = require("mqtt");
const awsIot = require("aws-iot-device-sdk");
const fs = require("fs");
const url = require("url");

const MQTT_TOPIC_BASE = "ocpp/chargingpoint/";
const AWS_IOT_HOST = "an1ua1ij15hp7-ats.iot.ap-south-1.amazonaws.com";

// Store device shadow instances to prevent multiple connections
const deviceShadows = {};

// Create WebSocket server on port 9000
const wss = new WebSocket.Server({ port: 9000 });
console.log("🚀 OCPP WebSocket server started on ws://13.235.49.231:9000");

// Connect to AWS IoT MQTT Broker
const mqttClient = mqtt.connect(`mqtts://${AWS_IOT_HOST}`, {
    key: fs.readFileSync("private.pem.key"),
    cert: fs.readFileSync("certificate.pem.crt"),
    ca: fs.readFileSync("AmazonRootCA1.pem"),
});

mqttClient.on("connect", () => console.log("✅ Connected to MQTT broker"));
mqttClient.on("error", (error) => console.error("❌ MQTT Connection Error:", error));

wss.on("connection", (ws, req) => {
    const queryParams = url.parse(req.url, true).query;
    const stationId = queryParams.stationId || req.socket.remoteAddress.replace(/^::ffff:/, "");
    console.log(`🔌 New charge point connected: ${stationId}`);

    ws.isAlive = true; // Track connection status

    // Check if Device Shadow already exists
    if (!deviceShadows[stationId]) {
        console.log(`🆕 Creating Device Shadow for ${stationId}`);

        // Create and store a new device shadow instance
        deviceShadows[stationId] = awsIot.thingShadow({
            keyPath: "private.pem.key",
            certPath: "certificate.pem.crt",
            caPath: "AmazonRootCA1.pem",
            clientId: stationId,
            host: AWS_IOT_HOST,
        });

        deviceShadows[stationId].on("connect", () => {
            console.log(`✅ Connected to AWS IoT Device Shadow for ${stationId}`);

            deviceShadows[stationId].register(stationId, {}, () => {
                console.log(`✅ Registered Shadow for ${stationId}`);
            });
        });
    } else {
        console.log(`🔄 Reusing existing Device Shadow for ${stationId}`);
    }

    ws.on("message", (message) => {
        console.log("📩 Received OCPP message:", message.toString());

        try {
            const parsedMessage = JSON.parse(message);
            const messageId = parsedMessage[1];
            const ocppAction = parsedMessage[2] || "unknown_action";
            const payload = parsedMessage[3] || {};

            if (ocppAction === "Authorize") {
                const response = [3, messageId, { "idTagInfo": { "status": "Accepted" } }];
                ws.send(JSON.stringify(response));
                console.log("✅ Sent: Authorize Accepted");
                return;
            }

            console.log(`📡 Station ID: ${stationId}, Action: ${ocppAction}`);
            let mqttTopic = `${MQTT_TOPIC_BASE}${stationId}/${ocppAction || "unknown"}`;

            console.log(`📤 Publishing to topic: ${mqttTopic}`);
            mqttClient.publish(mqttTopic, JSON.stringify(payload));
        } catch (error) {
            console.error("❌ Error parsing OCPP message:", error);
        }
    });

    ws.on("close", () => {
        console.log(`🔌 Charge point ${stationId} disconnected`);

        if (deviceShadows[stationId]) {
            console.log(`📥 Updating Device Shadow for ${stationId} (Disconnected)`);

            const disconnectShadowPayload = {
                state: {
                    reported: {
                        stationId: stationId,
                        status: "disconnected",
                        timestamp: new Date().toISOString(),
                    },
                },
            };

            deviceShadows[stationId].update(stationId, disconnectShadowPayload, (err, data) => {
                if (err) {
                    console.error(`❌ Shadow Update Error for ${stationId}:`, err);
                } else {
                    console.log(`✅ Shadow Update Success for ${stationId}:`, JSON.stringify(data));
                }
            });

            console.log(`🗑️ Unregistering Device Shadow for ${stationId}`);
            deviceShadows[stationId].unregister(stationId);
            delete deviceShadows[stationId]; // Remove shadow from memory
        }
    });

    ws.on("error", (err) => {
        console.error(`❌ WebSocket Error for ${stationId}:`, err);
    });

    ws.on("unexpected-response", (req, res) => {
        console.error(`⚠️ Unexpected WebSocket Response (${stationId}):`, res.statusCode);
    });
});

// 🔄 Check WebSocket connections every 30 seconds
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            console.log("❌ WebSocket unresponsive, terminating...");
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);
