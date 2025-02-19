const fs = require("fs");
const https = require("https");
const WebSocket = require("ws");
const mqtt = require("mqtt");
const awsIot = require("aws-iot-device-sdk");
const url = require("url");

// 🌐 AWS IoT MQTT Broker
const AWS_IOT_HOST = "an1ua1ij15hp7-ats.iot.ap-south-1.amazonaws.com";
const MQTT_TOPIC_BASE = "ocpp/chargingpoint/";

// 🛡️ SSL Certificates for Secure WebSockets (WSS)
const serverOptions = {
    key: fs.readFileSync("/etc/letsencrypt/live/host.aizoplug.com/privkey.pem"),
    cert: fs.readFileSync("/etc/letsencrypt/live/host.aizoplug.com/fullchain.pem"),
};

// 🔌 Create HTTPS Server for WebSocket Secure (WSS)
const server = https.createServer(serverOptions);
const wss = new WebSocket.Server({ server });

console.log("🚀 Secure WebSocket (WSS) server started on wss://host.aizoplug.com:8080");

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
                    response = [3, messageId, {
                        currentTime: new Date().toISOString(),
                        interval: 300,
                        status: "Accepted",
                    }];
                    console.log("✅ Responded: BootNotification Accepted");
                    break;

                case "Authorize":
                    response = [3, messageId, { idTagInfo: { status: "Accepted" } }];
                    console.log("✅ Responded: Authorize Accepted");
                    break;

                case "StartTransaction":
                    response = [3, messageId, {
                        transactionId: Math.floor(Math.random() * 100000),
                        idTagInfo: { status: "Accepted" },
                    }];
                    console.log("✅ Responded: StartTransaction Accepted");
                    break;

                case "StopTransaction":
                    response = [3, messageId, { idTagInfo: { status: "Accepted" } }];
                    console.log("✅ Responded: StopTransaction Accepted");
                    break;

                case "Heartbeat":
                    response = [3, messageId, { currentTime: new Date().toISOString() }];
                    console.log("✅ Responded: Heartbeat");
                    break;

                case "StatusNotification":
                    response = [3, messageId, {}];
                    console.log("✅ Responded: StatusNotification Acknowledged");
                    break;

                default:
                    response = [4, messageId, "NotImplemented", "Action not supported."];
                    console.log(`⚠️ Responded: ${ocppAction} not implemented`);
            }

            ws.send(JSON.stringify(response));
            const mqttTopic = `${MQTT_TOPIC_BASE}${stationId}/${ocppAction}`;
            mqttClient.publish(mqttTopic, JSON.stringify(payload));
        } catch (error) {
            console.error("❌ Error parsing OCPP message:", error);
        }
    });

    mqttClient.on("message", (topic, message) => {
        console.log(`📥 Received MQTT message on ${topic}:`, message.toString());
        
        const mqttResponse = {
            topic,
            data: JSON.parse(message.toString()),
            comment: topic.includes("remote/start") ? "🚀 Remote Start Command Received" :
                     topic.includes("remote/stop") ? "🛑 Remote Stop Command Received" :
                     topic.includes("reset") ? "🔄 Reset Command Received" :
                     topic.includes("unlock") ? "🔓 Unlock Connector Command Received" : "",
        };

        ws.send(JSON.stringify(mqttResponse));
    });

    ws.on("close", () => {
        console.log(`🔌 Charge Point ${stationId} Disconnected`);

        const disconnectPayload = {
            state: {
                reported: {
                    stationId,
                    status: "disconnected",
                    timestamp: new Date().toISOString(),
                },
            },
        };

        deviceShadow.update(stationId, disconnectPayload, (err, data) => {
            if (err) {
                console.error(`❌ Shadow Update Error for ${stationId}:`, err);
            } else {
                console.log(`✅ Shadow Update Success for ${stationId}:`, JSON.stringify(data));
            }
        });
    });
});

server.listen(8080, () => {
    console.log("🚀 Secure OCPP WebSocket Server Running on wss://host.aizoplug.com:8080");
});
