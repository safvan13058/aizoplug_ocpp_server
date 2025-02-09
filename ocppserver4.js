const WebSocket = require("ws");
const mqtt = require("mqtt");
const awsIot = require("aws-iot-device-sdk");
const fs = require("fs");
const url = require("url");

const MQTT_TOPIC_BASE = "ocpp/chargingpoint/";
const AWS_IOT_HOST = "an1ua1ij15hp7-ats.iot.ap-south-1.amazonaws.com";

const wss = new WebSocket.Server({ port: 9000 });
console.log("🚀 OCPP WebSocket server started on ws://13.235.49.231:9000");

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
           
            if (ocppAction === "Authorize") {
                // 🟢 Always accept authorization for now
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

    mqttClient.on("message", (topic, message) => {
        console.log(`📥 Received MQTT message on ${topic}:`, message.toString());
        
        let comment = "";
        if (topic.includes("remote/start")) {
            comment = "🚀 Remote Start Command Received. Preparing to start charging...";
        } else if (topic.includes("remote/stop")) {
            comment = "🛑 Remote Stop Command Received. Stopping the charging session...";
        } else if (topic.includes("reset")) {
            comment = "🔄 Reset Command Received. Rebooting the charger...";
        } else if (topic.includes("unlock")) {
            comment = "🔓 Unlock Connector Command Received. Attempting to unlock...";
        }

        const messageWithComment = {
            topic: topic,
            data: JSON.parse(message.toString()),
            comment: comment
        };

        ws.send(JSON.stringify(messageWithComment));
    });

    ws.on("close", () => {
        console.log(`🔌 Charge point ${stationId} disconnected`);
        
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
        deviceShadow.update(stationId, disconnectShadowPayload, function (err, data) {
            if (err) {
                console.error(`❌ Shadow Update Error for ${stationId}:`, err);
            } else {
                console.log(`✅ Shadow Update Success for ${stationId}:`, JSON.stringify(data));
            }
        });
    });
});
