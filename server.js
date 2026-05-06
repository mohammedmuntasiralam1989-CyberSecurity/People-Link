const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const { Pool } = require('pg');

const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');

loadEnvFile();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const peerServer = ExpressPeerServer(server, { debug: true, path: '/' });
app.use('/peerjs', peerServer);

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'people-link-dev-secret-change-me';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

if (!process.env.DATABASE_URL) {
    console.warn('⚠️  Warning: DATABASE_URL is not set in your .env file. Database features will fail.');
}

// InsForge PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test DB Connection and Initialize Tables
async function initDatabase() {
    try {
        const schemaSQL = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
        // Split by semicolon to execute one by one if needed, but pg can handle multiple statements if they don't return rows
        await pool.query(schemaSQL);
        console.log('✅ Database tables initialized successfully');
    } catch (err) {
        console.error('⚠️  Database initialization warning:', err.message);
    }
}

pool.connect((err, client, release) => {
    if (err) {
        return console.error('❌ Error acquiring client from pool', err.stack);
    }
    console.log('✅ Connected to PostgreSQL Database Successfully');
    release();
    // Initialize tables after connection
    initDatabase();
});

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

function loadEnvFile() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) return;
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = value;
    });
}

async function askGemini(prompt) {
    if (!GEMINI_API_KEY) return null;
    const models = ['gemini-1.5-flash', 'gemini-pro', 'gemini-1.0-pro'];
    
    for (const model of models) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            });

            if (response.ok) {
                const data = await response.json();
                return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            }
            
            const errData = await response.json().catch(() => ({}));
            if (response.status === 404) {
                console.warn(`Model ${model} not found, trying next...`);
                continue;
            }
            
            console.warn(`Gemini API error (${model}):`, response.status, errData);
            return null;
        } catch (err) {
            console.error(`Gemini API Error (${model}):`, err);
            return null;
        }
    }
    return null;
}

function base64Url(input) {
    return Buffer.from(input).toString('base64url');
}

function sign(value) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function createToken(user) {
    const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64Url(JSON.stringify({
        sub: user.id,
        username: user.username,
        exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7)
    }));
    const unsigned = `${header}.${payload}`;
    return `${unsigned}.${sign(unsigned)}`;
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const unsigned = `${parts[0]}.${parts[1]}`;
    const expected = sign(unsigned);
    const received = parts[2];

    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(received);
    if (expectedBuffer.length !== receivedBuffer.length) return null;
    if (!crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) return null;

    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch (_err) { return null; }
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('base64url');
    const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('base64url');
    return `pbkdf2_sha256$310000$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
    if (!storedHash || !storedHash.startsWith('pbkdf2_sha256$')) return false;
    const [, iterationsText, salt, originalHash] = storedHash.split('$');
    const iterations = Number(iterationsText);
    if (!iterations || !salt || !originalHash) return false;

    const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url');
    const hashBuffer = Buffer.from(hash);
    const originalBuffer = Buffer.from(originalHash);
    return hashBuffer.length === originalBuffer.length && crypto.timingSafeEqual(hashBuffer, originalBuffer);
}

function sanitizeUser(user) {
    if (!user) return null;
    const safeUser = { ...user };
    delete safeUser.password_hash;
    delete safeUser.password;
    // Map camelCase for frontend
    safeUser.fullName = safeUser.full_name;
    safeUser.avatarUrl = safeUser.avatar_url;
    return safeUser;
}

// ── Auth Middleware ──
async function authRequired(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ message: 'Authentication required' });

    try {
        const result = await pool.query('SELECT * FROM users WHERE id::TEXT = $1', [payload.sub]);
        if (result.rows.length === 0) return res.status(401).json({ message: 'User not found' });
        req.user = result.rows[0];
        next();
    } catch (err) {
        console.error('Auth Middleware Error:', err);
        res.status(500).json({ message: 'Database error' });
    }
}

// ── Routes ──
app.post('/api/signup', async (req, res) => {
    try {
        const fullName = String(req.body.fullName || '').trim();
        const email = String(req.body.email || '').trim().toLowerCase();
        const username = String(req.body.username || '').trim();
        const password = String(req.body.password || '');

        if (!fullName || !email || !username || password.length < 6) {
            return res.status(400).json({ message: 'Invalid input' });
        }

        const passHash = hashPassword(password);

        try {
            const result = await pool.query(
                `INSERT INTO users (username, full_name, email, password_hash) 
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [username, fullName, email, passHash]
            );
            const user = result.rows[0];
            res.status(201).json({ message: 'User created', user: sanitizeUser(user), token: createToken(user) });
        } catch (dbErr) {
            console.error('Signup DB Error:', dbErr);
            return res.status(400).json({ message: 'Email or username already exists' });
        }
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const identifier = String(req.body.identifier || '').trim().toLowerCase();
        const password = String(req.body.password || '');

        const result = await pool.query(
            `SELECT * FROM users WHERE LOWER(email) = $1 OR LOWER(username) = $1`,
            [identifier]
        );

        const user = result.rows[0];
        if (!user || !verifyPassword(password, user.password_hash)) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        res.json({ message: 'Login successful', user: sanitizeUser(user), token: createToken(user) });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/me', authRequired, (req, res) => {
    res.json({ user: sanitizeUser(req.user) });
});

app.patch('/api/me', authRequired, async (req, res) => {
    try {
        const fullName = String(req.body.fullName || '').trim();
        const email = String(req.body.email || '').trim().toLowerCase();
        const username = String(req.body.username || '').trim();
        const bio = String(req.body.bio || '').trim();
        const avatarUrl = req.body.avatarUrl || null;

        const result = await pool.query(
            `UPDATE users SET full_name = $1, email = $2, username = $3, bio = $4, avatar_url = $5 WHERE id::TEXT = $6 RETURNING *`,
            [fullName, email, username, bio, avatarUrl, req.user.id]
        );
        res.json({ message: 'Profile updated', user: sanitizeUser(result.rows[0]) });
    } catch (err) {
        console.error('Profile Update Error:', err);
        res.status(400).json({ message: 'Update failed' });
    }
});

app.post('/api/change-password', authRequired, async (req, res) => {
    try {
        if (!verifyPassword(String(req.body.currentPassword || ''), req.user.password_hash)) {
            return res.status(400).json({ message: 'Current password incorrect' });
        }
        const newPassword = String(req.body.newPassword || '');
        if (newPassword.length < 6) return res.status(400).json({ message: 'Password too short' });

        await pool.query('UPDATE users SET password_hash = $1 WHERE id::TEXT = $2', [hashPassword(newPassword), req.user.id]);
        res.json({ message: 'Password updated' });
    } catch (err) {
        console.error('Change Password Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/users', async (_req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users');
        res.json(result.rows.map(sanitizeUser));
    } catch (err) {
        console.error('Get Users Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/users/search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        if (!q) return res.json([]);
        const result = await pool.query(
            `SELECT * FROM users WHERE LOWER(username) LIKE $1 OR LOWER(full_name) LIKE $1 OR LOWER(email) LIKE $1 LIMIT 10`,
            [`%${q}%`]
        );
        res.json(result.rows.map(sanitizeUser));
    } catch (err) {
        console.error('Search Users Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/users/:userId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE id::TEXT = $1 OR username = $1', [req.params.userId]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
        res.json(sanitizeUser(result.rows[0]));
    } catch (err) {
        console.error('Get Single User Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/posts', authRequired, async (req, res) => {
    try {
        const content = String(req.body.content || '').trim();
        const { image, video, filter, music } = req.body;
        if (!content && !image && !video) return res.status(400).json({ message: 'Content required' });

        const result = await pool.query(
            `INSERT INTO posts (author_id, content, image, video, filter, music) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [req.user.id, content, image, video, filter, music]
        );
        
        const post = { ...result.rows[0], authorName: req.user.full_name, authorAvatar: req.user.avatar_url };
        io.emit(post.video ? 'newReel' : 'newPost', post);

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Create Post Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// We load author details alongside posts
async function fetchPostsWithAuthors(videoOnly = false) {
    const query = `
        SELECT p.*, u.full_name as "authorName", u.username, u.avatar_url as "authorAvatar"
        FROM posts p LEFT JOIN users u ON p.author_id = u.id::TEXT
        ${videoOnly ? 'WHERE p.video IS NOT NULL' : ''}
        ORDER BY p.created_at DESC
    `;
    const result = await pool.query(query);
    return result.rows.map(p => {
        p.comments = typeof p.comments === 'string' ? JSON.parse(p.comments) : (p.comments || []);
        p.likedBy = p.liked_by || [];
        return p;
    });
}

app.get('/api/posts', async (_req, res) => {
    try { res.json(await fetchPostsWithAuthors()); } catch (err) { console.error('GET /api/posts error:', err.message); res.status(500).json({ message: 'Server error' }); }
});

app.get('/api/reels', async (_req, res) => {
    try { res.json(await fetchPostsWithAuthors(true)); } catch (err) { console.error('GET /api/reels error:', err.message); res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/posts/:postId/like', authRequired, async (req, res) => {
    try {
        const postRes = await pool.query('SELECT * FROM posts WHERE id::TEXT = $1', [req.params.postId]);
        if (postRes.rows.length === 0) return res.status(404).json({ message: 'Not found' });
        const post = postRes.rows[0];
        let likedBy = post.liked_by || [];
        const isLiked = likedBy.includes(req.user.id);

        if (isLiked) {
            likedBy = likedBy.filter(id => id !== req.user.id);
        } else {
            likedBy.push(req.user.id);
            if (post.author_id && post.author_id !== req.user.id) {
                await pool.query(
                    `INSERT INTO notifications (type, from_id, to_id, post_id, preview) VALUES ($1, $2, $3, $4, $5)`,
                    ['like', req.user.id, post.author_id, post.id, '']
                );
            }
        }
        const likes = likedBy.length;
        await pool.query('UPDATE posts SET liked_by = $1, likes = $2 WHERE id::TEXT = $3', [likedBy, likes, post.id]);
        res.json({ likes, liked: !isLiked, likedByMe: !isLiked });
    } catch (err) {
        console.error('Like Post Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/posts/:postId/comments', authRequired, async (req, res) => {
    try {
        const text = String(req.body.text || '');
        const postRes = await pool.query('SELECT * FROM posts WHERE id::TEXT = $1', [req.params.postId]);
        if (postRes.rows.length === 0) return res.status(404).json({ message: 'Not found' });
        const post = postRes.rows[0];

        const comment = {
            id: crypto.randomUUID(),
            authorId: req.user.id,
            authorName: req.user.full_name || req.user.username,
            authorAvatar: req.user.avatar_url,
            text,
            createdAt: new Date().toISOString()
        };

        const comments = typeof post.comments === 'string' ? JSON.parse(post.comments) : (post.comments || []);
        comments.push(comment);

        await pool.query('UPDATE posts SET comments = $1 WHERE id::TEXT = $2', [JSON.stringify(comments), post.id]);

        if (post.author_id && post.author_id !== req.user.id) {
            await pool.query(
                `INSERT INTO notifications (type, from_id, to_id, post_id, preview) VALUES ($1, $2, $3, $4, $5)`,
                ['comment', req.user.id, post.author_id, post.id, text.slice(0, 60)]
            );
        }
        res.status(201).json(comment);
    } catch (err) {
        console.error('Comment Post Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/stories', async (_req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.*, u.full_name as "userName", u.avatar_url as "userAvatar"
            FROM stories s LEFT JOIN users u ON s.author_id = u.id::TEXT
            WHERE s.created_at > NOW() - INTERVAL '24 hours'
        `);
        res.json(result.rows);
    } catch (err) { console.error('GET /api/stories error:', err.message); res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/stories', authRequired, async (req, res) => {
    try {
        const { data, type, image, video } = req.body;
        const storyData = data || image || video;
        const storyType = type || (video ? 'video' : 'image');
        if (!storyData) return res.status(400).json({ message: 'Media required' });

        const result = await pool.query(
            `INSERT INTO stories (author_id, type, data, image, video) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [req.user.id, storyType, storyData, storyType === 'image' ? storyData : null, storyType === 'video' ? storyData : null]
        );

        const story = { ...result.rows[0], userName: req.user.full_name, userAvatar: req.user.avatar_url };
        io.emit('newStory', story);

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Create Story Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/follow', authRequired, async (req, res) => {
    try {
        const { targetId } = req.body;
        if (targetId === req.user.id) return res.status(400).json({ message: 'Cannot follow self' });

        const existsRes = await pool.query('SELECT * FROM users WHERE id::TEXT = $1', [targetId]);
        if (existsRes.rows.length === 0) return res.status(404).json({ message: 'Not found' });

        let myFollowing = req.user.following || [];
        const isFollowing = myFollowing.includes(targetId);

        if (isFollowing) {
            myFollowing = myFollowing.filter(id => id !== targetId);
            await pool.query('UPDATE users SET following = $1 WHERE id::TEXT = $2', [myFollowing, req.user.id]);
            // Remove from target followers
            await pool.query('UPDATE users SET followers = array_remove(COALESCE(followers, ARRAY[]::TEXT[]), $1) WHERE id = $2', [req.user.id, targetId]);
            res.json({ message: 'Unfollowed', following: false });
        } else {
            myFollowing.push(targetId);
            await pool.query('UPDATE users SET following = $1 WHERE id::TEXT = $2', [myFollowing, req.user.id]);
            // Add to target followers
            await pool.query('UPDATE users SET followers = array_append(COALESCE(followers, ARRAY[]::TEXT[]), $1) WHERE id = $2', [req.user.id, targetId]);
            await pool.query(
                `INSERT INTO notifications (type, from_id, to_id, preview) VALUES ($1, $2, $3, $4)`,
                ['follow', req.user.id, targetId, '']
            );
            res.json({ message: 'Followed', following: true });
        }
    } catch (err) {
        console.error('Follow Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/notifications', authRequired, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT n.*, u.full_name as "fromName", u.avatar_url as "fromAvatar"
            FROM notifications n LEFT JOIN users u ON n.from_id = u.id::TEXT
            WHERE n.to_id = $1 ORDER BY n.created_at DESC
        `, [req.user.id]);
        res.json(result.rows.map(r => ({ ...r, fromId: r.from_id, postId: r.post_id })));
    } catch (err) { console.error('GET /api/notifications error:', err.message); res.status(500).json({ message: 'Server error' }); }
});

// ── AI Routes ──
app.post('/api/ai/monitor', async (req, res) => {
    const fallback = 'AI System monitoring is active.';
    if (!GEMINI_API_KEY) return res.json({ insight: fallback });
    try {
        const { stats } = req.body;
        const text = await askGemini(`Analyze these platform stats: ${JSON.stringify(stats)}. Give a very short insight.`);
        res.json({ insight: text || fallback });
    } catch (err) {
        res.json({ insight: fallback });
    }
});

app.post('/api/ai/suggest', async (req, res) => {
    const fallback = 'AI suggestion is ready.';
    if (!GEMINI_API_KEY) return res.json({ choices: [{ message: { content: fallback } }] });
    try {
        const prompt = String(req.body.prompt || '').slice(0, 1000);
        const text = await askGemini(`Write a creative social media post about: ${prompt}`);
        res.json({ choices: [{ message: { content: text || fallback } }] });
    } catch (err) {
        res.json({ choices: [{ message: { content: fallback } }] });
    }
});

// Real-time Chat
io.on('connection', (socket) => {
    socket.on('join', (userId) => socket.join(userId));
    socket.on('sendMessage', async (data) => {
        io.to(data.to).emit('newMessage', data);
        try {
            await pool.query(
                `INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1, $2, $3)`,
                [data.from, data.to, data.text]
            );
            await pool.query(
                `INSERT INTO notifications (type, from_id, to_id, preview) VALUES ($1, $2, $3, $4)`,
                ['message', data.from, data.to, data.text.slice(0, 50)]
            );
            io.to(data.to).emit('notificationUpdate');
        } catch (err) { console.error('Save message err', err); }
    });

    // --- Call Signaling ---
    socket.on('initiateCall', (data) => {
        // data: { to: 'targetId', from: 'myId', peerId: 'myPeerId', name: 'myName' }
        io.to(data.to).emit('incomingCall', {
            from: data.from,
            peerId: data.peerId,
            name: data.name
        });
    });

    socket.on('endCall', (data) => {
        // data: { to: 'targetId' }
        io.to(data.to).emit('callEnded');
    });
});

app.get('/api/messages/:peerId', authRequired, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT *, sender_id as "fromId", receiver_id as "toId", created_at as "createdAt" 
            FROM messages WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
            ORDER BY created_at ASC
        `, [req.user.id, req.params.peerId]);
        res.json(result.rows.map(m => ({ ...m, fromId: m.sender_id, toId: m.receiver_id })));
    } catch (err) {
        console.error('Get Messages Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/conversations', authRequired, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM (
                SELECT DISTINCT ON (peer_id) 
                    t.*, 
                    u.full_name as "peerName", 
                    u.avatar_url as "peerAvatar"
                FROM (
                    SELECT receiver_id as peer_id, text as "lastMessage", created_at as "lastTime" FROM messages WHERE sender_id = $1
                    UNION ALL
                    SELECT sender_id as peer_id, text as "lastMessage", created_at as "lastTime" FROM messages WHERE receiver_id = $1
                ) t 
                LEFT JOIN users u ON t.peer_id = u.id::TEXT
                ORDER BY peer_id, "lastTime" DESC
            ) final_conv
            ORDER BY "lastTime" DESC
        `, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        console.error('Get Conversations Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Lives (In memory)
const activeLives = [];
app.get('/api/live', (_req, res) => res.json(activeLives.filter(l => Date.now() - l.updatedAt < 300000)));

app.post('/api/live/heartbeat', authRequired, (req, res) => {
    const { liveId } = req.body;
    let live = activeLives.find(l => l.id === liveId);
    if (live) live.updatedAt = Date.now();
    else activeLives.push({ id: liveId, userName: req.user.full_name || req.user.username, userAvatar: req.user.avatar_url, updatedAt: Date.now() });
    res.json({ message: 'Heartbeat received' });
});

app.use((_req, res) => res.status(404).sendFile(path.join(__dirname, '404.html')));

const os = require('os');
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Error: Port ${PORT} is already in use.`);
        console.error(`   - Please close any other terminal running the server.`);
        console.error(`   - Or change the PORT in your .env file (e.g., PORT=4000).\n`);
    } else {
        console.error('❌ Server startup error:', err);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 People Link Backend is running!`);
    console.log(`   - Local PC:   http://localhost:${PORT}`);
    console.log(`   - Wi-Fi/Mobile: http://${getLocalIp()}:${PORT}\n`);
});
