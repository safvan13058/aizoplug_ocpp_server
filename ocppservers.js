const http = require("http");
const WebSocket = require("ws");
const mqtt = require("mqtt");
const awsIot = require("aws-iot-device-sdk");
const url = require("url");
const fs =require("fs");
// 🌐 AWS IoT MQTT Broker
const AWS_IOT_HOST = "an1ua1ij15hp7-ats.iot.ap-south-1.amazonaws.com";
const MQTT_TOPIC_BASE = "ocpp/chargingpoint/";

// 🌐 Create HTTP Server for WebSocket (WS)
const server = http.createServer();
const wss = new WebSocket.Server({ server });

console.log("🚀 WebSocket (WS) server starting on ws://host.aizoplug.com:80");

// 📡 Connect to AWS IoT MQTT Broker
const mqttClient = mqtt.connect(`mqtts://${AWS_IOT_HOST}`, {
    key: fs.readFileSync("private.pem.key"),
    cert: fs.readFileSync("certificate.pem.crt"),
    ca: fs.readFileSync("AmazonRootCA1.pem"),
});

mqttClient.on("connect", () => console.log("✅ Connected to AWS IoT Core (MQTT Broker)"));
mqttClient.on("error", (error) => console.error("❌ MQTT Connection Error:", error));

// 🌍 Handle WebSocket Connections (Charge Points)
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
        console.log(`✅ Connected to AWS IoT Device Shadow for ${stationId}`);
        deviceShadow.register(stationId, {}, () => console.log(`✅ Registered Shadow for ${stationId}`));
    });

    ws.on("message", (message) => {
        console.log("📩 Received OCPP message:", message.toString());
        try {
            const parsedMessage = JSON.parse(message);
            const messageId = parsedMessage[1];
            const ocppAction = parsedMessage[2] || "unknown_action";
            const payload = parsedMessage[3] || {};

            let response;
            switch (ocppAction) {
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
                case "StatusNotification":
                    response = [3, messageId, {}];
                    break;
                default:
                    response = [4, messageId, "NotImplemented", "Action not supported."];
            }

            ws.send(JSON.stringify(response));
            console.log(`📡 Station ID: ${stationId}, Action: ${ocppAction}`);

            const mqttTopic = `${MQTT_TOPIC_BASE}${stationId}/${ocppAction}`;
            mqttClient.publish(mqttTopic, JSON.stringify(payload));
        } catch (error) {
            console.error("❌ Error parsing OCPP message:", error);
        }
    });

    mqttClient.on("message", (topic, message) => {
        console.log(`📥 Received MQTT message on ${topic}:`, message.toString());
        ws.send(JSON.stringify({ topic, data: JSON.parse(message.toString()) }));
    });

    ws.on("close", () => {
        console.log(`🔌 Charge Point ${stationId} Disconnected`);
        deviceShadow.update(stationId, {
            state: { reported: { stationId, status: "disconnected", timestamp: new Date().toISOString() } },
        }, (err, data) => {
            if (err) console.error(`❌ Shadow Update Error:`, err);
            else console.log(`✅ Shadow Updated: ${JSON.stringify(data)}`);
        });
    });
});

// 🌐 Start WebSocket Server on Port 80
const PORT = 80;
server.listen(PORT, () => console.log(`🚀 WebSocket server running on port ${PORT}`));

