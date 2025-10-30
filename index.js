require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const path = require("path");

// 🔧 NUEVO: http + socket.io
const http = require("http");
const { Server } = require("socket.io");

const app = express();
// ⚠️ crea el server HTTP *antes* de escuchar
const server = http.createServer(app);

// 🔧 NUEVO: instancia de Socket.IO
const io = new Server(server, {
  cors: { origin: "*", credentials: true },
});

app.use(express.json());
app.use(cors());

// --- MySQL ---
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
  console.log("MYSQLPASSWORD:", process.env.MYSQLPASSWORD ? "*******" : "Not Set");
  console.log("MYSQLDATABASE:", process.env.MYSQLDATABASE);
  console.log("MYSQLPORT:", process.env.MYSQLPORT);
  if (err) {
    console.error("❌ Error al conectar con la base de datos:", err);
    return;
  }
  console.log("✅ Conectado a MySQL en Railway");
});

// --- Web estático principal (tu chat clásico por DB) ---
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- DevilChat: servir el front bajo /devilchat ---
const devilStaticPath = path.join(__dirname, "public-devil");
app.use("/devilchat", express.static(devilStaticPath));
// SPA catch-all para rutas hijas de /devilchat (p. ej. /devilchat/admin)
app.get(/^\/devilchat(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(devilStaticPath, "index.html"));
});

// ===================
//  Endpoints clásicos
// ===================

// Aprobados últimos 2 días
app.get("/messages", (req, res) => {
  db.query(
    "SELECT * FROM messages WHERE approved = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 2 DAY) ORDER BY created_at DESC",
    (err, results) => (err ? res.status(500).json({ error: err.message }) : res.json(results))
  );
});

// Todos aprobados
app.get("/messages/all", (req, res) => {
  db.query(
    "SELECT * FROM messages WHERE approved = 1 ORDER BY created_at DESC",
    (err, results) => (err ? res.status(500).json({ error: err.message }) : res.json(results))
  );
});

// Nuevo mensaje (pendiente)
app.post("/messages", (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "Mensaje requerido" });
  db.query("INSERT INTO messages (text, approved) VALUES (?, 0)", [text], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: result.insertId, text, approved: 0 });
  });
});

// Pendientes
app.get("/messages/pending", (req, res) => {
  db.query(
    "SELECT * FROM messages WHERE approved = 0 ORDER BY created_at DESC",
    (err, results) => (err ? res.status(500).json({ error: err.message }) : res.json(results))
  );
});

// Aprobar
app.put("/messages/:id/approve", (req, res) => {
  const { id } = req.params;
  db.query("UPDATE messages SET approved = 1 WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Eliminar
app.delete("/messages/:id", (req, res) => {
  const { id } = req.params;
  db.query("DELETE FROM messages WHERE id = ?", [id], (err) =>
    err ? res.status(500).json({ error: err.message }) : res.json({ success: true })
  );
});

// Likes
app.put("/messages/:id/like", (req, res) => {
  const { id } = req.params;
  db.query("UPDATE messages SET likes = likes + 1 WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.query("SELECT likes FROM messages WHERE id = ?", [id], (e, rows) => {
      if (e) return res.status(500).json({ error: e.message });
      res.json({ success: true, likes: rows[0].likes });
    });
  });
});

app.put("/messages/:id/unlike", (req, res) => {
  const { id } = req.params;
  db.query("UPDATE messages SET likes = GREATEST(likes - 1, 0) WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.query("SELECT likes FROM messages WHERE id = ?", [id], (e, rows) => {
      if (e) return res.status(500).json({ error: e.message });
      res.json({ success: true, likes: rows[0].likes });
    });
  });
});

// ===================================
//  DevilChat (pregunta/respuestas DB)
// ===================================

// Estado (pregunta activa)
app.get("/devilchat/api/devil/status", (req, res) => {
  db.query(
    "SELECT id, text, active, created_at FROM devil_questions WHERE active = 1 ORDER BY created_at DESC LIMIT 1",
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows[0] || { id: null, text: null, active: 0, created_at: null });
    }
  );
});

// Nueva pregunta (admin): desactiva anteriores y activa la nueva
app.post("/devilchat/api/admin/question", (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: "Texto de pregunta requerido" });
  }
  db.query("UPDATE devil_questions SET active = 0 WHERE active = 1", () => {
    db.query("INSERT INTO devil_questions (text, active) VALUES (?, 1)", [text.trim()], (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      const newQ = { id: result.insertId, text: text.trim(), active: 1 };
      io.emit("devilchat:newQuestion", newQ);
      io.emit("devilchat:status", { active: true, question: newQ });
      res.json({ success: true, question: newQ });
    });
  });
});

// Activar/Desactivar (admin) la última pregunta creada
app.post("/devilchat/api/admin/active", (req, res) => {
  const { active } = req.body || {};
  if (typeof active !== "boolean") {
    return res.status(400).json({ error: "active debe ser boolean" });
  }
  db.query("SELECT id FROM devil_questions ORDER BY created_at DESC LIMIT 1", (e, rows) => {
    if (e) return res.status(500).json({ error: e.message });
    if (!rows[0]) return res.status(409).json({ error: "No hay preguntas" });
    const qid = rows[0].id;
    if (active) {
      db.query("UPDATE devil_questions SET active = 0 WHERE active = 1", () => {
        db.query("UPDATE devil_questions SET active = 1 WHERE id = ?", [qid], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          io.emit("devilchat:status", { active: true, question_id: qid });
          res.json({ success: true, active: true, question_id: qid });
        });
      });
    } else {
      db.query("UPDATE devil_questions SET active = 0 WHERE id = ?", [qid], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        io.emit("devilchat:status", { active: false, question_id: qid });
        res.json({ success: true, active: false, question_id: qid });
      });
    }
  });
});

// Listar preguntas (admin)
app.get("/devilchat/api/admin/questions", (req, res) => {
  db.query(
    "SELECT id, text, active, created_at FROM devil_questions ORDER BY created_at DESC",
    (err, rows) => (err ? res.status(500).json({ error: err.message }) : res.json(rows))
  );
});

// Enviar respuesta (pendiente)
app.post("/devilchat/api/answers", (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: "Texto requerido" });
  }
  db.query("SELECT id FROM devil_questions WHERE active = 1 ORDER BY created_at DESC LIMIT 1", (e, rows) => {
    if (e) return res.status(500).json({ error: e.message });
    if (!rows[0]) return res.status(409).json({ error: "No hay pregunta activa" });
    const qid = rows[0].id;
    db.query("INSERT INTO devil_answers (question_id, text, approved) VALUES (?, ?, 0)", [qid, text.trim()], (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      const pending = { id: result.insertId, question_id: qid, text: text.trim(), approved: 0 };
      io.emit("devilchat:pending", pending);
      res.json({ success: true, id: pending.id });
    });
  });
});

// Pendientes (última pregunta activa)
app.get("/devilchat/api/admin/answers/pending", (req, res) => {
  db.query(
    `SELECT a.* FROM devil_answers a
     JOIN devil_questions q ON q.id = a.question_id
     WHERE q.active = 1 AND a.approved = 0
     ORDER BY a.created_at DESC`,
    (err, rows) => (err ? res.status(500).json({ error: err.message }) : res.json(rows))
  );
});

// Aprobados (última pregunta activa)
app.get("/devilchat/api/answers/approved", (req, res) => {
  db.query(
    `SELECT a.* FROM devil_answers a
     JOIN devil_questions q ON q.id = a.question_id
     WHERE q.active = 1 AND a.approved = 1
     ORDER BY a.created_at ASC`,
    (err, rows) => (err ? res.status(500).json({ error: err.message }) : res.json(rows))
  );
});

// Aprobar respuesta
app.put("/devilchat/api/admin/answers/:id/approve", (req, res) => {
  const { id } = req.params;
  db.query("UPDATE devil_answers SET approved = 1 WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.query("SELECT * FROM devil_answers WHERE id = ?", [id], (e, rows) => {
      if (e) return res.status(500).json({ error: e.message });
      if (rows[0]) io.emit("devilchat:new", rows[0]);
      res.json({ success: true, approved: rows[0] || null });
    });
  });
});

// Eliminar respuesta (pendiente o aprobada)
app.delete("/devilchat/api/admin/answers/:id", (req, res) => {
  const { id } = req.params;
  db.query("DELETE FROM devil_answers WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    io.emit("devilchat:pending:remove", { id: Number(id) });
    res.json({ success: true });
  });
});

// Like a respuesta
app.put("/devilchat/api/answers/:id/like", (req, res) => {
  const { id } = req.params;
  db.query("UPDATE devil_answers SET likes = likes + 1 WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.query("SELECT likes FROM devil_answers WHERE id = ?", [id], (e, rows) => {
      if (e) return res.status(500).json({ error: e.message });
      res.json({ success: true, likes: rows[0]?.likes ?? 0 });
    });
  });
});

// ===================
//  Socket.IO wiring
// ===================
io.on("connection", (socket) => {
  console.log("🔌 DevilChat client connected", socket.id);
  socket.on("disconnect", () => console.log("🔌 DevilChat client disconnected", socket.id));
});

// 🚀 IMPORTANTE: usar server.listen (no app.listen)
const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
  console.log(`🚀 API + Socket.IO corriendo en http://localhost:${PORT}`);
});
