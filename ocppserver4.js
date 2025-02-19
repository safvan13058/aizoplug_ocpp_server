const fs = require("fs");
const https = require("https");
const WebSocket = require("ws");
const mqtt = require("mqtt");
const awsIot = require("aws-iot-device-sdk");
const url = require("url");

// 🌐 AWS IoT MQTT Broker
const AWS_IOT_HOST = "an1ua1ij15hp7-ats.iot.ap-south-1.amazonaws.com";
const MQTT_TOPIC_BASE = "ocpp/chargingpoint/";

// 🛡️ SSL Certificates for WSS
const serverOptions = {
    key: fs.readFileSync("/etc/letsencrypt/live/host.aizoplug.com/privkey.pem"),
    cert: fs.readFileSync("/etc/letsencrypt/live/host.aizoplug.com/fullchain.pem"),
    secureProtocol: "TLS_method", // Ensures TLS 1.2+
};

// 📡 Connect to AWS IoT MQTT Broker (single connection)
const mqttClient = mqtt.connect(`mqtts://${AWS_IOT_HOST}`, {
    key: fs.readFileSync("private.pem.key"),
    cert: fs.readFileSync("certificate.pem.crt"),
    ca: fs.readFileSync("AmazonRootCA1.pem"),
});

mqttClient.on("connect", () => console.log("✅ Connected to AWS IoT Core (MQTT Broker)"));
mqttClient.on("error", (error) => console.error("❌ MQTT Connection Error:", error));

// 🔌 Create HTTPS Server for WSS
const server = https.createServer(serverOptions);
const wss = new WebSocket.Server({ server, path: '/websocket/CentralSystemService' });

console.log("🚀 Secure WebSocket (WSS) server starting...");

// 🌍 Handle WebSocket Connections (Charge Points)
wss.on("connection", (ws, req) => {
    const queryParams = url.parse(req.url, true).query;
    const stationId = queryParams.stationId || req.socket.remoteAddress.replace(/^::ffff:/, "");

    console.log(`🔌 Charge Point Connected: ${stationId}`);

    // 📡 AWS IoT Device Shadow
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

    deviceShadow.on("error", (err) => console.error(`❌ Device Shadow Error (${stationId}):`, err));

    // 📩 Handle Incoming WebSocket Messages (OCPP 1.6)
    ws.on("message", (message) => {
        console.log("📩 Received OCPP message:", message.toString());
        try {
            const parsedMessage = JSON.parse(message);
            const [messageType, messageId, ocppAction, payload] = parsedMessage;

            if (ocppAction === "BootNotification") {
                const response = [3, messageId, {
                    currentTime: new Date().toISOString(),
                    interval: 300,
                    status: "Accepted",
                }];
                ws.send(JSON.stringify(response));
                console.log("✅ Responded: BootNotification Accepted");
                return;
            }

            if (ocppAction === "Authorize") {
                const response = [3, messageId, { idTagInfo: { status: "Accepted" } }];
                ws.send(JSON.stringify(response));
                console.log("✅ Responded: Authorize Accepted");
                return;
            }

            console.log(`📡 Station ID: ${stationId}, Action: ${ocppAction}`);
            const mqttTopic = `${MQTT_TOPIC_BASE}${stationId}/${ocppAction || "unknown"}`;
            mqttClient.publish(mqttTopic, JSON.stringify(payload), () => {
                console.log(`📤 Published to topic: ${mqttTopic}`);
            });

        } catch (error) {
            console.error("❌ Error parsing OCPP message:", error);
        }
    });

    // 📥 Handle Incoming MQTT Messages (AWS IoT → Charger)
    mqttClient.on("message", (topic, message) => {
        console.log(`📥 Received MQTT message on ${topic}:`, message.toString());
        const comment = topic.includes("remote/start") ? "🚀 Remote Start Command Received" :
                         topic.includes("remote/stop") ? "🛑 Remote Stop Command Received" :
                         topic.includes("reset") ? "🔄 Reset Command Received" :
                         topic.includes("unlock") ? "🔓 Unlock Connector Command Received" : "";

        const messageWithComment = {
            topic: topic,
            data: JSON.parse(message.toString()),
            comment: comment,
        };

        ws.send(JSON.stringify(messageWithComment));
    });

    // ❌ Handle WebSocket Disconnection
    ws.on("close", () => {
        console.log(`🔌 Charge Point ${stationId} Disconnected`);

        const disconnectShadowPayload = {
            state: {
                reported: {
                    stationId: stationId,
                    status: "disconnected",
                    timestamp: new Date().toISOString(),
                },
            },
        };

        console.log(`📥 Updating Device Shadow for ${stationId} (Disconnected)`);
        deviceShadow.update(stationId, disconnectShadowPayload, (err, data) => {
            if (err) console.error(`❌ Shadow Update Error for ${stationId}:`, err);
            else console.log(`✅ Shadow Update Success for ${stationId}:`, JSON.stringify(data));
        });
    });

    ws.on("error", (err) => {
        console.error(`❌ WebSocket Error for ${stationId}:`, err);
    });
});

// 🌐 Start Secure WebSocket Server on port 443
server.listen(8443, () => {
    console.log("🚀 Secure OCPP WebSocket Server Running on wss://host.aizoplug.com:443/websocket/CentralSystemService");
});

server.on("error", (err) => {
    console.error("❌ HTTPS Server Error:", err);
});
