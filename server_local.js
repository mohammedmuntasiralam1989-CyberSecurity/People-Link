const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

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
const DB_FILE = path.join(__dirname, 'db.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'people-link-dev-secret-change-me';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

if (SESSION_SECRET === 'people-link-dev-secret-change-me') {
    console.warn('Warning: SESSION_SECRET is using the development fallback. Set it in .env before production.');
}

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

async function initDB() {
    if (!await fs.pathExists(DB_FILE)) {
        await fs.writeJson(DB_FILE, { users: [], posts: [], messages: [], notifications: [], stories: [] }, { spaces: 2 });
        return;
    }

    const data = await getData();
    data.users = Array.isArray(data.users) ? data.users : [];
    data.posts = Array.isArray(data.posts) ? data.posts : [];
    data.messages = Array.isArray(data.messages) ? data.messages : [];
    data.notifications = Array.isArray(data.notifications) ? data.notifications : [];
    data.stories = Array.isArray(data.stories) ? data.stories : [];
    await saveData(data);
}

async function getData() {
    return await fs.readJson(DB_FILE);
}

async function saveData(data) {
    await fs.writeJson(DB_FILE, data, { spaces: 2 });
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
    } catch (_err) {
        return null;
    }
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
    const { password, passwordHash, ...safeUser } = user;
    return safeUser;
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
    return String(username || '').trim();
}

async function authRequired(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = verifyToken(token);

    if (!payload) {
        return res.status(401).json({ message: 'Authentication required' });
    }

    const data = await getData();
    const user = data.users.find((u) => u.id === payload.sub);
    if (!user) {
        return res.status(401).json({ message: 'User not found' });
    }

    req.db = data;
    req.user = user;
    next();
}

function userMatchesIdentifier(user, identifier) {
    const normalized = String(identifier || '').trim().toLowerCase();
    return normalizeEmail(user.email) === normalized || String(user.username || '').toLowerCase() === normalized;
}

app.post('/api/signup', async (req, res) => {
    try {
        const fullName = String(req.body.fullName || '').trim();
        const email = normalizeEmail(req.body.email);
        const username = normalizeUsername(req.body.username);
        const password = String(req.body.password || '');

        if (!fullName || !email || !username || password.length < 6) {
            return res.status(400).json({ message: 'Full name, email, username, and a 6+ character password are required' });
        }

        const data = await getData();
        const exists = data.users.find((u) => normalizeEmail(u.email) === email || String(u.username || '').toLowerCase() === username.toLowerCase());
        if (exists) {
            return res.status(400).json({ message: 'User already exists' });
        }

        const newUser = {
            id: crypto.randomUUID(),
            fullName,
            email,
            username,
            bio: '',
            avatarUrl: null,
            passwordHash: hashPassword(password),
            createdAt: new Date().toISOString()
        };

        data.users.push(newUser);
        await saveData(data);

        res.status(201).json({
            message: 'User created',
            user: sanitizeUser(newUser),
            token: createToken(newUser)
        });
    } catch (err) {
        console.error('Signup Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;
        const data = await getData();
        const user = data.users.find((u) => userMatchesIdentifier(u, identifier));

        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const passwordOk = verifyPassword(String(password || ''), user.passwordHash);
        const legacyPasswordOk = !user.passwordHash && user.password === password;

        if (!passwordOk && !legacyPasswordOk) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        if (legacyPasswordOk) {
            user.passwordHash = hashPassword(password);
            delete user.password;
            await saveData(data);
        }

        res.json({
            message: 'Login successful',
            user: sanitizeUser(user),
            token: createToken(user)
        });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Profile update moved below (single PATCH /api/me with full validation)

app.get('/api/me', authRequired, (req, res) => {
    res.json({ user: sanitizeUser(req.user) });
});

app.patch('/api/me', authRequired, async (req, res) => {
    try {
        const fullName = String(req.body.fullName || '').trim();
        const email = normalizeEmail(req.body.email);
        const username = normalizeUsername(req.body.username);
        const bio = String(req.body.bio || '').trim();
        const avatarUrl = req.body.avatarUrl || null;

        if (!fullName || !email || !username) {
            return res.status(400).json({ message: 'Full name, email, and username are required' });
        }

        const duplicate = req.db.users.find((u) => {
            if (u.id === req.user.id) return false;
            return normalizeEmail(u.email) === email || String(u.username || '').toLowerCase() === username.toLowerCase();
        });

        if (duplicate) {
            return res.status(400).json({ message: 'Email or username is already in use' });
        }

        req.user.fullName = fullName;
        req.user.email = email;
        req.user.username = username;
        req.user.bio = bio;
        req.user.avatarUrl = avatarUrl;

        await saveData(req.db);
        res.json({ message: 'Profile updated', user: sanitizeUser(req.user) });
    } catch (err) {
        console.error('Profile Update Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/change-password', authRequired, async (req, res) => {
    try {
        const currentPassword = String(req.body.currentPassword || '');
        const newPassword = String(req.body.newPassword || '');

        if (!verifyPassword(currentPassword, req.user.passwordHash)) {
            return res.status(400).json({ message: 'Current password is incorrect' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        req.user.passwordHash = hashPassword(newPassword);
        delete req.user.password;
        await saveData(req.db);
        res.json({ message: 'Password updated' });
    } catch (err) {
        console.error('Password Update Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/users', async (_req, res) => {
    try {
        const data = await getData();
        res.json(data.users.map(sanitizeUser));
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/posts', async (_req, res) => {
    try {
        const data = await getData();
        res.json(data.posts.slice().reverse());
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

// Reels route defined below (single GET /api/reels)

// Stories routes defined below (single GET & POST /api/stories)

// ── Live Stream Management ──
app.get('/api/live', async (_req, res) => {
    try {
        const data = await getData();
        // Return lives that haven't expired (active in last 5 mins)
        const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const activeLives = (data.lives || []).filter(l => l.updatedAt > fiveMinsAgo);
        res.json(activeLives);
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/live/heartbeat', authRequired, async (req, res) => {
    try {
        const { liveId } = req.body;
        if (!liveId) return res.status(400).json({ message: 'Live ID is required' });
        
        req.db.lives = req.db.lives || [];
        let live = req.db.lives.find(l => l.id === liveId);
        
        if (live) {
            live.updatedAt = new Date().toISOString();
        } else {
            req.db.lives.push({
                id: liveId,
                userId: req.user.id,
                userName: req.user.fullName || req.user.username,
                userAvatar: req.user.avatarUrl,
                updatedAt: new Date().toISOString()
            });
        }
        
        await saveData(req.db);
        res.json({ message: 'Heartbeat received' });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/posts', authRequired, async (req, res) => {
    try {
        const content = String(req.body.content || '').trim();
        const { image, video } = req.body;

        if (!content && !image && !video) {
            return res.status(400).json({ message: 'Post content or media is required' });
        }

        const newPost = {
            id: crypto.randomUUID(),
            content,
            authorId: req.user.id,
            authorName: req.user.fullName || req.user.username,
            authorAvatar: req.user.avatarUrl || null,
            image: image || null,
            video: video || null,
            likes: 0,
            comments: [],
            createdAt: new Date().toISOString()
        };

        req.db.posts.push(newPost);
        await saveData(req.db);
        res.status(201).json(newPost);
    } catch (err) {
        console.error('Create Post Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Like route defined below as /api/posts/:postId/like with notification support

// Comment route defined below as /api/posts/:postId/comments with notification support

// ── Follow / Unfollow ──
app.post('/api/follow', authRequired, async (req, res) => {
    try {
        const targetId = req.body.targetId;
        if (!targetId) return res.status(400).json({ message: 'targetId required' });
        if (targetId === req.user.id) return res.status(400).json({ message: 'Cannot follow yourself' });

        const target = req.db.users.find(u => u.id === targetId);
        if (!target) return res.status(404).json({ message: 'User not found' });

        req.user.following = req.user.following || [];
        target.followers = target.followers || [];
        req.db.notifications = req.db.notifications || [];

        if (req.user.following.includes(targetId)) {
            req.user.following = req.user.following.filter(id => id !== targetId);
            target.followers = target.followers.filter(id => id !== req.user.id);
            await saveData(req.db);
            return res.json({ message: 'Unfollowed', following: false });
        }

        req.user.following.push(targetId);
        target.followers.push(req.user.id);
        req.db.notifications.push({
            id: crypto.randomUUID(),
            type: 'follow',
            fromId: req.user.id,
            fromName: req.user.fullName || req.user.username,
            fromAvatar: req.user.avatarUrl || null,
            toId: targetId,
            read: false,
            createdAt: new Date().toISOString()
        });
        await saveData(req.db);
        res.json({ message: 'Followed', following: true });
    } catch (err) {
        console.error('Follow Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ── Get notifications ──
app.get('/api/notifications', authRequired, (req, res) => {
    const notifs = (req.db.notifications || [])
        .filter(n => n.toId === req.user.id)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(notifs);
});

app.patch('/api/notifications/read', authRequired, async (req, res) => {
    (req.db.notifications || []).forEach(n => {
        if (n.toId === req.user.id) n.read = true;
    });
    await saveData(req.db);
    res.json({ message: 'Marked as read' });
});

// ── Messages ──
app.get('/api/messages/:peerId', authRequired, (req, res) => {
    const peerId = req.params.peerId;
    const messages = (req.db.messages || []).filter(m =>
        (m.fromId === req.user.id && m.toId === peerId) ||
        (m.fromId === peerId && m.toId === req.user.id)
    ).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    res.json(messages);
});

app.post('/api/messages', authRequired, async (req, res) => {
    try {
        const { toId, text } = req.body;
        if (!toId || !text) return res.status(400).json({ message: 'toId and text required' });

        req.db.messages = req.db.messages || [];
        req.db.notifications = req.db.notifications || [];

        const msg = {
            id: crypto.randomUUID(),
            fromId: req.user.id,
            fromName: req.user.fullName || req.user.username,
            fromAvatar: req.user.avatarUrl || null,
            toId,
            text: String(text).slice(0, 5000),
            createdAt: new Date().toISOString()
        };
        req.db.messages.push(msg);

        req.db.notifications.push({
            id: crypto.randomUUID(),
            type: 'message',
            fromId: req.user.id,
            fromName: req.user.fullName || req.user.username,
            fromAvatar: req.user.avatarUrl || null,
            toId,
            preview: String(text).slice(0, 60),
            read: false,
            createdAt: new Date().toISOString()
        });

        await saveData(req.db);
        res.status(201).json(msg);
    } catch (err) {
        console.error('Message Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/conversations', authRequired, (req, res) => {
    const msgs = req.db.messages || [];
    const convMap = {};
    msgs.forEach(m => {
        if (m.fromId !== req.user.id && m.toId !== req.user.id) return;
        const peerId = m.fromId === req.user.id ? m.toId : m.fromId;
        if (!convMap[peerId] || new Date(m.createdAt) > new Date(convMap[peerId].createdAt)) {
            convMap[peerId] = m;
        }
    });
    const convs = Object.entries(convMap).map(([peerId, lastMsg]) => {
        const peer = req.db.users.find(u => u.id === peerId);
        return {
            peerId,
            peerName: peer ? (peer.fullName || peer.username) : 'Unknown',
            peerAvatar: peer ? peer.avatarUrl : null,
            lastMessage: lastMsg.text,
            lastTime: lastMsg.createdAt
        };
    }).sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
    res.json(convs);
});

// ── Comments ──
app.post('/api/posts/:postId/comments', authRequired, async (req, res) => {
    try {
        const post = req.db.posts.find(p => p.id === req.params.postId);
        if (!post) return res.status(404).json({ message: 'Post not found' });

        const comment = {
            id: crypto.randomUUID(),
            authorId: req.user.id,
            authorName: req.user.fullName || req.user.username,
            authorAvatar: req.user.avatarUrl || null,
            text: String(req.body.text || '').slice(0, 2000),
            createdAt: new Date().toISOString()
        };
        post.comments = post.comments || [];
        post.comments.push(comment);

        if (post.authorId && post.authorId !== req.user.id) {
            req.db.notifications = req.db.notifications || [];
            req.db.notifications.push({
                id: crypto.randomUUID(),
                type: 'comment',
                fromId: req.user.id,
                fromName: req.user.fullName || req.user.username,
                fromAvatar: req.user.avatarUrl || null,
                toId: post.authorId,
                postId: post.id,
                preview: comment.text.slice(0, 60),
                read: false,
                createdAt: new Date().toISOString()
            });
        }

        await saveData(req.db);
        res.status(201).json(comment);
    } catch (err) {
        console.error('Comment Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ── Like / Unlike ──
app.post('/api/posts/:postId/like', authRequired, async (req, res) => {
    try {
        const post = req.db.posts.find(p => p.id === req.params.postId);
        if (!post) return res.status(404).json({ message: 'Post not found' });

        post.likedBy = post.likedBy || [];
        const idx = post.likedBy.indexOf(req.user.id);
        if (idx === -1) {
            post.likedBy.push(req.user.id);
            post.likes = post.likedBy.length;

            if (post.authorId && post.authorId !== req.user.id) {
                req.db.notifications = req.db.notifications || [];
                req.db.notifications.push({
                    id: crypto.randomUUID(),
                    type: 'like',
                    fromId: req.user.id,
                    fromName: req.user.fullName || req.user.username,
                    fromAvatar: req.user.avatarUrl || null,
                    toId: post.authorId,
                    postId: post.id,
                    read: false,
                    createdAt: new Date().toISOString()
                });
            }
        } else {
            post.likedBy.splice(idx, 1);
            post.likes = post.likedBy.length;
        }

        await saveData(req.db);
        const isLiked = post.likedBy.includes(req.user.id);
        res.json({ likes: post.likes, liked: isLiked, likedByMe: isLiked });
    } catch (err) {
        console.error('Like Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ── Search users ──
app.get('/api/users/search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();
        if (!q) return res.json([]);
        const data = await getData();
        const results = data.users
            .filter(u => (u.fullName || '').toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q))
            .map(sanitizeUser)
            .slice(0, 20);
        res.json(results);
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

// ── Get single user profile ──
app.get('/api/users/:userId', async (req, res) => {
    try {
        const data = await getData();
        const user = data.users.find(u => u.id === req.params.userId || u.username === req.params.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(sanitizeUser(user));
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

// ── Reels (uses posts with video) ──
app.get('/api/reels', async (_req, res) => {
    try {
        const data = await getData();
        const reels = data.posts.filter(p => p.video).reverse();
        res.json(reels);
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

// ── Stories ──
app.get('/api/stories', async (_req, res) => {
    try {
        const data = await getData();
        const dayMs = 24 * 60 * 60 * 1000;
        const stories = (data.stories || []).filter(s => Date.now() - new Date(s.createdAt).getTime() < dayMs);
        res.json(stories);
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/stories', authRequired, async (req, res) => {
    try {
        // Accept both {data,type} and {image,video} payload formats
        const { data: mediaData, type, image, video } = req.body;
        const storyData = mediaData || image || video;
        const storyType = type || (video ? 'video' : 'image');

        if (!storyData) return res.status(400).json({ message: 'Story media required' });

        req.db.stories = req.db.stories || [];
        const story = {
            id: crypto.randomUUID(),
            authorId: req.user.id,
            authorName: req.user.fullName || req.user.username,
            authorAvatar: req.user.avatarUrl || null,
            userName: req.user.fullName || req.user.username,
            userAvatar: req.user.avatarUrl || null,
            type: storyType,
            data: storyData,
            image: storyType === 'image' ? storyData : null,
            video: storyType === 'video' ? storyData : null,
            createdAt: new Date().toISOString()
        };
        req.db.stories.push(story);
        await saveData(req.db);
        res.status(201).json(story);
    } catch (err) {
        console.error('Story Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ── AI Monitor ──
app.get('/api/ai/monitor', async (_req, res) => {
    const fallback = 'System monitoring is ready. Add GEMINI_API_KEY in .env to enable live AI insights.';
    if (!GEMINI_API_KEY) return res.json({ insight: fallback });
    res.json({ insight: fallback });
});

app.post('/api/ai/monitor', async (req, res) => {
    const fallback = 'System monitoring is ready. Add GEMINI_API_KEY in .env to enable live AI insights.';
    try {
        if (!GEMINI_API_KEY) return res.status(503).json({ insight: fallback });

        const { stats } = req.body;
        const text = await askGemini(`You are a system health analyst for People Link social media. Analyze these stats and give a brief professional insight: ${JSON.stringify(stats)}`);
        res.json({ insight: text || fallback });
    } catch (err) {
        console.error('Monitor Proxy Error:', err);
        res.status(500).json({ insight: fallback });
    }
});

app.post('/api/ai/suggest', async (req, res) => {
    const fallback = 'AI suggestions are ready. Add GEMINI_API_KEY in .env to enable live writing help.';
    try {
        if (!GEMINI_API_KEY) {
            return res.status(503).json({ choices: [{ message: { content: fallback } }] });
        }

        const prompt = String(req.body.prompt || '').slice(0, 2000);
        const text = await askGemini(`You are a futuristic social media assistant for People Link. Keep responses short, engaging, and premium. Prompt: ${prompt}`);
        res.json({ choices: [{ message: { content: text || fallback } }] });
    } catch (err) {
        console.error('Gemini Proxy Error:', err.message);
        res.json({ choices: [{ message: { content: fallback } }] });
    }
});

async function askGemini(prompt) {
    if (typeof globalThis.fetch !== 'function') {
        console.warn('fetch() not available. Upgrade to Node 18+ for AI features.');
        return null;
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        })
    });

    if (!response.ok) {
        console.warn(`Gemini API returned ${response.status}`);
        return null;
    }

    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, '404.html'));
});

// --- Socket.io Real-time Logic ---
io.on('connection', (socket) => {
    console.log('User connected via Socket.io', socket.id);
    
    socket.on('join', (userId) => {
        socket.join(userId);
        console.log(`User ${userId} joined their room`);
    });

    socket.on('sendMessage', async (data) => {
        // Broadcast message to recipient
        io.to(data.to).emit('newMessage', data);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected', socket.id);
    });
});

initDB().then(() => {
    server.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        console.log(`PeerJS and Socket.io ready`);
    });
});
