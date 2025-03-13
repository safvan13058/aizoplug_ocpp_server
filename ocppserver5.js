const http = require("http");
const WebSocket = require("ws");
const mqtt = require("mqtt");
const awsIot = require("aws-iot-device-sdk");
const url = require("url");
const fs = require("fs");

// 🌐 AWS IoT MQTT Broker Config
const AWS_IOT_HOST = "an1ua1ij15hp7-ats.iot.ap-south-1.amazonaws.com";

// 🌍 Create HTTP Server for WebSocket
const server = http.createServer();
const wss = new WebSocket.Server({ server });

console.log("🚀 WebSocket server starting on ws://host.aizoplug.com:80");

// 📡 Connect to AWS IoT Core (MQTT Broker)
const mqttClient = mqtt.connect(`mqtts://${AWS_IOT_HOST}`, {
    key: fs.readFileSync("private.pem.key"),
    cert: fs.readFileSync("certificate.pem.crt"),
    ca: fs.readFileSync("AmazonRootCA1.pem"),
});

const connectedStations = {}; // Store active charge points dynamically

mqttClient.on("connect", () => {
    console.log("✅ Connected to AWS IoT Core (MQTT Broker)");

    // 🌐 Subscribe to all incoming commands: +/in
    mqttClient.subscribe("+/in", (err) => {
        if (err) console.error("❌ Subscription Error:", err);
        else console.log("📡 Subscribed to +/in for incoming commands");
    });
});

mqttClient.on("error", (error) => console.error("❌ MQTT Connection Error:", error));

// 🚀 WebSocket (Charge Point) Connection Handling
wss.on("connection", (ws, req) => {
    // Assign temporary stationId from URL or IP
    let stationId = url.parse(req.url, true).query.stationId || req.socket.remoteAddress.replace(/^::ffff:/, "");
    console.log(`🔌 Charge Point Connected (Temporary ID): ${stationId}`);

    let deviceShadow;
    // if (!connectedStations[stationId]) {
    //     connectedStations[stationId] = {
    //         ws,
    //         stationId,
    //         deviceShadow: null, // Initialize as null
    //         payloads: {},
    //         lastUpdated: new Date().toISOString(),
    //     };
    // }
    let isStationIdUpdated = false;

    const initializeDeviceShadow = (stationId) => {
        const deviceShadow = awsIot.thingShadow({
            keyPath: "private.pem.key",
            certPath: "certificate.pem.crt", 
            caPath: "AmazonRootCA1.pem",
            clientId: stationId,
            host: AWS_IOT_HOST,
        });
    
        deviceShadow.on("connect", () => {
            console.log(`✅ Connected to Device Shadow for ${stationId}`);
            deviceShadow.register(stationId, {}, () => console.log(`✅ Registered Shadow for ${stationId}`));
        });
    
        // 🛠 Store deviceShadow inside connectedStations for later access
        // connectedStations[stationId].deviceShadow = deviceShadow;
    };
    

    // 📥 Handle WebSocket Messages (from Charge Point)
    ws.on("message", (message) => {
        console.log("📩 Received OCPP Message:", message.toString());

        try {
            const [messageType, messageId, action, payload] = JSON.parse(message);
        
            // 🚀 Extract stationId from BootNotification
            if (action === "BootNotification" && payload.chargePointSerialNumber && !isStationIdUpdated) {
                stationId = payload.chargePointSerialNumber;  // Set stationId (e.g., "cp_3")
                isStationIdUpdated = true;
        
                console.log(`✅ Updated Station ID: ${stationId}`);
                initializeDeviceShadow(stationId);  // Initialize device shadow
        
                const bootResponse = [3, messageId, {
                    currentTime: new Date().toISOString(),
                    interval: 300,
                    status: "Accepted",
                }];
                ws.send(JSON.stringify(bootResponse));
                console.log(`✅ Responded to BootNotification for ${stationId}`);
            }
        
            // 📡 Handle OCPP Actions and Respond
            let response;
            switch (action) {
                case "Authorize":
                    response = [3, messageId, { idTagInfo: { status: "Accepted" } }];
                    break;
                case "StartTransaction":
                    response = [3, messageId, {
                        transactionId: Math.floor(Math.random() * 100000),
                        idTagInfo: { status: "Accepted" },
                    }];
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
                case "RemoteStartTransaction":
                case "RemoteStopTransaction":
                    response = [3, messageId, { status: "Accepted" }];
                    break;
                default:
                    response = [4, messageId, "NotImplemented", "Action not supported."];
            }
        
            ws.send(JSON.stringify(response));
            console.log(`✅ Responded to ${action} for ${stationId}`);
        
            // 🔔 Publish charge point response to +/out topic
            const mqttTopic = `${stationId}/out`;
            mqttClient.publish(mqttTopic, JSON.stringify({ action, payload }));

            console.log(`📤 Published response to ${mqttTopic}`);

            const shadowData = {
                state: {
                    reported: payload
                }
            };

            deviceShadow.update(stationId, shadowData, (err) => {
                if (err) console.error(`❌ Shadow Update Error for ${stationId}:`, err);
                else console.log(`✅ .....Shadow Updated for ${stationId}`);
            });
            // 📢 Update Device Shadow for ALL actions
            // updateDeviceShadow(stationId, action, payload,deviceShadow);
        
        } catch (err) {
            console.error("❌ Error parsing OCPP message:", err);
        }
        
    });

    // 📥 Handle MQTT Commands from +/in Topics
    mqttClient.on("message", (topic, message) => {
        console.log(`📥 MQTT Message on ${topic}:`, message.toString());

        const [incomingStationId, direction] = topic.split("/");  // Extract stationId from topic (stationId/in)

        if (direction !== "in" || stationId !== incomingStationId) return;  // Ignore unrelated messages

        const payload = JSON.parse(message.toString());
        const action = payload.action || "RemoteStartTransaction";  // Default to RemoteStartTransaction if not provided

        const command = [2, `${Date.now()}`, action, payload.data || {}];
        ws.send(JSON.stringify(command));
        console.log(`▶️ Sent ${action} to Charge Point (${stationId})`);
    });

    // 🔌 Handle Charge Point Disconnection
    ws.on("close", () => {
        console.log(`🔌 Charge Point ${stationId} Disconnected`);
        if (deviceShadow) {
            deviceShadow.update(stationId, {
                state: {
                    reported: {
                        stationId,
                        status: "disconnected",
                        timestamp: new Date().toISOString(),
                    },
                },
            }, (err) => {
                if (err) console.error(`❌ Shadow Update Error:`, err);
                else console.log(`✅ Shadow Updated: ${stationId} disconnected`);
            });
        }
    });
});
// ✅ Fix updateDeviceShadow to avoid undefined errors
const updateDeviceShadow = (stationId, action, payload,deviceShadow) => {
    // if (!connectedStations[stationId]) {
    //     console.error(`⚠️ Charge point ${stationId} not found in connectedStations`);
    //     return;
    // }

    if (!deviceShadow) {
        console.error(`⚠️ Device Shadow not initialized for ${stationId}`);
        return;
    }

    // Store all OCPP actions dynamically
    connectedStations[stationId].payloads[action] = payload;

    const shadowData = {
        state: {
            reported: connectedStations[stationId].payloads
        }
    };

    deviceShadow.update(stationId, shadowData, (err) => {
        if (err) console.error(`❌ Shadow Update Error for ${stationId}:`, err);
        else console.log(`✅ Shadow Updated for ${stationId}`);
    });
};

// 🌐 Start WebSocket Server
const PORT = 80;
server.listen(PORT, () => console.log(`🚀 WebSocket server running on port ${PORT}`));
