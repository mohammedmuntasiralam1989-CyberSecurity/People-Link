/**
 * People Link - Universal AI System Monitor
 * This script provides automated AI-powered monitoring across all pages.
 */

(function() {
    let countdown = 60;
    let countdownTimer = null;

    // Create UI Elements for the Monitor
    function createMonitorUI() {
        if (document.getElementById('universal-ai-monitor')) return;

        const monitorContainer = document.createElement('div');
        monitorContainer.id = 'universal-ai-monitor';
        monitorContainer.style.cssText = `
            position: fixed;
            bottom: 100px;
            right: 20px;
            width: 280px;
            background: rgba(15, 15, 15, 0.95);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 20px;
            padding: 15px;
            color: #fff;
            font-family: 'Inter', sans-serif;
            z-index: 10000;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            transition: 0.3s transform;
            display: none;
        `;

        monitorContainer.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
                <h4 style="margin:0; font-size:0.8rem; letter-spacing:1px; color:#6366f1;">LIVE AI MONITOR</h4>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span id="growth-pct" style="font-size:0.7rem; color:#10b981; font-weight:bold;">+0%</span>
                    <div id="monitor-pulse" style="width:8px; height:8px; background:#10b981; border-radius:50%; box-shadow:0 0 8px #10b981;"></div>
                </div>
            </div>
            
            <div style="height:30px; margin-bottom:10px; display:flex; align-items:flex-end; gap:2px;" id="sparkline-container">
                <!-- Sparkline bars will be injected here -->
            </div>

            <div id="monitor-insight" style="font-size:0.75rem; color:#ccc; line-height:1.4; font-style:italic; border-left:2px solid #6366f1; padding-left:10px; min-height:40px; margin-bottom:10px;">
                Analyzing platform trends...
            </div>

            <div style="margin-top:12px; font-size:0.65rem; color:#888; display:flex; justify-content:space-between; border-top: 1px solid rgba(255,255,255,0.05); padding-top:8px;">
                <span id="monitor-timer">Next update: 60s</span>
                <span id="monitor-last-update">--:--</span>
            </div>
        `;

        const toggleBtn = document.createElement('div');
        toggleBtn.id = 'monitor-toggle';
        toggleBtn.style.cssText = `
            position: fixed;
            bottom: 40px;
            right: 20px;
            width: 50px;
            height: 50px;
            background: linear-gradient(135deg, #6366f1, #a855f7);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 10001;
            box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
            font-size: 24px;
            transition: 0.3s;
        `;
        toggleBtn.innerHTML = '✨';
        toggleBtn.onmouseover = () => toggleBtn.style.transform = 'scale(1.1)';
        toggleBtn.onmouseout = () => toggleBtn.style.transform = 'scale(1)';

        document.body.appendChild(monitorContainer);
        document.body.appendChild(toggleBtn);

        toggleBtn.onclick = () => {
            const isVisible = monitorContainer.style.display === 'block';
            monitorContainer.style.display = isVisible ? 'none' : 'block';
        };
    }

    let activityHistory = [10, 15, 8, 12, 20, 15, 18];

    function updateSparkline(newVal) {
        const container = document.getElementById('sparkline-container');
        if (!container) return;
        
        activityHistory.push(newVal);
        if (activityHistory.length > 15) activityHistory.shift();
        
        const max = Math.max(...activityHistory, 1);
        container.innerHTML = activityHistory.map(v => {
            const h = (v / max) * 100;
            return `<div style="flex:1; background:linear-gradient(to top, #6366f1, #a855f7); height:${h}%; border-radius:2px; opacity:0.6;"></div>`;
        }).join('');

        // Update percentage
        const pctEl = document.getElementById('growth-pct');
        if (pctEl && activityHistory.length > 1) {
            const prev = activityHistory[activityHistory.length - 2];
            const diff = ((newVal - prev) / (prev || 1)) * 100;
            pctEl.textContent = (diff >= 0 ? '+' : '') + diff.toFixed(1) + '%';
            pctEl.style.color = diff >= 0 ? '#10b981' : '#ef4444';
        }
    }

    async function runUniversalMonitor() {
        const insightEl = document.getElementById('monitor-insight');
        const pulseEl = document.getElementById('monitor-pulse');
        const timeEl = document.getElementById('monitor-last-update');

        if (!insightEl) return;

        try {
            pulseEl.style.background = '#f59e0b';
            insightEl.textContent = "AI is generating live trend report... 📊";
            
            const users = JSON.parse(localStorage.getItem('peoplelink_users') || '[]');
            const postsRes = await fetch('/api/posts').catch(() => null);
            const posts = postsRes ? await postsRes.json() : [];

            // Update sparkline with post count
            updateSparkline(posts.length);

            const response = await fetch('/api/ai/monitor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    stats: {
                        page: window.location.pathname,
                        totalUsers: users.length,
                        totalPosts: posts.length,
                        trend: activityHistory.slice(-5),
                        timestamp: new Date().toISOString()
                    }
                })
            });

            if (!response.ok) throw new Error("Fetch failed");

            const data = await response.json();
            insightEl.textContent = data.insight || "System stable. Monitoring active.";
            timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            pulseEl.style.background = '#10b981';
            
            countdown = 60;
        } catch (err) {
            console.error("AI Monitor Error:", err);
            insightEl.textContent = "Live sync active. Analyzing platform metrics...";
            pulseEl.style.background = '#ef4444';
        }
    }

    function startCountdown() {
        const timerEl = document.getElementById('monitor-timer');
        if (countdownTimer) clearInterval(countdownTimer);
        
        countdownTimer = setInterval(() => {
            if (countdown > 0) {
                countdown--;
                if (timerEl) timerEl.textContent = `Next update: ${countdown}s`;
            } else {
                runUniversalMonitor();
            }
        }, 1000);
    }

    // Initialize
    window.addEventListener('load', () => {
        createMonitorUI();
        
        // Add manual refresh button
        const monitorContainer = document.getElementById('universal-ai-monitor');
        if (monitorContainer) {
            const refreshBtn = document.createElement('button');
            refreshBtn.textContent = "Analyze Now";
            refreshBtn.style.cssText = `
                width: 100%;
                margin-top: 10px;
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.1);
                color: #aaa;
                border-radius: 10px;
                padding: 5px;
                font-size: 0.65rem;
                cursor: pointer;
                transition: 0.3s;
            `;
            refreshBtn.onclick = runUniversalMonitor;
            monitorContainer.appendChild(refreshBtn);
        }

        runUniversalMonitor();
        startCountdown();
    });
})();
