const { CentralSystem } = require("ocpp-js");
const WebSocket = require("ws");
const mqtt = require("mqtt");
const awsIot = require("aws-iot-device-sdk");
const fs = require("fs");
const url = require("url");

// 🔹 AWS IoT Configurations
const MQTT_TOPIC_BASE = "ocpp/chargingpoint/";
const AWS_IOT_HOST = "an1ua1ij15hp7-ats.iot.ap-south-1.amazonaws.com";

// 🔹 Load AWS IoT Certificates Securely
let key, cert, ca;
try {
    key = fs.readFileSync("private.pem.key");
    cert = fs.readFileSync("certificate.pem.crt");
    ca = fs.readFileSync("AmazonRootCA1.pem");
} catch (error) {
    console.error("❌ Failed to load certificate files:", error);
    process.exit(1);
}

// 🔹 Initialize MQTT Client
const mqttClient = mqtt.connect(`mqtts://${AWS_IOT_HOST}`, { key, cert, ca });

mqttClient.on("connect", () => console.log("✅ Connected to MQTT broker"));
mqttClient.on("error", (error) => console.error("❌ MQTT Connection Error:", error));

// 🔹 Create OCPP Central System Server
const server = new CentralSystem({
    httpServer: new WebSocket.Server({ port: 9000 }), // OCPP WebSocket server
    protocols: ["ocpp1.6"]
});

console.log("🚀 OCPP Central System running on ws://13.235.49.231:9000");

// 🔹 Handle Incoming OCPP Connections
server.on("connect", (connection, req) => {
    const queryParams = url.parse(req.url, true).query;
    const stationId = queryParams.stationId || req.socket.remoteAddress.replace(/^::ffff:/, "");

    console.log(`🔌 New charge point connected: ${stationId}`);

    // 🔹 Setup AWS IoT Device Shadow
    const deviceShadow = awsIot.thingShadow({
        keyPath: "private.pem.key",
        certPath: "certificate.pem.crt",
        caPath: "AmazonRootCA1.pem",
        clientId: stationId,
        host: AWS_IOT_HOST,
    });

    deviceShadow.on("connect", () => {
        console.log(`✅ Connected to AWS IoT Shadow for ${stationId}`);
        deviceShadow.register(stationId, {}, () => console.log(`✅ Registered Shadow for ${stationId}`));
    });

    // 🔹 Handle OCPP Messages
    connection.on("BootNotification", async ({ chargePointModel, chargePointVendor }) => {
        console.log("📩 BootNotification received:", chargePointModel, chargePointVendor);
        
        // Publish to AWS MQTT
        mqttClient.publish(`${MQTT_TOPIC_BASE}${stationId}/BootNotification`, JSON.stringify({ chargePointModel, chargePointVendor }));

        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 60 };
    });

    connection.on("Authorize", async ({ idTag }) => {
        console.log(`🔑 Authorization request for ID: ${idTag}`);

        // Publish to AWS MQTT
        mqttClient.publish(`${MQTT_TOPIC_BASE}${stationId}/Authorize`, JSON.stringify({ idTag }));

        return { idTagInfo: { status: "Accepted" } };
    });

    connection.on("Heartbeat", async () => {
        console.log("💓 Heartbeat received");
        
        // Publish to AWS MQTT
        mqttClient.publish(`${MQTT_TOPIC_BASE}${stationId}/Heartbeat`, JSON.stringify({ timestamp: new Date().toISOString() }));

        return { currentTime: new Date().toISOString() };
    });

    connection.on("message", (message) => {
        console.log("📩 Received OCPP message:", message.toString());

        try {
            const parsedMessage = JSON.parse(message);
            const messageId = parsedMessage[1];
            const ocppAction = parsedMessage[2] || "unknown_action";
            const payload = parsedMessage[3] || {};

            if (ocppAction === "Authorize") {
                // 🟢 Always accept authorization for now
                const response = [3, messageId, { "idTagInfo": { "status": "Accepted" } }];
                connection.send(JSON.stringify(response));
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

    // 🔹 Handle MQTT Messages for Remote Commands
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

        connection.send(JSON.stringify(messageWithComment));
    });

    // 🔹 Handle Disconnection
    connection.on("close", () => {
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
