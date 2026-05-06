// Netlify Function API Handler
// This adapts the Express routes for serverless deployment

const { Pool } = require('pg');
const crypto = require('crypto');

// Initialize database pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Helper functions
function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createToken(user, secret) {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    sub: user.id,
    username: user.username,
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7)
  }));
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign(unsigned, secret)}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = sign(unsigned, secret);
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
  safeUser.fullName = safeUser.full_name;
  safeUser.avatarUrl = safeUser.avatar_url;
  return safeUser;
}

function getAuthHeaders(event) {
  return event.headers.authorization || event.headers.Authorization || '';
}

async function authRequired(event) {
  const header = getAuthHeaders(event);
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token, process.env.SESSION_SECRET || 'people-link-dev-secret-change-me');
  if (!payload) return { error: 'Authentication required', status: 401 };
  
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (result.rows.length === 0) return { error: 'User not found', status: 401 };
    return { user: result.rows[0] };
  } catch (err) {
    return { error: 'Database error', status: 500 };
  }
}

// Route handlers
const handlers = {
  // Auth routes
  'POST /signup': async (event) => {
    const body = JSON.parse(event.body || '{}');
    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    
    if (!fullName || !email || !username || password.length < 6) {
      return { status: 400, body: { message: 'Invalid input' } };
    }
    
    try {
      const passHash = hashPassword(password);
      const result = await pool.query(
        `INSERT INTO users (username, full_name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING *`,
        [username, fullName, email, passHash]
      );
      const user = result.rows[0];
      const token = createToken(user, process.env.SESSION_SECRET || 'people-link-dev-secret-change-me');
      return { status: 201, body: { message: 'User created', user: sanitizeUser(user), token } };
    } catch (dbErr) {
      return { status: 400, body: { message: 'Email or username already exists' } };
    }
  },
  
  'POST /login': async (event) => {
    const body = JSON.parse(event.body || '{}');
    const identifier = String(body.identifier || '').trim().toLowerCase();
    const password = String(body.password || '');
    
    try {
      const result = await pool.query(
        `SELECT * FROM users WHERE LOWER(email) = $1 OR LOWER(username) = $1`,
        [identifier]
      );
      const user = result.rows[0];
      if (!user || !verifyPassword(password, user.password_hash)) {
        return { status: 401, body: { message: 'Invalid credentials' } };
      }
      const token = createToken(user, process.env.SESSION_SECRET || 'people-link-dev-secret-change-me');
      return { status: 200, body: { message: 'Login successful', user: sanitizeUser(user), token } };
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  'GET /me': async (event) => {
    const auth = await authRequired(event);
    if (auth.error) return { status: auth.status, body: { message: auth.error } };
    return { status: 200, body: { user: sanitizeUser(auth.user) } };
  },
  
  'PATCH /me': async (event) => {
    const auth = await authRequired(event);
    if (auth.error) return { status: auth.status, body: { message: auth.error } };
    
    const body = JSON.parse(event.body || '{}');
    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const username = String(body.username || '').trim();
    const bio = String(body.bio || '').trim();
    const avatarUrl = body.avatarUrl || null;
    
    try {
      const result = await pool.query(
        `UPDATE users SET full_name = $1, email = $2, username = $3, bio = $4, avatar_url = $5 WHERE id = $6 RETURNING *`,
        [fullName, email, username, bio, avatarUrl, auth.user.id]
      );
      return { status: 200, body: { message: 'Profile updated', user: sanitizeUser(result.rows[0]) } };
    } catch (err) {
      return { status: 400, body: { message: 'Update failed' } };
    }
  },
  
  'POST /change-password': async (event) => {
    const auth = await authRequired(event);
    if (auth.error) return { status: auth.status, body: { message: auth.error } };
    
    const body = JSON.parse(event.body || '{}');
    if (!verifyPassword(String(body.currentPassword || ''), auth.user.password_hash)) {
      return { status: 400, body: { message: 'Current password incorrect' } };
    }
    const newPassword = String(body.newPassword || '');
    if (newPassword.length < 6) return { status: 400, body: { message: 'Password too short' } };
    
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), auth.user.id]);
    return { status: 200, body: { message: 'Password updated' } };
  },
  
  // User routes
  'GET /users': async () => {
    try {
      const result = await pool.query('SELECT * FROM users');
      return { status: 200, body: result.rows.map(sanitizeUser) };
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  'GET /users/search': async (event) => {
    const q = String(event.queryStringParameters?.q || '').trim().toLowerCase();
    if (!q) return { status: 200, body: [] };
    try {
      const result = await pool.query(
        `SELECT * FROM users WHERE LOWER(username) LIKE $1 OR LOWER(full_name) LIKE $1 OR LOWER(email) LIKE $1 LIMIT 10`,
        [`%${q}%`]
      );
      return { status: 200, body: result.rows.map(sanitizeUser) };
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  'GET /users/:userId': async (event) => {
    const userId = event.path.split('/').pop();
    try {
      const result = await pool.query('SELECT * FROM users WHERE id = $1 OR username = $1', [userId]);
      if (result.rows.length === 0) return { status: 404, body: { message: 'User not found' } };
      return { status: 200, body: sanitizeUser(result.rows[0]) };
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  // Post routes
  'GET /posts': async () => {
    try {
      const result = await pool.query(`
        SELECT p.*, u.full_name as "authorName", u.username, u.avatar_url as "authorAvatar"
        FROM posts p LEFT JOIN users u ON p.author_id = u.id::TEXT
        ORDER BY p.created_at DESC
      `);
      return { status: 200, body: result.rows.map(p => {
        p.comments = typeof p.comments === 'string' ? JSON.parse(p.comments) : (p.comments || []);
        p.likedBy = p.liked_by || [];
        return p;
      })};
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  'GET /reels': async () => {
    try {
      const result = await pool.query(`
        SELECT p.*, u.full_name as "authorName", u.username, u.avatar_url as "authorAvatar"
        FROM posts p LEFT JOIN users u ON p.author_id = u.id::TEXT
        WHERE p.video IS NOT NULL
        ORDER BY p.created_at DESC
      `);
      return { status: 200, body: result.rows };
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  'POST /posts': async (event) => {
    const auth = await authRequired(event);
    if (auth.error) return { status: auth.status, body: { message: auth.error } };
    
    const body = JSON.parse(event.body || '{}');
    const content = String(body.content || '').trim();
    const { image, video, filter, music } = body;
    if (!content && !image && !video) return { status: 400, body: { message: 'Content required' } };
    
    try {
      const result = await pool.query(
        `INSERT INTO posts (author_id, content, image, video, filter, music) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [auth.user.id, content, image, video, filter, music]
      );
      return { status: 201, body: result.rows[0] };
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  'POST /posts/:postId/like': async (event) => {
    const auth = await authRequired(event);
    if (auth.error) return { status: auth.status, body: { message: auth.error } };
    
    const postId = event.path.split('/').slice(-2)[0];
    try {
      const postRes = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
      if (postRes.rows.length === 0) return { status: 404, body: { message: 'Not found' } };
      const post = postRes.rows[0];
      let likedBy = post.liked_by || [];
      const isLiked = likedBy.includes(auth.user.id);
      
      if (isLiked) {
        likedBy = likedBy.filter(id => id !== auth.user.id);
      } else {
        likedBy.push(auth.user.id);
      }
      const likes = likedBy.length;
      await pool.query('UPDATE posts SET liked_by = $1, likes = $2 WHERE id = $3', [likedBy, likes, post.id]);
      return { status: 200, body: { likes, liked: !isLiked, likedByMe: !isLiked } };
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  'POST /posts/:postId/comments': async (event) => {
    const auth = await authRequired(event);
    if (auth.error) return { status: auth.status, body: { message: auth.error } };
    
    const postId = event.path.split('/').slice(-2)[0];
    const body = JSON.parse(event.body || '{}');
    const text = String(body.text || '');
    
    try {
      const postRes = await pool.query('SELECT * FROM posts WHERE id = $1', [postId]);
      if (postRes.rows.length === 0) return { status: 404, body: { message: 'Not found' } };
      const post = postRes.rows[0];
      
      const comment = {
        id: crypto.randomUUID(),
        authorId: auth.user.id,
        authorName: auth.user.full_name || auth.user.username,
        authorAvatar: auth.user.avatar_url,
        text,
        createdAt: new Date().toISOString()
      };
      
      const comments = typeof post.comments === 'string' ? JSON.parse(post.comments) : (post.comments || []);
      comments.push(comment);
      await pool.query('UPDATE posts SET comments = $1 WHERE id = $2', [JSON.stringify(comments), post.id]);
      return { status: 201, body: comment };
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  // Stories
  'GET /stories': async () => {
    try {
      const result = await pool.query(`
        SELECT s.*, u.full_name as "userName", u.avatar_url as "userAvatar"
        FROM stories s LEFT JOIN users u ON s.author_id = u.id::TEXT
        WHERE s.created_at > NOW() - INTERVAL '24 hours'
      `);
      return { status: 200, body: result.rows };
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  'POST /stories': async (event) => {
    const auth = await authRequired(event);
    if (auth.error) return { status: auth.status, body: { message: auth.error } };
    
    const body = JSON.parse(event.body || '{}');
    const { data, type, image, video } = body;
    const storyData = data || image || video;
    const storyType = type || (video ? 'video' : 'image');
    if (!storyData) return { status: 400, body: { message: 'Media required' } };
    
    try {
      const result = await pool.query(
        `INSERT INTO stories (author_id, type, data, image, video) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [auth.user.id, storyType, storyData, storyType === 'image' ? storyData : null, storyType === 'video' ? storyData : null]
      );
      return { status: 201, body: result.rows[0] };
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  // Follow
  'POST /follow': async (event) => {
    const auth = await authRequired(event);
    if (auth.error) return { status: auth.status, body: { message: auth.error } };
    
    const body = JSON.parse(event.body || '{}');
    const { targetId } = body;
    if (targetId === auth.user.id) return { status: 400, body: { message: 'Cannot follow self' } };
    
    try {
      const targetRes = await pool.query('SELECT * FROM users WHERE id = $1', [targetId]);
      if (targetRes.rows.length === 0) return { status: 404, body: { message: 'Not found' } };
      
      let myFollowing = auth.user.following || [];
      const isFollowing = myFollowing.includes(targetId);
      
      if (isFollowing) {
        myFollowing = myFollowing.filter(id => id !== targetId);
        await pool.query('UPDATE users SET following = $1 WHERE id = $2', [myFollowing, auth.user.id]);
        await pool.query('UPDATE users SET followers = array_remove(COALESCE(followers, ARRAY[]::TEXT[]), $1) WHERE id = $2', [auth.user.id, targetId]);
        return { status: 200, body: { message: 'Unfollowed', following: false } };
      } else {
        myFollowing.push(targetId);
        await pool.query('UPDATE users SET following = $1 WHERE id = $2', [myFollowing, auth.user.id]);
        await pool.query('UPDATE users SET followers = array_append(COALESCE(followers, ARRAY[]::TEXT[]), $1) WHERE id = $2', [auth.user.id, targetId]);
        return { status: 200, body: { message: 'Followed', following: true } };
      }
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  // Notifications
  'GET /notifications': async (event) => {
    const auth = await authRequired(event);
    if (auth.error) return { status: auth.status, body: { message: auth.error } };
    
    try {
      const result = await pool.query(`
        SELECT n.*, u.full_name as "fromName", u.avatar_url as "fromAvatar"
        FROM notifications n LEFT JOIN users u ON n.from_id = u.id::TEXT
        WHERE n.to_id = $1 ORDER BY n.created_at DESC
      `, [auth.user.id]);
      return { status: 200, body: result.rows.map(r => ({ ...r, fromId: r.from_id, postId: r.post_id })) };
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  // Messages
  'GET /messages/:peerId': async (event) => {
    const auth = await authRequired(event);
    if (auth.error) return { status: auth.status, body: { message: auth.error } };
    
    const peerId = event.path.split('/').pop();
    try {
      const result = await pool.query(`
        SELECT *, sender_id as "fromId", receiver_id as "toId", created_at as "createdAt"
        FROM messages WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
        ORDER BY created_at ASC
      `, [auth.user.id, peerId]);
      return { status: 200, body: result.rows };
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  'GET /conversations': async (event) => {
    const auth = await authRequired(event);
    if (auth.error) return { status: auth.status, body: { message: auth.error } };
    
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
      `, [auth.user.id]);
      return { status: 200, body: result.rows };
    } catch (err) {
      return { status: 500, body: { message: 'Server error' } };
    }
  },
  
  // Live streams (mock for serverless)
  'GET /live': async () => {
    return { status: 200, body: [] };
  },
  
  'POST /live/heartbeat': async (event) => {
    const auth = await authRequired(event);
    if (auth.error) return { status: auth.status, body: { message: auth.error } };
    return { status: 200, body: { message: 'Heartbeat received' } };
  },
  
  // AI routes
  'POST /ai/monitor': async () => {
    return { status: 200, body: { insight: 'AI System monitoring is active.' } };
  },
  
  'POST /ai/suggest': async () => {
    return { status: 200, body: { choices: [{ message: { content: 'AI suggestion is ready.' } }] } };
  }
};

// Main handler
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  
  const method = event.httpMethod;
  const path = event.path.replace('/.netlify/functions/api', '').replace('/api', '');
  
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS'
  };
  
  // Handle preflight
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  
  // Find handler
  const exactKey = `${method} ${path}`;
  const dynamicKey = Object.keys(handlers).find(key => {
    if (!key.startsWith(`${method} `)) return false;
    const keyPath = key.replace(`${method} `, '');
    if (keyPath === path) return true;
    // Check for :param patterns
    const keyParts = keyPath.split('/');
    const pathParts = path.split('/');
    if (keyParts.length !== pathParts.length) return false;
    return keyParts.every((part, i) => part.startsWith(':') || part === pathParts[i]);
  });
  
  const handlerKey = handlers[exactKey] ? exactKey : dynamicKey;
  
  if (!handlerKey || !handlers[handlerKey]) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ message: 'Not found', path, method })
    };
  }
  
  try {
    const result = await handlers[handlerKey](event);
    return {
      statusCode: result.status,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(result.body)
    };
  } catch (err) {
    console.error('Handler error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'Server error', error: err.message })
    };
  }
};
