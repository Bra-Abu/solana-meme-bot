#!/bin/bash
# ─────────────────────────────────────────────────────────────────
#  vps-setup.sh  —  Runs ON the VPS (Ubuntu 20.04 / 22.04)
#  Installs everything and starts the bot + dashboard
# ─────────────────────────────────────────────────────────────────

set -e
BOT_DIR="/root/solana-meme-bot"
cd "$BOT_DIR"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║       VPS Setup — Meme Bot           ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. System update ──────────────────────────────────────────────
echo "[1/7] Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

# ── 2. Install Node.js 20 ─────────────────────────────────────────
if ! command -v node &>/dev/null || [[ $(node -v) != v20* ]]; then
  echo "[2/7] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null
  apt-get install -y nodejs -qq
else
  echo "[2/7] Node.js $(node -v) already installed."
fi

# ── 3. Install PM2 ───────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  echo "[3/7] Installing PM2..."
  npm install -g pm2 --quiet
else
  echo "[3/7] PM2 already installed."
fi

# ── 4. Install dependencies ───────────────────────────────────────
echo "[4/7] Installing npm dependencies..."
npm install --production --quiet

# ── 5. Install + configure nginx ──────────────────────────────────
echo "[5/7] Setting up nginx..."
apt-get install -y nginx -qq

cat > /etc/nginx/sites-available/meme-bot << 'EOF'
server {
    listen 80 default_server;
    server_name _;

    # Dashboard
    location / {
        proxy_pass         http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }
}
EOF

ln -sf /etc/nginx/sites-available/meme-bot /etc/nginx/sites-enabled/meme-bot
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
systemctl enable nginx

# ── 6. Start bot + dashboard with PM2 ────────────────────────────
echo "[6/7] Starting bot and dashboard with PM2..."

pm2 stop solana-meme-bot    2>/dev/null || true
pm2 stop meme-bot-dashboard 2>/dev/null || true
pm2 delete solana-meme-bot    2>/dev/null || true
pm2 delete meme-bot-dashboard 2>/dev/null || true

pm2 start ecosystem.config.js
pm2 save

# Auto-start PM2 on server reboot
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

# ── 7. Firewall ───────────────────────────────────────────────────
echo "[7/7] Configuring firewall..."
if command -v ufw &>/dev/null; then
  ufw allow OpenSSH   > /dev/null
  ufw allow 'Nginx Full' > /dev/null
  ufw --force enable  > /dev/null
fi

# ── Done ──────────────────────────────────────────────────────────
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_VPS_IP")

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅  Setup complete!                                 ║"
echo "║                                                      ║"
echo "║  Dashboard  →  http://$PUBLIC_IP                    "
echo "║  Bot logs   →  pm2 logs solana-meme-bot             "
echo "║  All logs   →  pm2 logs                             "
echo "║  Status     →  pm2 status                           "
echo "╚══════════════════════════════════════════════════════╝"
echo ""
pm2 status
