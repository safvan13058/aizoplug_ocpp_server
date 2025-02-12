const WebSocket = require("ws");
const mqtt = require("mqtt");
const awsIot = require("aws-iot-device-sdk");
const fs = require("fs");

const MQTT_TOPIC_BASE = "ocpp/chargingpoint/";
const AWS_IOT_HOST = "an1ua1ij15hp7-ats.iot.ap-south-1.amazonaws.com"; // Change to your AWS IoT Core endpoint

const wss = new WebSocket.Server({ port: 9000 });
console.log("🚀 OCPP WebSocket server started on ws://13.235.49.231:9000");

// MQTT Client for AWS IoT Core
const mqttClient = mqtt.connect(`mqtts://${AWS_IOT_HOST}`, {
    key: fs.readFileSync("private.pem.key"),
    cert: fs.readFileSync("certificate.pem.crt"),
    ca: fs.readFileSync("AmazonRootCA1.pem"),
});

// AWS IoT Device Shadow Client
const deviceShadow = awsIot.thingShadow({
    keyPath: "private.pem.key",
    certPath: "certificate.pem.crt",
    caPath: "AmazonRootCA1.pem",
    clientId: "chargepoint-shadow",
    host: AWS_IOT_HOST,
});

// MQTT Connection Events
mqttClient.on("connect", () => console.log("✅ Connected to MQTT broker"));
mqttClient.on("error", (error) => console.error("❌ MQTT Connection Error:", error));

// AWS IoT Device Shadow Events
deviceShadow.on("connect", () => {
    console.log("✅ Connected to AWS IoT Device Shadow");
});
deviceShadow.register("cp_2", {}, function () {
    console.log("✅ Registered Shadow for cp_2");
});
// Handle WebSocket connections for OCPP
wss.on("connection", (ws, req) => {
    const stationId = req.socket.remoteAddress.replace(/^::ffff:/, ""); // Extract IP
    console.log(`🔌 New charge point connected: ${stationId}`);

    // Update AWS IoT Device Shadow with "connected" status
    const connectShadowPayload = {
        state: {
            reported: {
                stationId: stationId,
                status: "connected",
                timestamp: new Date().toISOString(),
            },
        },
    };

    console.log(`📥 Updating Device Shadow for ${stationId} (Connected)`);
    // deviceShadow.update(stationId, connectShadowPayload);
    deviceShadow.update(stationId, connectShadowPayload, function(err, data) {
        if (err) {
            console.error(`❌ Shadow Update Error for ${stationId}:`, err);
        } else {
            console.log(`✅ Shadow Update Success for ${stationId}:`, JSON.stringify(data));
        }
    });
    
    ws.on("message", (message) => {
        console.log("📩 Received OCPP message:", message.toString());

        try {
            const parsedMessage = JSON.parse(message);
            const stationId = parsedMessage[1] || "unknown_station";
            const ocppAction = parsedMessage[2] || "unknown_action";
            const payload = parsedMessage[3] || {};

            console.log(`📡 Station ID: ${stationId}, Action: ${ocppAction}`);

            // Determine MQTT topic based on OCPP action
            let mqttTopic = `${MQTT_TOPIC_BASE}${stationId}/`;
            switch (ocppAction) {
                case "BootNotification":
                    mqttTopic += "boot";
                    break;
                case "StartTransaction":
                    mqttTopic += "transactions/start";
                    break;
                case "StatusNotification":
                    mqttTopic += "transactions/update";
                    break;
                case "StopTransaction":
                    mqttTopic += "transactions/stop";
                    break;
                case "FaultNotification":
                    mqttTopic += "errors";
                    break;
                default:
                    mqttTopic += "unknown";
            }

            console.log(`📤 Publishing to topic: ${mqttTopic}`);
            mqttClient.publish(mqttTopic, JSON.stringify(payload));

            // **Update the AWS IoT Device Shadow**
            const shadowPayload = {
                state: {
                    reported: {
                        stationId: stationId,
                        action: ocppAction,
                        data: payload,
                        timestamp: new Date().toISOString(),
                    },
                },
            };

            console.log(`📥 Updating Device Shadow for ${stationId}`);
            deviceShadow.update(stationId, shadowPayload);
        } catch (error) {
            console.error("❌ Error parsing OCPP message:", error);
        }
    });

    ws.on("close", () => {
        console.log(`🔌 Charge point ${stationId} disconnected`);

        // Update AWS IoT Device Shadow with "disconnected" status
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
        deviceShadow.update("cp_2", disconnectShadowPayload);
    });
});

// **Handle Shadow Updates from AWS IoT Core**
deviceShadow.on("delta", (thingName, stateObject) => {
    console.log(`🔄 Received Shadow Delta Update for ${thingName}:`, JSON.stringify(stateObject));

    const commandTopic = `${MQTT_TOPIC_BASE}${thingName}/commands`;
    mqttClient.publish(commandTopic, JSON.stringify(stateObject.state));
});

deviceShadow.on("status", (thingName, stat, clientToken, stateObject) => {
    console.log(`ℹ️ Shadow Status for ${thingName}:`, JSON.stringify(stateObject));
});

deviceShadow.on("timeout", (thingName, clientToken) => {
    console.error(`⏳ Shadow Update Timeout for ${thingName}, Token: ${clientToken}`);
});
