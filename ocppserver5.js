const { CentralSystem } = require("ocpp-js");
const mqtt = require("mqtt");
const fs = require("fs");

// 🔹 AWS IoT MQTT Configuration
const AWS_IOT_HOST = "an1ua1ij15hp7-ats.iot.ap-south-1.amazonaws.com";
const MQTT_TOPIC_BASE = "ocpp/chargingpoint/";

let key, cert, ca;
try {
    key = fs.readFileSync("private.pem.key");
    cert = fs.readFileSync("certificate.pem.crt");
    ca = fs.readFileSync("AmazonRootCA1.pem");
} catch (error) {
    console.error("❌ Failed to load certificate files:", error);
    process.exit(1);
}

// 🔹 Connect to AWS IoT MQTT
const mqttClient = mqtt.connect(`mqtts://${AWS_IOT_HOST}`, { key, cert, ca });

mqttClient.on("connect", () => console.log("✅ Connected to AWS IoT Core"));
mqttClient.on("error", (error) => console.error("❌ MQTT Connection Error:", error));

// 🔹 Start OCPP 1.6 Server
const centralSystem = new CentralSystem({ wsOptions: { port: 9000 } });
console.log("🚀 OCPP 1.6 Central System running on ws://13.235.49.231:9000");

// 🔹 Handle Charging Point Connections
centralSystem.on("connection", (client) => {
    const stationId = client.identity;
    console.log(`🔌 Charge point connected: ${stationId}`);

    // 🔹 BootNotification Handler
    client.onRequest("BootNotification", (payload) => {
        console.log(`📩 BootNotification from ${stationId}:`, payload);
        
        // Publish BootNotification to MQTT
        mqttClient.publish(`${MQTT_TOPIC_BASE}${stationId}/BootNotification`, JSON.stringify(payload));

        return { currentTime: new Date().toISOString(), interval: 300, status: "Accepted" };
    });

    // 🔹 Heartbeat Handler
    client.onRequest("Heartbeat", () => {
        console.log(`💓 Heartbeat from ${stationId}`);

        // Publish Heartbeat to MQTT
        mqttClient.publish(`${MQTT_TOPIC_BASE}${stationId}/Heartbeat`, JSON.stringify({ timestamp: new Date().toISOString() }));

        return { currentTime: new Date().toISOString() };
    });

    // 🔹 Authorize Handler
    client.onRequest("Authorize", (payload) => {
        console.log(`🔑 Authorize request from ${stationId}:`, payload);

        mqttClient.publish(`${MQTT_TOPIC_BASE}${stationId}/Authorize`, JSON.stringify(payload));

        return { idTagInfo: { status: "Accepted" } };
    });

    // 🔹 Handle Remote Control via MQTT
    mqttClient.subscribe(`${MQTT_TOPIC_BASE}${stationId}/remote/#`);
    mqttClient.on("message", (topic, message) => {
        console.log(`📥 MQTT Message for ${stationId}: ${topic} -> ${message.toString()}`);

        if (topic.endsWith("/remote/start")) {
            client.sendRequest("RemoteStartTransaction", JSON.parse(message.toString()));
        } else if (topic.endsWith("/remote/stop")) {
            client.sendRequest("RemoteStopTransaction", JSON.parse(message.toString()));
        }
    });

    client.on("close", () => console.log(`🔌 Charge point ${stationId} disconnected`));
});
