const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const db = new sqlite3.Database('./chatbox.db');

db.serialize(() => {
    // 1. Users Table (English roles/status)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'User', -- Owner, Admin, User, Guest, Passive
        avatar_color TEXT,
        is_banned INTEGER DEFAULT 0,
        muted_until INTEGER DEFAULT 0,
        created_at TEXT
    )`);

    // 2. Channels Table
    db.run(`CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        read_permission TEXT DEFAULT 'Guest',
        write_permission TEXT DEFAULT 'User',
        rules_json TEXT DEFAULT '{}',
        creator_id INTEGER
    )`);

    // 3. Messages Table (Parent ID for threads)
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER,
        user_id INTEGER,
        content TEXT,
        type TEXT DEFAULT 'text', -- text, image, file
        file_url TEXT,
        file_name TEXT,
        parent_id INTEGER DEFAULT NULL, -- For threads
        is_pinned INTEGER DEFAULT 0,
        is_edited INTEGER DEFAULT 0,
        timestamp TEXT
    )`);

    // 4. Reactions Table
    db.run(`CREATE TABLE IF NOT EXISTS reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER,
        user_id INTEGER,
        emoji TEXT,
        UNIQUE(message_id, user_id, emoji)
    )`);
});

module.exports = db;