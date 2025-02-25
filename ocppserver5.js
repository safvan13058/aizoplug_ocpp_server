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
/**
 * 🚀 Send RemoteStartTransaction to the Charge Point
 * @param {WebSocket} ws - WebSocket connection
 * @param {string} idTag - Authorization tag (default: "TEST_ID_TAG")
 * @param {number} connectorId - Connector to start transaction (default: 1)
 */
function sendRemoteStartTransaction(ws, idTag = "TEST_ID_TAG", connectorId = 1) {
    const messageId = Math.random().toString(36).substring(2, 10); // Unique Message ID
    const remoteStartMessage = [
        2,                         // CALL message type
        messageId,                 // Unique message ID
        "RemoteStartTransaction",  // OCPP Action
        { idTag, connectorId }     // Payload
    ];

    ws.send(JSON.stringify(remoteStartMessage));
    console.log(`📤 Sent RemoteStartTransaction: ${JSON.stringify(remoteStartMessage)}`);
}

/**
 * 🛑 Send RemoteStopTransaction to the Charge Point
 * @param {WebSocket} ws - WebSocket connection
 * @param {number} transactionId - Transaction ID to stop
 */
function sendRemoteStopTransaction(ws, transactionId) {
    const messageId = Math.random().toString(36).substring(2, 10); // Unique Message ID
    const remoteStopMessage = [
        2,                         // CALL message type
        messageId,                 // Unique message ID
        "RemoteStopTransaction",   // OCPP Action
        { transactionId }          // Payload
    ];

    ws.send(JSON.stringify(remoteStopMessage));
    console.log(`📤 Sent RemoteStopTransaction: ${JSON.stringify(remoteStopMessage)}`);
}

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

    // 📩 Handle Incoming WebSocket Messages (OCPP 1.6)
    ws.on("message", (message) => {
        console.log("📩 Received OCPP message:", message.toString());
        try {
            const parsedMessage = JSON.parse(message);
            const messageId = parsedMessage[1];
            const ocppAction = parsedMessage[2] || "unknown_action";
            const payload = parsedMessage[3] || {};
            // if (ocppAction === "BootNotification") {
            //     const response = [3, messageId, {
            //         currentTime: new Date().toISOString(),
            //         interval: 300,
            //         status: "Accepted",
            //     }];
            //     ws.send(JSON.stringify(response));
            //     console.log("✅ Responded: BootNotification Accepted");
            //     return;
            // }
            // if (ocppAction === "Authorize") {
            //     // 🟢 Always accept authorization for now
            //     const response = [3, messageId, { "idTagInfo": { "status": "Accepted" } }];
            //     ws.send(JSON.stringify(response));
            //     console.log("✅ Sent: Authorize Accepted");
            //     return;
            // }
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
                    // const { idTag = "TEST_ID_TAG", connectorId = 1 } = payload;
                    // sendRemoteStartTransaction(ws, idTag, connectorId);
                    break;

                case "StopTransaction":
                    response = [3, messageId, { idTagInfo: { status: "Accepted" } }];
                    console.log("✅ Responded: StopTransaction Accepted");
                    // 🚀 Send RemoteStartTransaction after receiving StartTransaction
                    // 🛑 Send RemoteStopTransaction after receiving StopTransaction
                    // const { transactionId = 1 } = payload;
                    // sendRemoteStopTransaction(ws, transactionId);
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
            console.log(`📡 Station ID: ${stationId}, Action: ${ocppAction}`);
            let mqttTopic = `${MQTT_TOPIC_BASE}${stationId}/${ocppAction || "unknown"}`;
            console.log(`📤 Publishing to topic: ${mqttTopic}`);
            mqttClient.publish(mqttTopic, JSON.stringify(payload));
        } catch (error) {
            console.error("❌ Error parsing OCPP message:", error);
        }
    });

    // 📥 Handle Incoming MQTT Messages (AWS IoT)
    mqttClient.on("message", (topic, message) => {
        console.log(`📥 Received MQTT message on ${topic}:`, message.toString());

        let comment = "";
        if (topic.includes("RemoteStartTransaction")) {
            comment = "🚀 Remote Start Command Received. Preparing to start charging...";
        } else if (topic.includes("RemoteStopTransaction")) {
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
        deviceShadow.update(stationId, disconnectShadowPayload, function (err, data) {
            if (err) {
                console.error(`❌ Shadow Update Error for ${stationId}:`, err);
            } else {
                console.log(`✅ Shadow Update Success for ${stationId}:`, JSON.stringify(data));
            }
        });
    });
});

// 🌐 Start Secure WebSocket Server
server.listen(8080, () => {
    console.log("🚀 Secure OCPP WebSocket Server Running on wss://ocpp.yourdomain.com:8080");
});
