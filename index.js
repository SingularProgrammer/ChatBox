const express = require('express');
const http = require('http');
const session = require('express-session');
const { Server } = require("socket.io");
const multer = require('multer');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const UPLOAD_DIR = 'public/uploads';

var ServerData = {
    "Name": "ChatBox",
    "Description": "Open source chat server.",
    "DatabaseSecret": "serversecret123"
};

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (fs.existsSync("install.json")) {
    const data = JSON.parse(
        fs.readFileSync('install.json', 'utf8')
    );
    ServerData.Name = data.Name;
    ServerData.Description = data.Description;
    ServerData.DatabaseSecret = data.DatabaseSecret;

    db.get("SELECT COUNT(*) AS count FROM users", (err, row) => {
        if (row.count === 0) {
            const pass = data.AdminPassword; // Default password
            bcrypt.hash(pass, 10, (err, hash) => {
                const color = '#' + Math.floor(Math.random() * 16777215).toString(16);
                db.run("INSERT INTO users (username, password, role, avatar_color) VALUES (?, ?, ?, ?)",
                    [data.Admin, hash, 'Owner', color]);
                console.log("Varsayılan kullanıcı oluşturuldu: Owner / admin123");
            });
            // Default Channel
            db.run("INSERT INTO channels (name, rules_json) VALUES (?, ?)", ['General', '{"slowmode":0}']);
        }
    });
} else {
    console.log("install.json File Not Found! Add this to install file:" + {
        "Name": "",
        "Description": "",
        "DatabaseSecret": "",
        "Admin": "",
        "AdminPassword": ""
    });
    process.exit(1);
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

const sessionMiddleware = session({
    secret: ServerData.DatabaseSecret,
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);

const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Yetki Seviyeleri
const roles = { 'Owner': 4, 'Admin': 3, 'User': 2, 'Guest': 1, 'Passive': 0 };

function hasPermission(userRole, requiredLevel) {
    return (roles[userRole] || 0) >= (roles[requiredLevel] || 0);
}

function isAuthenticated(req, res, next) {
    if (req.session.userId) next();
    else res.status(401).json({ error: "You need to sign in." });
}

// --- API ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (err || !user) return res.status(401).json({ error: "User not Found." });
        if (user.is_banned) return res.status(403).json({ error: "You banned." });

        if (await bcrypt.compare(password, user.password)) {
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.role = user.role;
            req.session.color = user.avatar_color;
            req.session.save();
            res.json({ success: true, user: { id: user.id, username: user.username, role: user.role, color: user.avatar_color } });
        } else {
            res.status(401).json({ error: "Wrong password." });
        }
    });
});

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Incomplete information." });
    db.get("SELECT id FROM users WHERE username = ?", [username], (err, row) => {
        if (row) return res.status(400).json({ error: "Username has taken." });
        bcrypt.hash(password, 10, (err, hash) => {
            const color = '#' + Math.floor(Math.random() * 16777215).toString(16);
            db.run("INSERT INTO users (username, password, role, avatar_color, created_at) VALUES (?, ?, ?, ?, ?)",
                [username, hash, 'User', color, new Date().toISOString()],
                (err) => {
                    if (err) return res.status(500).json({ error: "DB Error" });
                    res.json({ success: true });
                }
            );
        });
    });
});

app.post('/api/get-server', (req, res) => {
    res.json({ Name: ServerData.Name, Description: ServerData.Description });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.post('/api/upload', isAuthenticated, upload.array('files'), (req, res) => {
    const files = req.files.map(f => ({ name: f.originalname, type: f.mimetype, url: `/uploads/${f.filename}` }));
    res.json({ files });
});

// --- Socket.IO ---
io.on('connection', (socket) => {
    const sess = socket.request.session;
    if (!sess || !sess.userId) return;

    let currentUser = { id: sess.userId, username: sess.username, role: sess.role, color: sess.color };

    // Kullanıcıyı veritabanından teyit et (Rol değişikliği vs. için)
    db.get("SELECT * FROM users WHERE id = ?", [sess.userId], (err, user) => {
        if (user) {
            currentUser.role = user.role;
            currentUser.is_banned = user.is_banned;
            currentUser.muted_until = user.muted_until;

            // Kullanıcı bağlandığında hemen kanal listesini gönder
            broadcastChannels(socket);
            broadcastUserList();
        }
    });

    socket.on('join_channel', (channelId) => {
        // 1. Önceki TÜM kanal odalarından ayrıl (Temizlik)
        // socket.rooms bir Set'tir, Array'e çevirip dönüyoruz.
        const rooms = Array.from(socket.rooms);
        rooms.forEach(room => {
            // Sadece 'channel_' ile başlayan odalardan çık, 'server_global' gibi odalarda kal.
            if (room.startsWith('channel_')) {
                socket.leave(room);
            }
        });

        // 2. Yeni odaya gir
        socket.join(`channel_${channelId}`);

        // 3. Kanal geçmişini gönder
        const query = `
            SELECT m.*, u.username, u.role, u.avatar_color 
            FROM messages m 
            LEFT JOIN users u ON m.user_id = u.id 
            WHERE m.channel_id = ? 
            ORDER BY m.id ASC`;

        db.all(query, [channelId], (err, messages) => {
            if (err) return;

            const promises = messages.map(msg => {
                return new Promise(resolve => {
                    db.all("SELECT emoji, user_id FROM reactions WHERE message_id = ?", [msg.id], (err, rows) => {
                        msg.reactions = rows.reduce((acc, r) => {
                            if (!acc[r.emoji]) acc[r.emoji] = [];
                            acc[r.emoji].push(r.user_id);
                            return acc;
                        }, {});

                        if (msg.file_url) {
                            msg.files = [{ url: msg.file_url, name: msg.file_name, type: 'file' }];
                        } else {
                            msg.files = [];
                        }
                        resolve(msg);
                    });
                });
            });

            Promise.all(promises).then(finalMsgs => {
                // İstemciye bu verinin HANGİ kanal için olduğunu da gönderiyoruz ki karışıklık olmasın
                socket.emit('channel_history', { channelId: channelId, messages: finalMsgs });
            });
        });
    });

    socket.on('manage_channel', (data) => {
        if (!hasPermission(currentUser.role, 'Admin')) return;
        const { action, id, name, read, write, rules } = data;

        if (action === 'create') {
            db.run("INSERT INTO channels (name, read_permission, write_permission, rules_json, creator_id) VALUES (?, ?, ?, ?, ?)",
                [name, read, write, JSON.stringify(rules), currentUser.id],
                () => broadcastChannels(io) // Tüm kullanıcılara güncel listeyi gönder
            );
        } else if (action === 'edit') {
            db.run("UPDATE channels SET name=?, read_permission=?, write_permission=?, rules_json=? WHERE id=?",
                [name, read, write, JSON.stringify(rules), id],
                () => broadcastChannels(io)
            );
        } else if (action === 'delete') {
            db.run("DELETE FROM channels WHERE id=?", [id], () => {
                db.run("DELETE FROM messages WHERE channel_id=?", [id]);
                broadcastChannels(io);
            });
        }
    });

    socket.on('send_message', (data) => {
        if (currentUser.is_banned || currentUser.muted_until > Date.now()) return;

        db.get("SELECT write_permission FROM channels WHERE id=?", [data.channelId], (err, ch) => {
            if (!ch || !hasPermission(currentUser.role, ch.write_permission)) return socket.emit('error', 'You do not have permission.');

            const timestamp = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
            const fileUrl = data.files.length > 0 ? data.files[0].url : null;
            const fileName = data.files.length > 0 ? data.files[0].name : null;
            const type = fileUrl ? 'file' : 'text';

            db.run(`INSERT INTO messages (channel_id, user_id, content, type, file_url, file_name, parent_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [data.channelId, currentUser.id, data.content, type, fileUrl, fileName, data.parentId, timestamp],
                function (err) {
                    if (!err) {
                        const newMsg = {
                            id: this.lastID, channel_id: data.channelId, user_id: currentUser.id, username: currentUser.username, role: currentUser.role, avatar_color: currentUser.color,
                            content: data.content, timestamp, files: data.files, reactions: {}, parent_id: data.parentId, is_pinned: 0, is_edited: 0
                        };
                        io.to(`channel_${data.channelId}`).emit('new_message', newMsg);
                    }
                }
            );
        });
    });

    socket.on('delete_message', ({ id }) => {
        db.get("SELECT user_id, channel_id FROM messages WHERE id=?", [id], (err, msg) => {
            if (!msg) return;
            if (msg.user_id === currentUser.id || hasPermission(currentUser.role, 'Admin')) {
                db.run("DELETE FROM messages WHERE id=?", [id], () => io.to(`channel_${msg.channel_id}`).emit('message_deleted', { id }));
            }
        });
    });

    socket.on('edit_message', ({ id, content }) => {
        db.get("SELECT user_id, channel_id FROM messages WHERE id=?", [id], (err, msg) => {
            if (!msg) return;
            if (msg.user_id === currentUser.id) {
                db.run("UPDATE messages SET content=?, is_edited=1 WHERE id=?", [content, id], () => io.to(`channel_${msg.channel_id}`).emit('message_updated', { id, content, is_edited: 1 }));
            }
        });
    });

    socket.on('toggle_pin', ({ id }) => {
        if (!hasPermission(currentUser.role, 'Admin')) return;
        db.get("SELECT is_pinned, channel_id FROM messages WHERE id=?", [id], (err, msg) => {
            const newState = msg.is_pinned ? 0 : 1;
            db.run("UPDATE messages SET is_pinned=? WHERE id=?", [newState, id], () => io.to(`channel_${msg.channel_id}`).emit('message_pinned', { id, is_pinned: newState }));
        });
    });

    socket.on('toggle_reaction', ({ messageId, emoji }) => {
        db.get("SELECT id FROM reactions WHERE message_id=? AND user_id=? AND emoji=?", [messageId, currentUser.id, emoji], (err, row) => {
            if (row) {
                db.run("DELETE FROM reactions WHERE id=?", [row.id], () => io.emit('reaction_update', { messageId, emoji, userId: currentUser.id, action: 'remove' }));
            } else {
                db.run("INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)", [messageId, currentUser.id, emoji], () => io.emit('reaction_update', { messageId, emoji, userId: currentUser.id, action: 'add' }));
            }
        });
    });

    socket.on('user_action', ({ userId, action, value }) => {
        if (!hasPermission(currentUser.role, 'Admin')) return;
        if (action === 'role' && currentUser.role !== 'Owner') return;

        let query = "";
        let params = [];

        if (action === 'role') { query = "UPDATE users SET role=? WHERE id=?"; params = [value, userId]; }
        else if (action === 'ban') { query = "UPDATE users SET is_banned=? WHERE id=?"; params = [value ? 1 : 0, userId]; }
        else if (action === 'timeout') { query = "UPDATE users SET muted_until=? WHERE id=?"; params = [value ? Date.now() + 600000 : 0, userId]; }

        if (query) db.run(query, params, () => broadcastUserList());
    });

    // Yardımcı Fonksiyonlar
    function broadcastChannels(target) {
        // Veritabanından en güncel hali çek
        db.all("SELECT * FROM channels", (err, channels) => {
            if (!err) {
                // 'init_channels' olayı ile tüm istemcilere (target = io) gönder
                target.emit('init_channels', channels);
            }
        });
    }

    function broadcastUserList() {
        db.all("SELECT id, username, role, is_banned, muted_until, avatar_color FROM users", (err, rows) => {
            if (err) return;
            const usersList = rows.map(u => {
                const isOnline = Array.from(io.sockets.sockets.values()).some(s => s.request.session.userId === u.id);
                return { ...u, status: isOnline ? 'online' : 'offline' };
            });
            io.emit('update_users', usersList);
        });
    }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Sunucu ${PORT} portunda aktif.`));