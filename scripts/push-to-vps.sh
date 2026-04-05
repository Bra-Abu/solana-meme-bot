#!/bin/bash
# ─────────────────────────────────────────────────────────────────
#  push-to-vps.sh  —  Run this from your Windows machine (Git Bash)
#  Pushes the bot to your VPS and triggers remote setup
# ─────────────────────────────────────────────────────────────────

# ── CONFIG — fill these in ────────────────────────────────────────
VPS_IP="YOUR_VPS_IP"          # e.g. 167.99.123.45
VPS_USER="root"               # usually root on fresh VPS
SSH_KEY=""                    # path to SSH key if needed, e.g. ~/.ssh/id_rsa
                              # leave empty to use password auth
# ─────────────────────────────────────────────────────────────────

set -e

BOT_DIR="/root/solana-meme-bot"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Build SSH/SCP args
SSH_ARGS="-o StrictHostKeyChecking=no"
if [ -n "$SSH_KEY" ]; then SSH_ARGS="$SSH_ARGS -i $SSH_KEY"; fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║     Solana Meme Bot — VPS Deploy     ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "→ VPS:   $VPS_USER@$VPS_IP"
echo "→ Local: $LOCAL_DIR"
echo ""

# ── Step 1: Sync bot files (exclude secrets + build artifacts) ────
echo "[1/4] Syncing files to VPS..."
rsync -az --progress \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'meme_bot.db' \
  --exclude 'logs/' \
  --exclude '.git' \
  -e "ssh $SSH_ARGS" \
  "$LOCAL_DIR/" "$VPS_USER@$VPS_IP:$BOT_DIR/"

# ── Step 2: Copy .env securely ────────────────────────────────────
echo ""
echo "[2/4] Copying .env to VPS..."
if [ -f "$LOCAL_DIR/.env" ]; then
  scp $SSH_ARGS "$LOCAL_DIR/.env" "$VPS_USER@$VPS_IP:$BOT_DIR/.env"
  echo "      .env transferred."
else
  echo "      WARNING: No .env found locally — you'll need to create it on the VPS."
fi

# ── Step 3: Run setup script on VPS ──────────────────────────────
echo ""
echo "[3/4] Running setup on VPS..."
ssh $SSH_ARGS "$VPS_USER@$VPS_IP" "chmod +x $BOT_DIR/scripts/vps-setup.sh && $BOT_DIR/scripts/vps-setup.sh"

# ── Step 4: Done ──────────────────────────────────────────────────
echo ""
echo "[4/4] Deploy complete!"
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Dashboard → http://$VPS_IP                     "
echo "║  SSH in    → ssh $VPS_USER@$VPS_IP              "
echo "║  Bot logs  → pm2 logs solana-meme-bot           "
echo "╚══════════════════════════════════════════════════╝"
echo ""
