require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT
});

db.connect(err => {
    if (err) {
        console.error("❌ Error al conectar con la base de datos:", err);
        return;
    }
    console.log("✅ Conectado a MySQL en Railway");
});

// Obtener todos los mensajes aprobados
app.get("/messages", (req, res) => {
    db.query("SELECT * FROM messages WHERE approved = 1 ORDER BY created_at DESC", (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// Agregar un nuevo mensaje (sin aprobar)
app.post("/messages", (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Mensaje requerido" });

    db.query("INSERT INTO messages (text, approved) VALUES (?, 0)", [text], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: result.insertId, text, approved: 0 });
    });
});

// Aprobar un mensaje
app.put("/messages/:id/approve", (req, res) => {
    const { id } = req.params;
    db.query("UPDATE messages SET approved = 1 WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Rechazar (eliminar) un mensaje
app.delete("/messages/:id", (req, res) => {
    const { id } = req.params;
    db.query("DELETE FROM messages WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`🚀 API corriendo en http://localhost:${PORT}`));
