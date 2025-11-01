require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const path = require("path");

// 🔧 http + socket.io
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", credentials: true } });

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

// --- seguridad admin (header x-admin-key) ---
const ADMIN_KEY = process.env.DEVIL_ADMIN_KEY || "t3devil";
function requireAdmin(req, res, next) {
  const key = req.get("x-admin-key") || "";
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// --- Web estático principal (chat clásico)
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===================
//  Endpoints clásicos
// ===================

app.get("/messages", (req, res) => {
  db.query(
    "SELECT * FROM messages WHERE approved = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 2 DAY) ORDER BY created_at DESC",
    (err, results) => (err ? res.status(500).json({ error: err.message }) : res.json(results))
  );
});

app.get("/messages/all", (req, res) => {
  db.query(
    "SELECT * FROM messages WHERE approved = 1 ORDER BY created_at DESC",
    (err, results) => (err ? res.status(500).json({ error: err.message }) : res.json(results))
  );
});

app.post("/messages", (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "Mensaje requerido" });
  db.query("INSERT INTO messages (text, approved) VALUES (?, 0)", [text], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: result.insertId, text, approved: 0 });
  });
});

app.get("/messages/pending", (req, res) => {
  db.query(
    "SELECT * FROM messages WHERE approved = 0 ORDER BY created_at DESC",
    (err, results) => (err ? res.status(500).json({ error: err.message }) : res.json(results))
  );
});

app.put("/messages/:id/approve", (req, res) => {
  const { id } = req.params;
  db.query("UPDATE messages SET approved = 1 WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.delete("/messages/:id", (req, res) => {
  const { id } = req.params;
  db.query("DELETE FROM messages WHERE id = ?", [id], (err) =>
    err ? res.status(500).json({ error: err.message }) : res.json({ success: true })
  );
});

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

// ===================
//  DevilChat (API)
// ===================

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

// Nueva pregunta (admin) – desactiva anteriores y activa la nueva
app.post("/devilchat/api/admin/question", requireAdmin, (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: "Texto de pregunta requerido" });
  }
  db.query("UPDATE devil_questions SET active = 0 WHERE active = 1", () => {
    db.query(
      "INSERT INTO devil_questions (text, active) VALUES (?, 1)",
      [text.trim()],
      (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        const newQ = { id: result.insertId, text: text.trim(), active: 1 };
        io.emit("devilchat:newQuestion", newQ);
        io.emit("devilchat:status", { active: true, question: newQ });
        res.json({ success: true, question: newQ });
      }
    );
  });
});

// Activar/Desactivar (admin)
app.post("/devilchat/api/admin/active", requireAdmin, (req, res) => {
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
app.get("/devilchat/api/admin/questions", requireAdmin, (req, res) => {
  db.query(
    "SELECT id, text, active, created_at FROM devil_questions ORDER BY created_at DESC",
    (err, rows) => (err ? res.status(500).json({ error: err.message }) : res.json(rows))
  );
});

// Enviar respuesta (público; guarda client_id opcional)
app.post("/devilchat/api/answers", (req, res) => {
  const { text, clientId } = req.body || {};
  if (!text || !String(text).trim())
    return res.status(400).json({ error: "Texto requerido" });

  db.query("SELECT id FROM devil_questions WHERE active = 1 ORDER BY created_at DESC LIMIT 1",
  (e, rows) => {
    if (e) return res.status(500).json({ error: e.message });
    if (!rows[0]) return res.status(409).json({ error: "No hay pregunta activa" });

    const qid = rows[0].id;
    db.query(
      "INSERT INTO devil_answers (question_id, text, approved, client_id) VALUES (?, ?, 0, ?)",
      [qid, text.trim(), clientId || null],
      (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        const pending = {
          id: result.insertId, question_id: qid,
          text: text.trim(), approved: 0, client_id: clientId || null
        };
        io.emit("devilchat:pending", pending);
        res.json({ success: true, id: pending.id });
      }
    );
  });
});

// Pendientes (última pregunta activa) (admin)
app.get("/devilchat/api/admin/answers/pending", requireAdmin, (req, res) => {
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

// Aprobar respuesta (admin)
app.put("/devilchat/api/admin/answers/:id/approve", requireAdmin, (req, res) => {
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

// Eliminar respuesta (admin)
app.delete("/devilchat/api/admin/answers/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  db.query("DELETE FROM devil_answers WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    io.emit("devilchat:pending:remove", { id: Number(id) });
    res.json({ success: true });
  });
});

// Like a respuesta (público)
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

// Responder (como diablo) a una respuesta concreta (admin)
app.put("/devilchat/api/admin/answers/:id/reply", requireAdmin, (req, res) => {
  const { id } = req.params;
  const { reply } = req.body || {};
  if (!reply || !String(reply).trim())
    return res.status(400).json({ error: "Respuesta del diablo requerida" });

  db.query("UPDATE devil_answers SET devil_reply = ? WHERE id = ?", [reply.trim(), id], (err) => {
    if (err) return res.status(500).json({ error: err.message });

    db.query("SELECT id, text, client_id FROM devil_answers WHERE id = ?", [id], (e, rows) => {
      if (e) return res.status(500).json({ error: e.message });
      const row = rows[0];
      if (row?.client_id) {
        io.to(`client:${row.client_id}`).emit("devilchat:reply", { id: row.id, reply: reply.trim() });
      }
      io.emit("devilchat:new", { id: `devil-${Date.now()}`, text: reply.trim(), from: "devil", ts: Date.now() });
      res.json({ success: true });
    });
  });
});

// Premiar un mensaje (admin)
app.put("/devilchat/api/admin/answers/:id/reward", requireAdmin, (req, res) => {
  const { id } = req.params;
  let { type, code } = req.body || {};
  if (!["shot", "drink"].includes(type)) type = "shot";
  if (!code) code = Math.random().toString(36).slice(2, 8).toUpperCase();

  db.query(
    "UPDATE devil_answers SET reward_type = ?, reward_code = ?, reward_at = NOW() WHERE id = ?",
    [type, code, id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });

      db.query("SELECT id, text, client_id FROM devil_answers WHERE id = ?", [id], (e, rows) => {
        if (e) return res.status(500).json({ error: e.message });
        const row = rows[0];

        if (row?.client_id) {
          io.to(`client:${row.client_id}`).emit("devilchat:reward", { id: row.id, type, code });
        }
        io.emit("devilchat:rewarded", { id: row.id, type });
        res.json({ success: true, type, code });
      });
    }
  );
});

// =======================================
//  Static / SPA DevilChat (después del API)
// =======================================
const devilStaticPath = path.join(__dirname, "public-devil");
app.use("/devilchat", express.static(devilStaticPath));
app.get(/^\/devilchat(?!\/api)(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(devilStaticPath, "index.html"));
});

// ===================
//  Socket.IO wiring
// ===================
io.on("connection", (socket) => {
  console.log("🔌 DevilChat client connected", socket.id);

  // registro de cliente móvil para respuestas directas
  socket.on("devilchat:register", ({ clientId }) => {
    if (!clientId) return;
    socket.join(`client:${clientId}`);
  });

  // registro del panel admin (opcional, para emisiones dirigidas)
  socket.on("devilchat:admin:register", ({ key }) => {
    if (key !== ADMIN_KEY) {
      socket.emit("devilchat:admin:error", "Clave de admin inválida");
      return;
    }
    socket.join("deviladmin");
    socket.emit("devilchat:admin:ok", true);
  });

  socket.on("disconnect", () => console.log("🔌 DevilChat client disconnected", socket.id));
});

// 🚀 server.listen
const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
  console.log(`🚀 API + Socket.IO corriendo en http://localhost:${PORT}`);
});
