const WebSocket = require("ws");

const ws = new WebSocket("ws://13.235.49.231:9000");

ws.on("open", () => {
    console.log("Connected to OCPP Server");

    // Send BootNotification for Station ID: CP123
    ws.send(JSON.stringify([2, "CP123", "BootNotification", { model: "EV Charger 1" }]));

    // Simulate StartTransaction
    setTimeout(() => {
        ws.send(JSON.stringify([2, "CP123", "StartTransaction", { transactionId: "TX1001" }]));
    }, 3000);
});

ws.on("message", (data) => {
    console.log("Received:", data.toString());
});
