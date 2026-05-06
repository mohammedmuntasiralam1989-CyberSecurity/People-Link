/**
 * Mock Server for People Link
 * Intercepts fetch calls to /api/ and simulates a backend using localStorage.
 */
(function() {
    const demoMode = window.location.protocol === 'file:' || new URLSearchParams(window.location.search).get('demo') === '1';
    if (!demoMode) return;

    const originalFetch = window.fetch;

    window.fetch = async function(url, options = {}) {
        if (typeof url === 'string' && url.startsWith('/api/')) {
            return simulateApi(url, options);
        }
        return originalFetch(url, options);
    };

    async function simulateApi(url, options) {
        await new Promise(resolve => setTimeout(resolve, 200));

        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;

        const getData = () => {
            const users = JSON.parse(localStorage.getItem('peoplelink_users') || '[]');
            const posts = JSON.parse(localStorage.getItem('peoplelink_posts') || '[]');
            const messages = JSON.parse(localStorage.getItem('peoplelink_messages') || '[]');
            const notifications = JSON.parse(localStorage.getItem('peoplelink_notifications') || '[]');
            const stories = JSON.parse(localStorage.getItem('peoplelink_stories') || '[]');
            return { users, posts, messages, notifications, stories };
        };

        const saveData = (data) => {
            if (data.users) localStorage.setItem('peoplelink_users', JSON.stringify(data.users));
            if (data.posts) localStorage.setItem('peoplelink_posts', JSON.stringify(data.posts));
            if (data.messages) localStorage.setItem('peoplelink_messages', JSON.stringify(data.messages));
            if (data.notifications) localStorage.setItem('peoplelink_notifications', JSON.stringify(data.notifications));
            if (data.stories) localStorage.setItem('peoplelink_stories', JSON.stringify(data.stories));
        };

        const db = getData();

        // ── Auth ──
        if (url === '/api/signup' && method === 'POST') {
            const exists = db.users.find(u => u.email === body.email || u.username === body.username);
            if (exists) return mockResponse({ message: 'User already exists' }, 400);
            const newUser = { ...body, id: Date.now().toString(), following: [], followers: [] };
            db.users.push(newUser);
            saveData(db);
            const { password, ...safeUser } = newUser;
            return mockResponse({ message: 'User created', user: safeUser, token: makeDemoToken(newUser) }, 201);
        }

        if (url === '/api/login' && method === 'POST') {
            const user = db.users.find(u =>
                (u.email === body.identifier || u.username === body.identifier) && u.password === body.password
            );
            if (!user) return mockResponse({ message: 'Invalid credentials' }, 401);
            const { password, ...safeUser } = user;
            return mockResponse({ message: 'Login successful', user: safeUser, token: makeDemoToken(user) }, 200);
        }

        if (url === '/api/me' && method === 'GET') {
            const user = getCurrentDemoUser(db.users);
            if (!user) return mockResponse({ message: 'Authentication required' }, 401);
            const { password, ...safeUser } = user;
            return mockResponse({ user: safeUser }, 200);
        }

        if (url === '/api/me' && method === 'PATCH') {
            const user = getCurrentDemoUser(db.users);
            if (!user) return mockResponse({ message: 'Authentication required' }, 401);
            const duplicate = db.users.find((entry) => {
                if (entry.id === user.id) return false;
                return String(entry.email || '').toLowerCase() === String(body.email || '').toLowerCase()
                    || String(entry.username || '').toLowerCase() === String(body.username || '').toLowerCase();
            });
            if (duplicate) return mockResponse({ message: 'Email or username is already in use' }, 400);
            Object.assign(user, { fullName: body.fullName, email: body.email, username: body.username, bio: body.bio || '', avatarUrl: body.avatarUrl || null });
            saveData(db);
            const { password, ...safeUser } = user;
            localStorage.setItem('peoplelink_currentUser', JSON.stringify(safeUser));
            return mockResponse({ message: 'Profile updated', user: safeUser }, 200);
        }

        if (url === '/api/change-password' && method === 'POST') {
            const user = getCurrentDemoUser(db.users);
            if (!user) return mockResponse({ message: 'Authentication required' }, 401);
            if (user.password !== body.currentPassword) return mockResponse({ message: 'Current password is incorrect' }, 400);
            user.password = body.newPassword;
            saveData(db);
            return mockResponse({ message: 'Password updated' }, 200);
        }

        // ── Users ──
        if (url === '/api/users' && method === 'GET') {
            return mockResponse(db.users.map(({ password, ...s }) => s), 200);
        }

        if (url.startsWith('/api/users/search') && method === 'GET') {
            const q = new URL(url, 'http://localhost').searchParams.get('q') || '';
            const ql = q.toLowerCase();
            const results = db.users.filter(u => (u.fullName || '').toLowerCase().includes(ql) || (u.username || '').toLowerCase().includes(ql)).map(({ password, ...s }) => s).slice(0, 20);
            return mockResponse(results, 200);
        }

        const userMatch = url.match(/^\/api\/users\/([^/]+)$/);
        if (userMatch && method === 'GET') {
            const uid = userMatch[1];
            const user = db.users.find(u => u.id === uid || u.username === uid);
            if (!user) return mockResponse({ message: 'User not found' }, 404);
            const { password, ...safeUser } = user;
            return mockResponse(safeUser, 200);
        }

        // ── Posts ──
        if (url === '/api/posts' && method === 'GET') {
            return mockResponse(db.posts.slice().reverse(), 200);
        }

        if (url === '/api/posts' && method === 'POST') {
            const user = getCurrentDemoUser(db.users) || JSON.parse(localStorage.getItem('peoplelink_currentUser') || 'null');
            if (!user) return mockResponse({ message: 'Authentication required' }, 401);
            const newPost = {
                ...body,
                id: Date.now().toString(),
                authorId: user.id || body.authorId,
                authorName: user.fullName || user.username || body.authorName,
                authorAvatar: user.avatarUrl || body.authorAvatar || null,
                likes: 0,
                likedBy: [],
                comments: [],
                createdAt: new Date().toISOString()
            };
            db.posts.push(newPost);
            saveData(db);
            return mockResponse(newPost, 201);
        }

        // ── Like ──
        const likeMatch = url.match(/^\/api\/posts\/([^/]+)\/like$/);
        if (likeMatch && method === 'POST') {
            const post = db.posts.find(p => p.id === likeMatch[1]);
            if (!post) return mockResponse({ message: 'Post not found' }, 404);
            const cu = getCurrentDemoUser(db.users);
            if (!cu) return mockResponse({ message: 'Auth required' }, 401);
            post.likedBy = post.likedBy || [];
            const idx = post.likedBy.indexOf(cu.id);
            if (idx === -1) { post.likedBy.push(cu.id); } else { post.likedBy.splice(idx, 1); }
            post.likes = post.likedBy.length;
            const isLiked = post.likedBy.includes(cu.id);
            saveData(db);
            return mockResponse({ likes: post.likes, liked: isLiked, likedByMe: isLiked }, 200);
        }

        // ── Comments ──
        const commentMatch = url.match(/^\/api\/posts\/([^/]+)\/comments$/);
        if (commentMatch && method === 'POST') {
            const post = db.posts.find(p => p.id === commentMatch[1]);
            if (!post) return mockResponse({ message: 'Post not found' }, 404);
            const cu = getCurrentDemoUser(db.users);
            if (!cu) return mockResponse({ message: 'Auth required' }, 401);
            const comment = { id: Date.now().toString(), authorId: cu.id, authorName: cu.fullName || cu.username, authorAvatar: cu.avatarUrl || null, text: body.text, createdAt: new Date().toISOString() };
            post.comments = post.comments || [];
            post.comments.push(comment);
            saveData(db);
            return mockResponse(comment, 201);
        }

        // ── Follow ──
        if (url === '/api/follow' && method === 'POST') {
            const cu = getCurrentDemoUser(db.users);
            if (!cu) return mockResponse({ message: 'Auth required' }, 401);
            const target = db.users.find(u => u.id === body.targetId);
            if (!target) return mockResponse({ message: 'User not found' }, 404);
            cu.following = cu.following || [];
            target.followers = target.followers || [];
            if (cu.following.includes(body.targetId)) {
                cu.following = cu.following.filter(id => id !== body.targetId);
                target.followers = target.followers.filter(id => id !== cu.id);
                saveData(db);
                return mockResponse({ message: 'Unfollowed', following: false }, 200);
            }
            cu.following.push(body.targetId);
            target.followers.push(cu.id);
            db.notifications.push({ id: Date.now().toString(), type: 'follow', fromId: cu.id, fromName: cu.fullName || cu.username, fromAvatar: cu.avatarUrl, toId: body.targetId, read: false, createdAt: new Date().toISOString() });
            saveData(db);
            return mockResponse({ message: 'Followed', following: true }, 200);
        }

        // ── Notifications ──
        if (url === '/api/notifications' && method === 'GET') {
            const cu = getCurrentDemoUser(db.users);
            if (!cu) return mockResponse({ message: 'Auth required' }, 401);
            const notifs = db.notifications.filter(n => n.toId === cu.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            return mockResponse(notifs, 200);
        }

        if (url === '/api/notifications/read' && method === 'PATCH') {
            const cu = getCurrentDemoUser(db.users);
            if (!cu) return mockResponse({ message: 'Auth required' }, 401);
            db.notifications.forEach(n => { if (n.toId === cu.id) n.read = true; });
            saveData(db);
            return mockResponse({ message: 'Marked as read' }, 200);
        }

        // ── Messages ──
        if (url === '/api/conversations' && method === 'GET') {
            const cu = getCurrentDemoUser(db.users);
            if (!cu) return mockResponse({ message: 'Auth required' }, 401);
            const convMap = {};
            db.messages.forEach(m => {
                if (m.fromId !== cu.id && m.toId !== cu.id) return;
                const peerId = m.fromId === cu.id ? m.toId : m.fromId;
                if (!convMap[peerId] || new Date(m.createdAt) > new Date(convMap[peerId].createdAt)) convMap[peerId] = m;
            });
            const convs = Object.entries(convMap).map(([peerId, lastMsg]) => {
                const peer = db.users.find(u => u.id === peerId);
                return { peerId, peerName: peer ? (peer.fullName || peer.username) : 'Unknown', peerAvatar: peer ? peer.avatarUrl : null, lastMessage: lastMsg.text, lastTime: lastMsg.createdAt };
            }).sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
            return mockResponse(convs, 200);
        }

        const msgMatch = url.match(/^\/api\/messages\/([^/]+)$/);
        if (msgMatch && method === 'GET') {
            const cu = getCurrentDemoUser(db.users);
            if (!cu) return mockResponse({ message: 'Auth required' }, 401);
            const peerId = msgMatch[1];
            const msgs = db.messages.filter(m => (m.fromId === cu.id && m.toId === peerId) || (m.fromId === peerId && m.toId === cu.id)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            return mockResponse(msgs, 200);
        }

        if (url === '/api/messages' && method === 'POST') {
            const cu = getCurrentDemoUser(db.users);
            if (!cu) return mockResponse({ message: 'Auth required' }, 401);
            const msg = { id: Date.now().toString(), fromId: cu.id, fromName: cu.fullName || cu.username, fromAvatar: cu.avatarUrl, toId: body.toId, text: body.text, createdAt: new Date().toISOString() };
            db.messages.push(msg);
            db.notifications.push({ id: (Date.now() + 1).toString(), type: 'message', fromId: cu.id, fromName: cu.fullName || cu.username, fromAvatar: cu.avatarUrl, toId: body.toId, preview: body.text.slice(0, 60), read: false, createdAt: new Date().toISOString() });
            saveData(db);
            return mockResponse(msg, 201);
        }

        // ── Reels ──
        if (url === '/api/reels' && method === 'GET') {
            return mockResponse(db.posts.filter(p => p.video).reverse(), 200);
        }

        // ── Stories ──
        if (url === '/api/stories' && method === 'GET') {
            const dayMs = 24 * 60 * 60 * 1000;
            const fresh = db.stories.filter(s => Date.now() - new Date(s.createdAt).getTime() < dayMs);
            return mockResponse(fresh, 200);
        }

        if (url === '/api/stories' && method === 'POST') {
            const cu = getCurrentDemoUser(db.users);
            if (!cu) return mockResponse({ message: 'Auth required' }, 401);
            const storyData = body.data || body.image || body.video;
            const storyType = body.type || (body.video ? 'video' : 'image');
            if (!storyData) return mockResponse({ message: 'Story media required' }, 400);
            const story = {
                id: Date.now().toString(),
                authorId: cu.id, authorName: cu.fullName || cu.username, authorAvatar: cu.avatarUrl,
                userName: cu.fullName || cu.username, userAvatar: cu.avatarUrl,
                type: storyType, data: storyData,
                image: storyType === 'image' ? storyData : null,
                video: storyType === 'video' ? storyData : null,
                createdAt: new Date().toISOString()
            };
            db.stories.push(story);
            saveData(db);
            return mockResponse(story, 201);
        }

        // ── AI ──
        if (url === '/api/ai/suggest' && method === 'POST') {
            return mockResponse({ choices: [{ message: { content: "Demo AI: write a short, confident update and add one clear call to conversation." } }] }, 200);
        }

        if ((url === '/api/ai/monitor') && (method === 'POST' || method === 'GET')) {
            return mockResponse({ insight: "Demo monitoring active. Run the Node server with GEMINI_API_KEY for live AI insights." }, 200);
        }

        return mockResponse({ message: 'Not Found' }, 404);
    }

    function mockResponse(data, status) {
        return { ok: status >= 200 && status < 300, status, json: async () => data };
    }

    function makeDemoToken(user) {
        return btoa(JSON.stringify({ sub: user.id, demo: true, exp: Date.now() + 604800000 }));
    }

    function getCurrentDemoUser(users) {
        try {
            const current = JSON.parse(localStorage.getItem('peoplelink_currentUser') || 'null');
            if (!current) return null;
            return users.find(u => u.id === current.id || u.email === current.email || u.username === current.username) || null;
        } catch (_err) {
            return null;
        }
    }
})();
