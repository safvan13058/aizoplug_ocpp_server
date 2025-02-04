const WebSocket = require("ws");
const mqtt = require("mqtt");
const fs =require("fs");
// MQTT Broker Configuration (Replace with your AWS IoT Core MQTT endpoint if needed)
// const MQTT_BROKER_URL = "mqtt://broker.hivemq.com";  // Public broker for testing
const MQTT_TOPIC_BASE = "ocpp/chargingpoint/";
// const MQTT_TOPIC_BASE = "thing/";

const wss = new WebSocket.Server({ port: 9000 });
console.log("OCPP WebSocket server started on ws://13.235.49.231:9000");
// Connect to MQTT Broker
const mqttClient = mqtt.connect("mqtts://an1ua1ij15hp7-ats.iot.ap-south-1.amazonaws.com", {
    key: fs.readFileSync("private.pem.key"),
    cert: fs.readFileSync("certificate.pem.crt"),
    ca: fs.readFileSync("AmazonRootCA1.pem")
});





// mqttClient.on("connect", () => console.log("Connected to MQTT brokers"));
// MQTT Connection Events
mqttClient.on("connect", () => console.log("Connected to MQTT broker"));
mqttClient.on("error", (error) => console.error("MQTT Connection Error:", error));
mqttClient.on("close", () => console.log("MQTT Connection Closed"));
mqttClient.on("offline", () => console.log("MQTT Client Offline"));
// Handle OCPP WebSocket connections
wss.on("connection", (ws, req) => {
    console.log(`New charge point connected: ${req.socket.remoteAddress}`);

    ws.on("message", (message) => {
        console.log("Received OCPP message:", message.toString());

        try {
            const parsedMessage = JSON.parse(message);
            const stationId = parsedMessage[1] || "unknown_station";
            const ocppAction = parsedMessage[2] || "unknown_action";
            const payload = parsedMessage[3] || {};

            console.log(`Station ID: ${stationId}, Action: ${ocppAction}`);

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
            
            console.log(`topic==${mqttTopic}`)
            // Publish to MQTT topic
            mqttClient.publish(mqttTopic, JSON.stringify(payload));

        } catch (error) {
            console.error("Error parsing OCPP message:", error);
        }
    });

    ws.on("close", () => {
        console.log("Charge point disconnected");
    });

    // Listen for MQTT messages and send commands to Charge Point
    const mqttCommandTopic = `${MQTT_TOPIC_BASE}+/commands`;
    mqttClient.subscribe(mqttCommandTopic);

    mqttClient.on("message", (topic, message) => {
        console.log(`Received MQTT Command - Topic: ${topic}, Message: ${message.toString()}`);

        // Extract Charge Point ID from MQTT topic
        const topicParts = topic.split("/");
        const stationId = topicParts[2];

        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify([3, stationId, "RemoteStartTransaction", JSON.parse(message)]));
        }
    });
});
