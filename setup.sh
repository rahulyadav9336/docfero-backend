#!/bin/bash
# ═══════════════════════════════════════════
# DOCFERO BACKEND — Hostinger VPS Setup Script
# Run as root: sudo bash setup.sh
# ═══════════════════════════════════════════

set -e

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   DOCFERO BACKEND — VPS SETUP       ║"
echo "║   Hostinger Ubuntu VPS              ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err() { echo -e "${RED}[✗]${NC} $1"; }

# ── Step 1: Update System ──
echo "━━━ Step 1/7: Updating system ━━━"
apt update -y && apt upgrade -y
log "System updated"

# ── Step 2: Install Node.js 20 LTS ──
echo ""
echo "━━━ Step 2/7: Installing Node.js 20 ━━━"
if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    warn "Node.js already installed: $NODE_VER"
else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
    log "Node.js $(node -v) installed"
fi
log "npm $(npm -v)"

# ── Step 3: Install LibreOffice Headless ──
echo ""
echo "━━━ Step 3/7: Installing LibreOffice headless ━━━"
if command -v soffice &>/dev/null; then
    warn "LibreOffice already installed"
else
    apt install -y libreoffice-core libreoffice-writer libreoffice-impress libreoffice-calc --no-install-recommends
    log "LibreOffice installed"
fi
soffice --version

# ── Step 4: Install qpdf (for PDF unlock) ──
echo ""
echo "━━━ Step 4/7: Installing qpdf ━━━"
if command -v qpdf &>/dev/null; then
    warn "qpdf already installed"
else
    apt install -y qpdf
    log "qpdf installed"
fi
qpdf --version

# ── Step 5: Install PM2 ──
echo ""
echo "━━━ Step 5/7: Installing PM2 ━━━"
if command -v pm2 &>/dev/null; then
    warn "PM2 already installed"
else
    npm install -g pm2
    log "PM2 installed"
fi

# ── Step 6: Install Nginx (if not present) ──
echo ""
echo "━━━ Step 6/7: Checking Nginx ━━━"
if command -v nginx &>/dev/null; then
    warn "Nginx already installed"
else
    apt install -y nginx
    systemctl enable nginx
    systemctl start nginx
    log "Nginx installed and started"
fi

# ── Step 7: Setup directories and permissions ──
echo ""
echo "━━━ Step 7/7: Setting up directories ━━━"

# Create log directory
mkdir -p /var/log/docfero
chown -R $SUDO_USER:$SUDO_USER /var/log/docfero 2>/dev/null || true

# Create frontend directory
mkdir -p /var/www/docfero
chown -R $SUDO_USER:$SUDO_USER /var/www/docfero 2>/dev/null || true

# Create temp directories
mkdir -p /tmp/docfero-uploads /tmp/docfero-outputs
chmod 777 /tmp/docfero-uploads /tmp/docfero-outputs

log "Directories created"

# ── Done ──
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅ SETUP COMPLETE!                                 ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║                                                      ║"
echo "║  Next steps:                                         ║"
echo "║                                                      ║"
echo "║  1. Upload your backend code:                        ║"
echo "║     scp -r docfero-backend/ user@your-vps:~/         ║"
echo "║                                                      ║"
echo "║  2. Install dependencies:                            ║"
echo "║     cd ~/docfero-backend && npm install              ║"
echo "║                                                      ║"
echo "║  3. Edit .env with your domain:                      ║"
echo "║     nano .env                                        ║"
echo "║                                                      ║"
echo "║  4. Start with PM2:                                  ║"
echo "║     pm2 start ecosystem.config.js                    ║"
echo "║     pm2 save                                         ║"
echo "║     pm2 startup                                      ║"
echo "║                                                      ║"
echo "║  5. Setup Nginx:                                     ║"
echo "║     sudo cp docfero.conf /etc/nginx/sites-available/ ║"
echo "║     sudo ln -s /etc/nginx/sites-available/docfero.conf /etc/nginx/sites-enabled/"
echo "║     sudo nginx -t && sudo systemctl reload nginx     ║"
echo "║                                                      ║"
echo "║  6. Setup SSL (free):                                ║"
echo "║     sudo apt install certbot python3-certbot-nginx   ║"
echo "║     sudo certbot --nginx -d docfero.com              ║"
echo "║                                                      ║"
echo "║  7. Upload frontend:                                 ║"
echo "║     scp -r docfero/* user@your-vps:/var/www/docfero/ ║"
echo "║                                                      ║"
echo "║  8. Test:                                            ║"
echo "║     curl http://localhost:4000/api/health            ║"
echo "║                                                      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
