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
const disconnectTimers = {};
// 📡 Connect to AWS IoT Core (MQTT Broker)
const mqttClient = mqtt.connect(`mqtts://${AWS_IOT_HOST}`, {
    key: fs.readFileSync("private.pem.key"),
    cert: fs.readFileSync("certificate.pem.crt"),
    ca: fs.readFileSync("AmazonRootCA1.pem"),
});

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
    ws.stationId = url.parse(req.url, true).query.stationId || req.socket.remoteAddress.replace(/^::ffff:/, "");
    console.log(`🔌 Charge Point Connected (Temporary ID): ${ws.stationId}`);
    
    ws.isAlive = true; // ✅ Track WebSocket status
    let deviceShadow;
    const deviceShadows = {}; 
    let isStationIdUpdated = false;
    const initializeDeviceShadow = (stationId) => {
        if (deviceShadows[ws.stationId]) {
            console.log(`⚠️ Device Shadow already initialized for ${ws.stationId}, skipping re-init.`);
            return;
        }
    
        deviceShadows[ws.stationId] = awsIot.thingShadow({
            keyPath: "private.pem.key",
            certPath: "certificate.pem.crt",
            caPath: "AmazonRootCA1.pem",
            clientId: ws.stationId,
            host: AWS_IOT_HOST,
        });
    
        deviceShadows[ws.stationId].on("connect", () => {
            console.log(`✅ Connected to Device Shadow for ${ws.stationId}`);
            deviceShadows[ws.stationId].register(ws.stationId, {}, () => console.log(`✅ Registered Shadow for ${ws.stationId}`));
        });
    };
    
    ws.on("pong", () => {
        ws.isAlive = true;
    });

    // 📥 Handle WebSocket Messages (from Charge Point)
    // 📥 Handle WebSocket Messages (from Charge Point)
ws.on("message", async (message) => {
    console.log("📩 Received OCPP Message:", message.toString());

    try {
        const [messageType, messageId, action, payload] = JSON.parse(message);

        // 🚀 Extract stationId from BootNotification
        if (action === "BootNotification" && payload.chargePointSerialNumber) {
            console.log("isStationIdUpdated===========",isStationIdUpdated)
            if (isStationIdUpdated) {
                console.log(`⚠️ BootNotification already processed for ${ws.stationId}, ignoring duplicate.`);
                return;
            }

            ws.stationId = payload.chargePointSerialNumber;
            isStationIdUpdated = true;
            console.log(`✅ Updated Station ID: ${ws.stationId}`);

            // ✅ Initialize Device Shadow only once
            initializeDeviceShadow(ws.stationId);

            // Now send BootNotification response
            const bootResponse = [3, messageId, {
                currentTime: new Date().toISOString(),
                interval: 300,
                status: "Accepted",
            }];
            ws.send(JSON.stringify(bootResponse));

            console.log(`✅ Responded to BootNotification for ${ws.stationId}`);

            // ✅ Update Device Shadow safely
            console.log("🚀 Updating Device Shadow with:", JSON.stringify({
                state: {
                    reported: {
                        deviceData: {
                            action,
                            bootPayload: payload, 
                            timestamp: new Date().toISOString(),
                        }
                    }
                }
            }, null, 2));

            deviceShadows[ws.stationId].update(ws.stationId, {
                state: {
                    reported: {
                        deviceData: {
                            action,
                            bootPayload: payload, 
                            timestamp: new Date().toISOString(),
                        }
                    }
                }
            }, (err) => {
                if (err) console.error(`❌ Shadow Update Error:`, err);
                else console.log(`✅ Shadow Updated (deviceData) for ${ws.stationId}`);
            });

            return;
        }

        // 📡 Handle Other OCPP Actions
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
        console.log(`✅ Responded to ${action} for ${ws.stationId}`);

        // 🔔 Publish charge point response
        if (action !== "Heartbeat") {
            const mqttTopic = `${ws.stationId}/out`;
            mqttClient.publish(mqttTopic, JSON.stringify({ action, payload }));
            console.log(`📤 Published response to ${mqttTopic}`);
        }
        
        if(action!=="Heartbeat"){

        // 📢 Update Device Shadow
        deviceShadows[ws.stationId].update(ws.stationId, {
            state: {
                reported: {
                    stationId: ws.stationId,
                    action,
                    status: payload,
                    transactionId: payload.transactionId || null,
                    timestamp: new Date().toISOString(),
                },
            },
        }, (err) => {
            if (err) console.error(`❌ Shadow Update Error:`, err);
            else console.log(`✅ Shadow Updated (${action}) for ${ws.stationId}`);
        });
    };

    } catch (err) {
        console.error("❌ Error parsing OCPP message:", err);
    }
});


    // 📥 Handle MQTT Commands from +/in Topics
    mqttClient.on("message", (topic, message) => {
        console.log(`📥 MQTT Message on ${topic}:`, message.toString());

        const [incomingStationId, direction] = topic.split("/");  // Extract stationId from topic (stationId/in)

        if (direction !== "in" || ws.stationId !== incomingStationId) return;  // Ignore unrelated messages

        // ✅ Ensure message is properly formatted
        const trimmedMessage = message.toString().trim(); // Remove extra spaces & newlines

        // ✅ Check if the message is valid JSON
        if (!trimmedMessage.startsWith("{") || !trimmedMessage.endsWith("}")) {
            console.error("❌ Invalid JSON format in MQTT message:", trimmedMessage);
            return;
        }
        console.log("message", trimmedMessage)
        const payload = JSON.parse(trimmedMessage);
        const action = payload.action || "RemoteStartTransaction";  // Default to RemoteStartTransaction if not provided

        const command = [2, `${Date.now()}`, action, payload.data || {}];
        ws.send(JSON.stringify(command));
        console.log(`▶️ Sent ${action} to Charge Point (${ws.stationId})`);
    });

    // 🔌 Handle Charge Point Disconnection
    ws.on("close", () => {
        console.log(`🔌 Charge Point ${ws.stationId} Disconnected`);

        if (!ws.stationId || !deviceShadows[ws.stationId]) {
            console.log(`⚠️ Skipping Shadow Update: Missing stationId or deviceShadow`);
            return;
        }
        const timestamp = new Date().toISOString(); 
        // ✅ Mark as "disconnected" in AWS IoT Device Shadow
        deviceShadows[ws.stationId].update(ws.stationId, {
            state: {
                desired: {
                    command: "device_update",
                    status: "disconnected",
                    timestamp: new Date().toISOString()
                }
            }
        }, (err) => {
            if (err) console.error(`❌ Shadow Update Error (Close Event):`, err);
            else console.log(`✅ Shadow Updated: ${ws.stationId} disconnected`);
        });

        // ✅ Remove charger shadow reference
        delete deviceShadows[ws.stationId];
    });

    // ✅ Heartbeat Check (Every 30 seconds)
    ws.pingInterval = setInterval(() => {
        if (!ws.isAlive) {
            console.log(`⚠️ Force closing inactive WebSocket for ${ws.stationId}`);

            // ✅ Mark as "disconnected" before closing WebSocket
            if (ws.stationId && deviceShadows[ws.stationId]) {
                deviceShadows[ws.stationId].update(ws.stationId, {
                    state: {
                        desired: {
                            command: "device_update",
                            status: "disconnected",
                            timestamp:  new Date().toISOString()
                        }
                    }
                }, (err) => {
                    if (err) console.error(`❌ Shadow Update Error (Timeout):`, err);
                    else console.log(`✅ Shadow Updated: ${ws.stationId} disconnected due to timeout`);
                });
            }

            return ws.terminate(); // Forcefully close WebSocket
        }
        ws.isAlive = false;
        ws.ping();
    }, 30000);


});

// 🌐 Start WebSocket Server
const PORT = 80;
server.listen(PORT, () => console.log(`🚀 WebSocket server running on port ${PORT}`));

