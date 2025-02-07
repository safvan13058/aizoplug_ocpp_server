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

    const ocppActions = {
        BootNotification: "boot",
        Heartbeat: "heartbeat",
        Authorize: "authorize",
        StartTransaction: "transactions/start",
        StopTransaction: "transactions/stop",
        MeterValues: "meter/values",
        StatusNotification: "status/update",
        DiagnosticsStatusNotification: "diagnostics/status",
        FirmwareStatusNotification: "firmware/status",
        DataTransfer: "data/transfer",
        RemoteStartTransaction: "remote/start",
        RemoteStopTransaction: "remote/stop",
        ChangeConfiguration: "config/change",
        Reset: "reset",
        UnlockConnector: "unlock",
        GetConfiguration: "config/get",
        TriggerMessage: "trigger/message",
        SetChargingProfile: "charging/profile/set",
        ClearChargingProfile: "charging/profile/clear",
        ReserveNow: "reserve",
        CancelReservation: "reserve/cancel",
        UpdateFirmware: "firmware/update",
        SendLocalList: "users/update",
    };

    ws.on("message", (message) => {
        console.log("📩 Received OCPP message:", message.toString());
        try {
            const parsedMessage = JSON.parse(message);
            const ocppAction = parsedMessage[2] || "unknown_action";
            const payload = parsedMessage[3] || {};
            
            console.log(`📡 Station ID: ${stationId}, Action: ${ocppAction}`);
            let mqttTopic = `${MQTT_TOPIC_BASE}${stationId}/${ocppActions[ocppAction] || "unknown"}`;

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

    ws.on("close", () => console.log(`🔌 Charge point ${stationId} disconnected`));
});
