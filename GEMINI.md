# 🌌 People Link - Project Context & Instructions

Welcome to **People Link**, a premium, futuristic social media platform designed for meaningful human connection with a focus on privacy, aesthetics, and high-end interactivity.

## 🚀 Project Vision
People Link is not just another social network; it is a "People-First" ecosystem. It combines cutting-edge **Glassmorphism** design with **AI-driven insights** to create a digital space that feels alive, transparent, and respectful of user time.

---

## 🛠️ Technology Stack
- **Frontend**: Vanilla HTML5, CSS3 (Custom Design System), and JavaScript (ES6+).
- **Styling**: 
  - `style.css`: The core design system (Glassmorphism, futuristic dark mode).
  - `creative.css`: Specialized artistic scrolling layouts and portfolio styles.
- **Backend**: Node.js with Express.
- **Database**: `db.json` (for local development/mock server) and LocalStorage for client-side persistence.
- **Icons & Fonts**: FontAwesome, Ionicons, Google Fonts (`Inter`, `Dancing Script`, `Righteous`).

---

## 🎨 Design System Principles (MANDATORY)
1. **Glassmorphism**: Use `backdrop-filter: blur(15px)`, thin semi-transparent borders (`rgba(255,255,255,0.1)`), and subtle shadows.
2. **Futuristic Aesthetics**: Deep blacks (`#0a0a0a`), vibrant accents (Subtle Blue, Deep Purple, and "Explore" Orange `#dc6e25`), and smooth gradients.
3. **Typography**: 
   - `Inter`: Primary UI text.
   - `Righteous`: Bold, futuristic headlines.
   - `Dancing Script`: Elegant, handwritten artistic touches.
4. **Micro-animations**: Everything should feel fluid. Use `cubic-bezier(0.4, 0, 0.2, 1)` for transitions.

---

## 📂 Key Architecture
- `index.html`: Modern landing page.
- `feed.html`: The core interaction hub (Post, Stories, Real-time Analytics Chart).
- `explore.html`: High-end artistic showcase page.
- `reels.html`: Immersive vertical video feed.
- `global-3d.html`: 3D visualization of the network.
- `ai-monitor.js`: Handles real-time sentiment analysis and platform insights.

---

## 🤖 Instructions for AI Assistants
When working on People Link, follow these rules:

1. **Prioritize Visual Excellence**: Never create "simple" UI. Every element must look premium and professional.
2. **Stay Consistent**: Always refer to `style.css` for the design system tokens (colors, spacing, glass effects).
3. **Agentic Troubleshooting**: If a feature fails (e.g., a fetch error), look for the root cause in `server.js` or `db.json` before asking for help.
4. **Interactive Features**: Always suggest or implement interactive elements (hover effects, animations, real-time updates) to keep the "alive" feel.
5. **No Placeholders**: Use `generate_image` for real artistic assets instead of generic placeholder URLs.

---

## 🚀 CI/CD & GitHub Actions
People Link is equipped with high-end automation to ensure code quality and seamless deployments.

### 1. Main CI/CD Workflow (`main.yml`)
- **Validation**: Automatically runs `npm install` and basic syntax checks on every push.
- **Security**: Conducts high-level security audits on dependencies.
- **Deployment**: Configured with templates for **InsForge** and **Netlify**.

### 2. AI Code Review (`ai-review.yml`)
- Provides AI-driven insights on Pull Requests (requires `GEMINI_API_KEY` in GitHub Secrets).

### ⚙️ Required GitHub Secrets
To fully enable these features, add the following to your repository settings (`Settings > Secrets and variables > Actions`):
- `GEMINI_API_KEY`: Your Google Gemini API key for AI monitoring and reviews.
- `INSFORGE_API_KEY`: (Optional) Your InsForge token for automated deployments.
- `DATABASE_URL`: (Optional) For running integration tests in the cloud.

---

## 📈 Future Roadmap
- [ ] Integration of fully decentralized identity.
- [ ] Advanced 3D VR/AR environment for "Global 3D".
- [ ] Deeper AI integration for personalized discovery without algorithmic bubbles.

---
*Created by the People Link Development Team in collaboration with Antigravity AI.*
