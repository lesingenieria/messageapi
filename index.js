require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const db = mysql.createConnection({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT,
});

db.connect((err) => {
  console.log("MYSQLHOST:", process.env.MYSQLHOST);
  console.log("MYSQLUSER:", process.env.MYSQLUSER);
  console.log(
    "MYSQLPASSWORD:",
    process.env.MYSQLPASSWORD ? "*******" : "Not Set"
  );
  console.log("MYSQLDATABASE:", process.env.MYSQLDATABASE);
  console.log("MYSQLPORT:", process.env.MYSQLPORT);
  if (err) {
    console.error("❌ Error al conectar con la base de datos:", err);
    return;
  }
  console.log("✅ Conectado a MySQL en Railway");
});

const path = require("path");

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ====== STATIC DevilChat ====== */
const devilPublic = path.join(__dirname, "public-devil");
app.use("/devilchat", express.static(devilPublic));
app.get(/^\/devilchat(\/.*)?$/, (_, res) => {
  res.sendFile(path.join(devilPublic, "index.html"));
});
app.get("/devilchat/admin", (_, res) => {
  res.sendFile(path.join(devilPublic, "admin.html"));
});

// Obtener todos los mensajes aprobados de los últimos 2 días
app.get("/messages", (req, res) => {
    db.query(
      "SELECT * FROM messages WHERE approved = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 2 DAY) ORDER BY created_at DESC",
      (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
      }
    );
  });

// Obtener todos los mensajes aprobados
app.get("/messages/all", (req, res) => {
    db.query(
      "SELECT * FROM messages WHERE approved = 1 ORDER BY created_at DESC",
      (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
      }
    );
  });
  

// Agregar un nuevo mensaje (sin aprobar)
app.post("/messages", (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Mensaje requerido" });

  db.query(
    "INSERT INTO messages (text, approved) VALUES (?, 0)",
    [text],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: result.insertId, text, approved: 0 });
    }
  );
});

// Obtener todos los mensajes pendientes de aprobación
app.get("/messages/pending", (req, res) => {
  db.query(
    "SELECT * FROM messages WHERE approved = 0 ORDER BY created_at DESC",
    (err, results) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(results);
    }
  );
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

// Endpoint para dar like a un mensaje
app.put("/messages/:id/like", (req, res) => {
  const { id } = req.params;
  db.query(
    "UPDATE messages SET likes = likes + 1 WHERE id = ?",
    [id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });

      // Obtener el número actualizado de likes
      db.query("SELECT likes FROM messages WHERE id = ?", [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, likes: rows[0].likes });
      });
    }
  );
});

// Endpoint para quitar like a un mensaje
app.put("/messages/:id/unlike", (req, res) => {
  const { id } = req.params;
  db.query(
    "UPDATE messages SET likes = GREATEST(likes - 1, 0) WHERE id = ?",
    [id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });

      // Obtener el número actualizado de likes
      db.query("SELECT likes FROM messages WHERE id = ?", [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, likes: rows[0].likes });
      });
    }
  );
});

// --- DEVILCHAT: estado simple en memoria (opcional para mostrar "activo" y la "pregunta") ---
app.get("/devilchat/api/devil/status", (req, res) => {
  db.query(
    "SELECT id, text, active, created_at FROM devil_questions WHERE active = 1 ORDER BY created_at DESC LIMIT 1",
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows[0] || { id: null, text: null, active: 0, created_at: null });
    }
  );
});

// Sirve el DevilChat frontend bajo /devilchat
const devilStaticPath = path.join(__dirname, "public-devil");
app.use("/devilchat", express.static(devilStaticPath));
app.get(/^\/devilchat(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(devilStaticPath, "index.html"));
});

app.get("/devilchat/api/devil/status", (req, res) => {
  db.query(
    "SELECT id, text, active, created_at FROM devil_questions WHERE active = 1 ORDER BY created_at DESC LIMIT 1",
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows[0] || { id: null, text: null, active: 0, created_at: null });
    }
  );
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () =>
  console.log(`🚀 API corriendo en http://localhost:${PORT}`)
);
