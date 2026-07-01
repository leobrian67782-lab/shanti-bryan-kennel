require('dotenv').config();

// ── Fail fast if critical env vars are missing ────────────────────────────
if (!process.env.MONGODB_URI)    throw new Error('MONGODB_URI is missing.');
if (!process.env.JWT_SECRET)     throw new Error('JWT_SECRET is missing.');
if (!process.env.ADMIN_USERNAME) throw new Error('ADMIN_USERNAME is missing.');
if (!process.env.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD is missing.');

const express       = require('express');
const helmet        = require('helmet');
const cors          = require('cors');
const compression   = require('compression');
const rateLimit     = require('express-rate-limit');
const cookieParser  = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const { xss }       = require('express-xss-sanitizer');
const path          = require('path');
const https         = require('https');

const connectDB      = require('./config/db');
const Admin          = require('./models/Admin');
const errorHandler   = require('./middleware/errorHandler');

connectDB();

async function seedAdmin() {
  try {
    const count = await Admin.countDocuments();
    if (count === 0) {
      await Admin.create({
        username: process.env.ADMIN_USERNAME,
        password: process.env.ADMIN_PASSWORD,
        role:     'superadmin',
      });
      console.log('✅ Admin seeded from environment variables.');
    }
  } catch (e) {
    console.error('Seed error:', e.message);
  }
}
seedAdmin();

const app = express();

app.set('trust proxy', 1);

app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

const allowedOrigins = [
  process.env.SITE_ORIGIN,
  process.env.SITE_URL,
  'https://zipcargologistics.com',
  'https://www.zipcargologistics.com',
  'https://zipcargo-app.onrender.com', // kept as a safety-net fallback during domain transition
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

app.use('/api/', rateLimit({
  windowMs: 60_000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
}));

app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60_000, max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
}));

app.use('/api/shipments/track', rateLimit({
  windowMs: 15 * 60_000, max: 30,
  message: { error: 'Too many tracking requests. Try again later.' },
}));

app.use(compression());
app.use((req, res, next) => {
  // Skip the global small-body parser for the reviews route — it has its
  // own larger parser below to allow optional base64 photo uploads.
  if (req.path === '/api/reviews' || req.path.startsWith('/api/reviews/')) return next();
  express.json({ limit: '100kb' })(req, res, next);
});
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(cookieParser());
app.use(mongoSanitize());
app.use(xss());

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/shipments', require('./public/shipments'));
app.use('/api/inquiries', require('./routes/inquiries'));
app.use('/api/activity',  require('./routes/activity'));
app.use('/api/ai-settings', require('./routes/ai-settings'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/contact-settings', require('./routes/contact-settings'));
// Reviews route gets its own larger body limit (for optional base64 photo
// uploads) — applied only here, not globally, to keep the rest of the API
// protected against oversized payloads.
app.use('/api/reviews', express.json({ limit: '3mb' }), require('./routes/reviews'));

app.get('/health', (_, res) => res.send('OK'));

// ── Sitemap & Robots ──────────────────────────────────────────────────────
app.get('/favicon.svg', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'favicon.svg')));
app.get('/manifest.json', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'manifest.json')));
app.get('/sitemap.xml', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});
app.get('/robots.txt', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

// ── Shipment status update email ──────────────────────────────────────────
app.post('/api/email/status-update', async (req, res) => {
  try {
    const { shipment, settings } = req.body;
    if (!shipment || !shipment.rEmail) {
      return res.status(400).json({ error: 'Missing data.' });
    }

    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) return res.json({ error: 'Email not configured.' });

    const siteEmail = (settings && settings.email) || process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com';

    const statusEmoji = {
      'Pending':          '⏳',
      'In Transit':       '✈️',
      'Out for Delivery': '🚚',
      'Delivered':        '✅',
      'On Hold':          '⚠️',
    }[shipment.status] || '📦';

    const statusMessages = {
      'Pending':          'Your shipment has been received and is being prepared.',
      'In Transit':       'Great news! Your shipment is now on its way.',
      'Out for Delivery': 'Your shipment is out for delivery today!',
      'Delivered':        'Your shipment has been delivered successfully. Thank you for choosing ZipCargo!',
      'On Hold':          'Your shipment is currently on hold. Please contact us for more information.',
    };

    const statusMsg = statusMessages[shipment.status] || 'Your shipment status has been updated.';

    const emailHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light only"/>
<meta name="supported-color-schemes" content="light only"/>
<meta name="x-apple-disable-message-reformatting"/>
<style>
body{margin:0;padding:0;background:#f3f4f6;font-family:Helvetica,Arial,sans-serif;}
</style>
</head>
<body class="body" bgcolor="#f3f4f6" style="margin:0;padding:20px;background:#f3f4f6;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">

  <!-- Header -->
  <div class="zc-header" bgcolor="#0d1f35" style="background:#0d1f35;padding:24px 28px;">
    <img src="https://zipcargologistics.com/logo-light-email.png" alt="ZipCargo" style="height:64px;display:block;"/>
    <div style="color:#aac4e0;font-size:12px;font-family:Helvetica,Arial,sans-serif;margin-top:8px;">Shipment Status Update</div>
  </div>

  <!-- Body -->
  <div style="padding:28px;background:#ffffff;">
    <p style="color:#0d1f35;font-size:15px;font-family:Helvetica,Arial,sans-serif;">Dear <strong>${shipment.rName}</strong>,</p>

    <!-- Status Banner -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">
      <tr>
        <td bgcolor="#f0f7ff" style="background:#f0f7ff;border-left:4px solid #e8820c;border-radius:0 8px 8px 0;padding:16px 20px;">
          <div style="font-size:22px;margin-bottom:6px;">${statusEmoji}</div>
          <div style="color:#0d1f35;font-size:16px;font-weight:800;font-family:Helvetica,Arial,sans-serif;">${shipment.status}</div>
          <div style="color:#64748b;font-size:13px;margin-top:4px;font-family:Helvetica,Arial,sans-serif;">${statusMsg}</div>
        </td>
      </tr>
    </table>

    <!-- Tracking Number -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">
      <tr>
        <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;text-align:center;">
          <div style="color:#64748b;font-size:10px;font-weight:700;letter-spacing:1px;font-family:Helvetica,Arial,sans-serif;">TRACKING NUMBER</div>
          <div style="color:#e8820c;font-size:20px;font-weight:800;margin-top:4px;font-family:Helvetica,Arial,sans-serif;">${shipment.tracking}</div>
        </td>
      </tr>
    </table>

    <!-- Details -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;font-size:13px;font-family:Helvetica,Arial,sans-serif;">
      ${shipment.location ? `<tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:8px 0;color:#64748b;">Current Location</td><td style="padding:8px 0;color:#0d1f35;font-weight:700;">${shipment.location}</td></tr>` : ''}
      <tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:8px 0;color:#64748b;">From</td><td style="padding:8px 0;color:#0d1f35;font-weight:700;">${shipment.origin}</td></tr>
      <tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:8px 0;color:#64748b;">To</td><td style="padding:8px 0;color:#0d1f35;font-weight:700;">${shipment.dest}</td></tr>
      <tr><td style="padding:8px 0;color:#64748b;">Est. Delivery</td><td style="padding:8px 0;color:#0d1f35;font-weight:700;">${shipment.eta || 'TBD'}</td></tr>
    </table>

    <!-- Track Button -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      <tr>
        <td align="center">
          <a href="https://zipcargologistics.com/tracking.html?id=${shipment.tracking}"
             style="background:#e8820c;color:#ffffff;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;font-family:Helvetica,Arial,sans-serif;">
            Track Your Shipment &#8594;
          </a>
        </td>
      </tr>
    </table>

    <p style="color:#1e293b;font-size:13px;line-height:1.7;font-family:Helvetica,Arial,sans-serif;">
      Please reply to this email with any questions or concerns.<br/>
      Thank you for choosing <strong>ZipCargo</strong>.
    </p>
    <p style="color:#1e293b;font-size:13px;font-family:Helvetica,Arial,sans-serif;">
      Best regards,<br/>
      <strong>ZipCargo Logistics Team</strong><br/>
      <a href="mailto:${siteEmail}" style="color:#e8820c;">${siteEmail}</a>
    </p>
  </div>

  <!-- Footer -->
  <div class="zc-footer" bgcolor="#0d1f35" style="background:#0d1f35;padding:16px 28px;text-align:center;">
    <div style="color:#aac4e0;font-size:11px;font-family:Helvetica,Arial,sans-serif;">ZipCargo Logistics &#8212; Delivering trust, one shipment at a time</div>
  </div>
</div>
</body>
</html>`;

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'ZipCargo Logistics', email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        to: [{ email: shipment.rEmail, name: shipment.rName }],
        replyTo: { email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        subject: `Shipment Update: ${shipment.status} — ${shipment.tracking}`,
        htmlContent: emailHtml,
        trackingSettings: { clickTracking: { enabled: false }, openTracking: { enabled: false } },
      }),
    });

    const data = await brevoRes.json();
    if (!brevoRes.ok) throw new Error(data.message || 'Brevo error');
    res.json({ success: true });

  } catch (err) {
    console.error('Status update email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Crate Invoice email with PDF ─────────────────────────────────────────
app.post('/api/email/crate-invoice', async (req, res) => {
  try {
    const { shipment, option, prices, settings, quantity: qty, paymentMethods } = req.body;
    const quantity = parseInt(qty) || 1;
    if (!shipment || !shipment.rEmail || !option) {
      return res.status(400).json({ error: 'Missing data.' });
    }

    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) return res.json({ error: 'Email not configured.' });

    const siteEmail = (settings && settings.email) || process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com';
    const rentPrice = ((prices && prices.rent) || 200) * quantity;
    const buyPrice  = ((prices && prices.buy)  || 250) * quantity;
    const unitRent  = (prices && prices.rent) || 200;
    const unitBuy   = (prices && prices.buy)  || 250;
    const refundPct = (prices && prices.refund) || 98;
    const isRent    = option === 'rent';
    const price     = isRent ? rentPrice : buyPrice;
    const invoiceNo = 'ZCI-' + Date.now().toString().slice(-8);
    const issueDate = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });

    // ── Generate PDF Invoice ──
    const PDFDocument = require('pdfkit');
    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = 595, pad = 36, cW = W - pad * 2;

      // White background
      doc.rect(0, 0, W, 842).fill('#ffffff');

      // Orange top bar
      doc.rect(pad, 24, cW, 3).fill('#e8820c');

      // Header
      doc.roundedRect(pad, 27, cW, 88, 8).fill('#0d1f35');
      // ZipCargo logo PNG
      try {
        const logoPath = require('path').join(__dirname, 'public', 'logo-light.png');
        doc.image(logoPath, pad + 14, 38, { height: 44 });
      } catch(e) {
        // Fallback text logo if image fails
        doc.roundedRect(pad + 14, 42, 32, 32, 6).fill('#e8820c');
        doc.fill('white').fontSize(13).font('Helvetica-Bold').text('ZC', pad + 18, 50);
        doc.fill('white').fontSize(16).font('Helvetica-Bold').text('ZipCargo', pad + 54, 43);
        doc.fill('#aac4e0').fontSize(9).font('Helvetica').text('Global Logistics Solutions', pad + 54, 63);
      }
      doc.fill('#e8820c').fontSize(7).font('Helvetica-Bold')
         .text('C R A T E  I N V O I C E', 0, 38, { align: 'right', width: W - pad - 16 });
      doc.fill('#7a9ab8').fontSize(8).font('Helvetica')
         .text('Invoice No: ' + invoiceNo, 0, 52, { align: 'right', width: W - pad - 16 });
      doc.fill('white').fontSize(11).font('Helvetica-Bold')
         .text(shipment.tracking, 0, 65, { align: 'right', width: W - pad - 16 });
      doc.fill('#7a9ab8').fontSize(8)
         .text('Issued: ' + issueDate, 0, 81, { align: 'right', width: W - pad - 16 });

      // Option badge
      const badgeColor = isRent ? '#2563eb' : '#16a34a';
      const badgeText  = isRent ? 'RENTAL' : 'PURCHASE';
      doc.roundedRect(pad + 14, 87, 70, 18, 9).fill(badgeColor);
      doc.fill('white').fontSize(8).font('Helvetica-Bold')
         .text(badgeText, pad + 14, 93, { width: 70, align: 'center' });

      // Client info card
      let y = 130;
      doc.roundedRect(pad, y, cW, 56, 6).fill('#f8fafc').stroke('#e2e8f0');
      doc.fill('#94a3b8').fontSize(8).font('Helvetica-Bold').text('BILL TO', pad + 14, y + 10);
      doc.fill('#0d1f35').fontSize(11).font('Helvetica-Bold').text(shipment.rName, pad + 14, y + 24);
      doc.fill('#64748b').fontSize(9).font('Helvetica').text(shipment.rEmail, pad + 14, y + 38);
      if (shipment.rPhone) doc.fill('#64748b').fontSize(9).text(shipment.rPhone, pad + 14, y + 50);

      doc.fill('#94a3b8').fontSize(8).font('Helvetica-Bold').text('SHIPMENT REF', 0, y + 10, { align: 'right', width: W - pad - 16 });
      doc.fill('#0d1f35').fontSize(11).font('Helvetica-Bold').text(shipment.tracking, 0, y + 24, { align: 'right', width: W - pad - 16 });
      doc.fill('#64748b').fontSize(9).font('Helvetica').text(shipment.origin + ' → ' + shipment.dest, 0, y + 38, { align: 'right', width: W - pad - 16 });

      // Options table header
      y += 66;
      doc.roundedRect(pad, y, cW, 28, 4).fill('#0d1f35');
      doc.fill('white').fontSize(9).font('Helvetica-Bold').text('CRATE OPTIONS', pad + 14, y + 9);
      doc.fill('white').fontSize(9).text('AMOUNT', 0, y + 9, { align: 'right', width: W - pad - 14 });

      // Option 1 — Rental
      y += 28;
      doc.rect(pad, y, cW, 48).fill('#eff6ff').stroke('#bfdbfe');
      doc.fill('#1d4ed8').fontSize(10).font('Helvetica-Bold')
         .text('OPTION 1 — RENTAL', pad + 14, y + 8);
      doc.fill('#1e40af').fontSize(8).font('Helvetica')
         .text(quantity + 'x Air-Conditioned Crate Rental for ' + (shipment.description || 'Animal') + ' Transport', pad + 14, y + 22);
      doc.fill('#1e40af').fontSize(8)
         .text('Refund Policy: ' + refundPct + '% ($' + Math.round(rentPrice * refundPct / 100) + ') refunded upon delivery and crate return', pad + 14, y + 35);
      doc.fill('#1d4ed8').fontSize(14).font('Helvetica-Bold')
         .text('$' + rentPrice + '.00', 0, y + 16, { align: 'right', width: W - pad - 14 });

      // Option 2 — Purchase
      y += 48;
      doc.rect(pad, y, cW, 48).fill('#f0fdf4').stroke('#bbf7d0');
      doc.fill('#15803d').fontSize(10).font('Helvetica-Bold')
         .text('OPTION 2 — PURCHASE', pad + 14, y + 8);
      doc.fill('#166534').fontSize(8).font('Helvetica')
         .text(quantity + 'x Air-Conditioned Crate Purchase for ' + (shipment.description || 'Animal') + ' Transport', pad + 14, y + 22);
      doc.fill('#166534').fontSize(8)
         .text('Refund Policy: No refund — crate becomes your permanent property upon delivery', pad + 14, y + 35);
      doc.fill('#15803d').fontSize(14).font('Helvetica-Bold')
         .text('$' + buyPrice + '.00', 0, y + 16, { align: 'right', width: W - pad - 14 });

      // Response box
      y += 56;
      doc.roundedRect(pad, y, cW, 32, 4).fill('#fff7ed').stroke('#fed7aa');
      doc.fill('#ea580c').fontSize(9).font('Helvetica-Bold')
         .text('ACTION REQUIRED:', pad + 14, y + 8);
      doc.fill('#9a3412').fontSize(8).font('Helvetica')
         .text('Please reply to this email with your choice: OPTION 1 (Renting) or OPTION 2 (Purchasing)', pad + 14, y + 20);

      // Payment Methods section
      if (paymentMethods && paymentMethods.trim()) {
        y += 40;
        doc.roundedRect(pad, y, cW, 28, 4).fill('#0d1f35');
        doc.fill('white').fontSize(9).font('Helvetica-Bold').text('AVAILABLE PAYMENT METHODS', pad + 14, y + 9);
        y += 28;
        const pmLines = paymentMethods.trim().split('\n').filter(l => l.trim());
        const pmH = Math.max(pmLines.length * 16 + 20, 40);
        doc.rect(pad, y, cW, pmH).fill('#f8fafc').stroke('#e2e8f0');
        pmLines.forEach((line, i) => {
          doc.fill('#0d1f35').fontSize(9).font('Helvetica-Bold')
             .text(line.trim(), pad + 14, y + 10 + i * 16);
        });
        y += pmH;
        doc.rect(pad, y, cW, 22).fill('#fff7ed').stroke('#fed7aa');
        doc.fill('#9a3412').fontSize(8).font('Helvetica')
           .text('Payment details will be provided upon confirmation of your choice.', pad + 14, y + 7);
      }

      // ── TWO PROFESSIONAL STAMPS ──
      y += 42;

      // Draw professional stamp helper
      const drawStamp = (cx, cy, color, line1, line2, line3) => {
        doc.circle(cx, cy, 50).lineWidth(4).stroke(color);
        doc.circle(cx, cy, 42).lineWidth(1.5).stroke(color);
        for (let a = 0; a < 360; a += 20) {
          const rad = a * Math.PI / 180;
          doc.circle(cx + 46 * Math.cos(rad), cy + 46 * Math.sin(rad), 1.5).fill(color);
        }
        doc.fill(color).fontSize(11).font('Helvetica-Bold')
           .text(line1, cx - 34, cy - 15, { width: 68, align: 'center' });
        doc.fill(color).fontSize(9).font('Helvetica-Bold')
           .text(line2, cx - 34, cy + 1, { width: 68, align: 'center' });
        doc.fill(color).fontSize(6.5).font('Helvetica')
           .text(line3, cx - 34, cy + 16, { width: 68, align: 'center' });
      };

      drawStamp(pad + 75, y + 50, '#1d4ed8', 'RENTAL', refundPct + '% REFUND', 'ZIPCARGO CERTIFIED');
      drawStamp(W - pad - 75, y + 50, '#15803d', 'PURCHASE', 'NO REFUND', 'ZIPCARGO CERTIFIED');

      // Terms
      y += 112;
      doc.fill('#64748b').fontSize(8).font('Helvetica-Bold').text('Terms & Conditions:', pad + 14, y);
      const terms = `1. Payment is required before shipment proceeds.\n2. RENTAL: ${refundPct}% ($${Math.round(rentPrice * refundPct / 100)}) refunded upon delivery and crate return. Crate must be returned in original condition.\n3. PURCHASE: Crate becomes your permanent property upon delivery. No refund issued.\n4. Please reply confirming your choice before we proceed.`;
      doc.fill('#64748b').fontSize(8).font('Helvetica')
         .text(terms, pad + 14, y + 14, { width: cW - 28, lineBreak: true });

      // Signature line
      y += 80;
      doc.moveTo(pad + 14, y).lineTo(pad + 160, y).lineWidth(1).stroke('#0d1f35');
      doc.fill('#0d1f35').fontSize(8).font('Helvetica-Bold').text('Authorized by ZipCargo Logistics', pad + 14, y + 5);
      doc.fill('#64748b').fontSize(7).font('Helvetica').text(siteEmail, pad + 14, y + 18);

      doc.fill('#0d1f35').fontSize(8).font('Helvetica-Bold').text('Authorized by ZipCargo Logistics', pad + 14, y + 5);
      doc.fill('#64748b').fontSize(7).font('Helvetica').text(siteEmail, pad + 14, y + 18);

      // Footer
      y += 34;
      doc.roundedRect(pad, y, cW, 44, 6).fill('white').stroke('#e2e8f0');
      doc.roundedRect(pad + 12, y + 8, 26, 26, 5).fill('#0d1f35');
      doc.fill('#e8820c').fontSize(11).font('Helvetica-Bold').text('ZC', pad + 16, y + 15);
      doc.fill('#0d1f35').fontSize(10).font('Helvetica-Bold').text('ZipCargo Logistics', pad + 46, y + 10);
      doc.fill('#94a3b8').fontSize(8).font('Helvetica').text('Ship Smarter. Deliver Faster.', pad + 46, y + 24);
      doc.fill('#94a3b8').fontSize(7).text(invoiceNo + '  •  ' + issueDate, 0, y + 30, { align: 'right', width: W - pad - 14 });
      doc.rect(pad, y + 44, cW, 3).fill('#e8820c');

      doc.end();
    });

    // ── Email ──
    const emailHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="color-scheme" content="light only"/>
<meta name="supported-color-schemes" content="light only"/>
<meta name="x-apple-disable-message-reformatting"/>
<style>
body{margin:0;padding:0;background:#f3f4f6;font-family:Helvetica,Arial,sans-serif;}
</style>
</head>
<body class="body" bgcolor="#f3f4f6" style="margin:0;padding:20px;background:#f3f4f6;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
  <div class="zc-header" bgcolor="#0d1f35" style="background:#0d1f35;padding:24px 28px;">
    <img src="https://zipcargologistics.com/logo-light-email.png" alt="ZipCargo" style="height:64px;display:block;"/>
    <div style="color:#aac4e0;font-size:12px;margin-top:8px;">Global Logistics Solutions</div>
  </div>
  <div style="padding:28px;background:#ffffff;">
    <p style="color:#0d1f35;font-size:15px;">Dear <strong>${shipment.rName}</strong>,</p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      We have your <strong>${shipment.description || 'animal'}</strong> available in our custody for transportation to you.
      However, our terms of service require animals to be transported in the most comfortable conditions possible in order to meet our standards.
    </p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      You are hereby required to get a medium-sized electric air-conditioned crate for your <strong>${shipment.description || 'animal'}</strong> to be transported in.
    </p>
    <p style="color:#0d1f35;font-size:14px;font-weight:700;">As for the electric crate, two options are available:</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">
      <tr>
        <td style="padding:12px;background:#eff6ff;border-radius:8px 0 0 8px;border:1px solid #bfdbfe;width:48%;">
          <div style="color:#1d4ed8;font-weight:800;font-size:13px;">Renting: $${rentPrice}</div>
          <div style="color:#1e40af;font-size:12px;margin-top:4px;">${refundPct}% refunded upon delivery and crate return</div>
        </td>
        <td style="width:4%;"></td>
        <td style="padding:12px;background:#f0fdf4;border-radius:0 8px 8px 0;border:1px solid #bbf7d0;width:48%;">
          <div style="color:#15803d;font-weight:800;font-size:13px;">Purchasing: $${buyPrice}</div>
          <div style="color:#166534;font-size:12px;margin-top:4px;">Crate remains your property — no refund</div>
        </td>
      </tr>
    </table>
    ${(() => {
      if (!paymentMethods || !paymentMethods.trim()) return '';
      const lines = paymentMethods.trim().split('\n').filter(l => l.trim());
      const items = lines.map(l => '<div style="color:#0d1f35;font-size:13px;padding:4px 0;font-weight:600;">&#8226; ' + l.trim() + '</div>').join('');
      return '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0;"><div style="color:#0d1f35;font-size:12px;font-weight:700;letter-spacing:.5px;margin-bottom:10px;">AVAILABLE PAYMENT METHODS</div>' + items + '<div style="color:#94a3b8;font-size:11px;margin-top:10px;font-style:italic;">Payment details will be sent to you upon confirmation of your choice.</div></div>';
    })()}
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      Please respond to this email with your choice <strong>(renting or purchasing)</strong> and your preferred payment method, and we will send you the payment details.
    </p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      Thank you for your understanding.
    </p>
    <p style="color:#1e293b;font-size:14px;">
      Best regards,<br/>
      <strong>ZipCargo Logistics Team</strong><br/>
      <a href="mailto:${siteEmail}" style="color:#e8820c;">${siteEmail}</a>
    </p>
    <p style="color:#94a3b8;font-size:12px;border-top:1px solid #f1f5f9;padding-top:12px;margin-top:16px;">
      Your official crate invoice is attached to this email for your records.
    </p>
  </div>
  <div class="zc-footer" bgcolor="#0d1f35" style="background:#0d1f35;padding:16px 28px;text-align:center;">
    <div style="color:#aac4e0;font-size:11px;">ZipCargo Logistics &#8212; Delivering trust, one shipment at a time</div>
  </div>
</div>
</body></html>`;

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept':'application/json','api-key':apiKey,'content-type':'application/json' },
      body: JSON.stringify({
        sender: { name: 'ZipCargo Logistics', email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        to: [{ email: shipment.rEmail, name: shipment.rName }],
        replyTo: { email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        subject: `Crate Requirement — Action Required — ${shipment.tracking}`,
        htmlContent: emailHtml,
        trackingSettings: { clickTracking: { enabled: false }, openTracking: { enabled: false } },
        attachment: [{
          name: `ZipCargo-Crate-Invoice-${shipment.tracking}.pdf`,
          content: pdfBuffer.toString('base64'),
        }],
      }),
    });

    const data = await brevoRes.json();
    if (!brevoRes.ok) throw new Error(data.message || 'Brevo error');
    res.json({ success: true });

  } catch(err) {
    console.error('Crate invoice error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Vaccine Invoice ───────────────────────────────────────────────────────
app.post('/api/email/vaccine-invoice', async (req, res) => {
  try {
    const { shipment, fee, paymentMethods, settings } = req.body;
    if (!shipment || !shipment.rEmail) return res.status(400).json({ error: 'Missing data.' });

    const apiKey    = process.env.BREVO_API_KEY;
    if (!apiKey) return res.json({ error: 'Email not configured.' });

    const siteEmail = (settings && settings.email) || process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com';
    const vacFee    = parseFloat(fee) || 289;
    const invoiceNo = 'ZVI-' + Date.now().toString().slice(-8);
    const issueDate = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });

    // ── PDF ──────────────────────────────────────────────────────────────
    const PDFDocument = require('pdfkit');
    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = 595, pad = 36, cW = W - pad * 2;
      doc.rect(0, 0, W, 842).fill('#ffffff');
      doc.rect(pad, 24, cW, 3).fill('#e8820c');

      // Header
      doc.roundedRect(pad, 27, cW, 88, 8).fill('#0d1f35');
      // ZipCargo logo PNG
      try {
        const logoPath = require('path').join(__dirname, 'public', 'logo-light.png');
        doc.image(logoPath, pad + 14, 38, { height: 44 });
      } catch(e) {
        // Fallback text logo if image fails
        doc.roundedRect(pad + 14, 42, 32, 32, 6).fill('#e8820c');
        doc.fill('white').fontSize(13).font('Helvetica-Bold').text('ZC', pad + 18, 50);
        doc.fill('white').fontSize(16).font('Helvetica-Bold').text('ZipCargo', pad + 54, 43);
        doc.fill('#aac4e0').fontSize(9).font('Helvetica').text('Global Logistics Solutions', pad + 54, 63);
      }
      doc.fill('#e8820c').fontSize(7).font('Helvetica-Bold')
         .text('V A C C I N A T I O N  I N V O I C E', 0, 38, { align: 'right', width: W - pad - 16 });
      doc.fill('#7a9ab8').fontSize(8).font('Helvetica')
         .text('Invoice No: ' + invoiceNo, 0, 52, { align: 'right', width: W - pad - 16 });
      doc.fill('white').fontSize(11).font('Helvetica-Bold')
         .text(shipment.tracking, 0, 65, { align: 'right', width: W - pad - 16 });
      doc.fill('#7a9ab8').fontSize(8)
         .text('Issued: ' + issueDate, 0, 81, { align: 'right', width: W - pad - 16 });

      // 100% REFUNDABLE badge
      doc.roundedRect(pad + 14, 87, 110, 18, 9).fill('#16a34a');
      doc.fill('white').fontSize(8).font('Helvetica-Bold')
         .text('100% REFUNDABLE', pad + 14, 93, { width: 110, align: 'center' });

      // Client info
      let y = 130;
      doc.roundedRect(pad, y, cW, 56, 6).fill('#f8fafc').stroke('#e2e8f0');
      doc.fill('#94a3b8').fontSize(8).font('Helvetica-Bold').text('BILL TO', pad + 14, y + 10);
      doc.fill('#0d1f35').fontSize(11).font('Helvetica-Bold').text(shipment.rName, pad + 14, y + 24);
      doc.fill('#64748b').fontSize(9).font('Helvetica').text(shipment.rEmail, pad + 14, y + 38);
      if (shipment.rPhone) doc.fill('#64748b').fontSize(9).text(shipment.rPhone, pad + 14, y + 50);
      doc.fill('#94a3b8').fontSize(8).font('Helvetica-Bold').text('SHIPMENT REF', 0, y + 10, { align: 'right', width: W - pad - 16 });
      doc.fill('#0d1f35').fontSize(11).font('Helvetica-Bold').text(shipment.tracking, 0, y + 24, { align: 'right', width: W - pad - 16 });
      doc.fill('#64748b').fontSize(9).font('Helvetica').text((shipment.origin||'-') + ' to ' + (shipment.dest||'-'), 0, y + 38, { align: 'right', width: W - pad - 16 });

      // Invoice table
      y += 66;
      doc.roundedRect(pad, y, cW, 28, 4).fill('#0d1f35');
      doc.fill('white').fontSize(9).font('Helvetica-Bold').text('DESCRIPTION', pad + 14, y + 9);
      doc.fill('white').fontSize(9).text('AMOUNT', 0, y + 9, { align: 'right', width: W - pad - 14 });

      y += 28;
      doc.rect(pad, y, cW, 44).fill('white').stroke('#e2e8f0');
      doc.fill('#0d1f35').fontSize(10).font('Helvetica-Bold')
         .text('Vaccination & Processing Fee', pad + 14, y + 8);
      doc.fill('#64748b').fontSize(8).font('Helvetica')
         .text('Required vaccinations and health certification for ' + (shipment.description || 'pet') + ' transport compliance', pad + 14, y + 22, { width: cW - 100 });
      doc.fill('#0d1f35').fontSize(14).font('Helvetica-Bold')
         .text('$' + vacFee.toFixed(2), 0, y + 14, { align: 'right', width: W - pad - 14 });

      // Refund policy row
      y += 44;
      doc.rect(pad, y, cW, 26).fill('#f0fdf4').stroke('#bbf7d0');
      doc.fill('#15803d').fontSize(9).font('Helvetica-Bold')
         .text('Refund Policy: 100% refunded immediately upon successful delivery of the pet', pad + 14, y + 9);

      // Action required
      y += 34;
      doc.roundedRect(pad, y, cW, 30, 4).fill('#fff7ed').stroke('#fed7aa');
      doc.fill('#ea580c').fontSize(9).font('Helvetica-Bold').text('ACTION REQUIRED:', pad + 14, y + 8);
      doc.fill('#9a3412').fontSize(8).font('Helvetica')
         .text('Please reply to this email with your preferred payment method to proceed.', pad + 14, y + 20);

      // Payment methods
      if (paymentMethods && paymentMethods.trim()) {
        y += 38;
        doc.roundedRect(pad, y, cW, 28, 4).fill('#0d1f35');
        doc.fill('white').fontSize(9).font('Helvetica-Bold').text('AVAILABLE PAYMENT METHODS', pad + 14, y + 9);
        y += 28;
        const pmLines = paymentMethods.trim().split(/\r?\n/).filter(l => l.trim());
        const pmH = Math.max(pmLines.length * 18 + 24, 40);
        doc.rect(pad, y, cW, pmH).fill('#f8fafc').stroke('#e2e8f0');
        pmLines.forEach((line, i) => {
          doc.fill('#0d1f35').fontSize(9).font('Helvetica-Bold')
             .text('• ' + line.trim(), pad + 14, y + 10 + i * 18, { width: cW - 28 });
        });
        y += pmH;
        doc.rect(pad, y, cW, 22).fill('#fff7ed').stroke('#fed7aa');
        doc.fill('#9a3412').fontSize(8).font('Helvetica')
           .text('Payment details will be provided upon confirmation of your choice.', pad + 14, y + 7);
        y += 22;
      }

      // Total banner
      y += 10;
      doc.roundedRect(pad, y, cW, 44, 6).fill('#0d1f35');
      doc.fill('#aac4e0').fontSize(9).font('Helvetica').text('TOTAL AMOUNT DUE', pad + 14, y + 12);
      doc.fill('#7a9ab8').fontSize(8).text('100% refundable upon successful pet delivery', pad + 14, y + 26);
      doc.fill('#e8820c').fontSize(22).font('Helvetica-Bold')
         .text('$' + vacFee.toFixed(2), 0, y + 10, { align: 'right', width: W - pad - 14 });

      // STAMP — large centered
      y += 54;
      const cx = W / 2, cy = y + 65;
      // Outer ring
      doc.circle(cx, cy, 72).lineWidth(5).stroke('#16a34a');
      // Inner ring
      doc.circle(cx, cy, 62).lineWidth(2).stroke('#16a34a');
      // Decorative dots
      for (let a = 0; a < 360; a += 15) {
        const rad = a * Math.PI / 180;
        doc.circle(cx + 67 * Math.cos(rad), cy + 67 * Math.sin(rad), 2).fill('#16a34a');
      }
      // Text — centered inside
      doc.fill('#16a34a').fontSize(18).font('Helvetica-Bold')
         .text('100%', cx - 50, cy - 26, { width: 100, align: 'center' });
      doc.fill('#16a34a').fontSize(13).font('Helvetica-Bold')
         .text('REFUNDABLE', cx - 50, cy - 2, { width: 100, align: 'center' });
      doc.fill('#16a34a').fontSize(8).font('Helvetica')
         .text('ZIPCARGO CERTIFIED', cx - 50, cy + 18, { width: 100, align: 'center' });

      // Terms
      y += 115;
      doc.fill('#64748b').fontSize(8).font('Helvetica-Bold').text('Terms & Conditions:', pad + 14, y);
      doc.fill('#64748b').fontSize(8).font('Helvetica')
         .text('1. Payment is required before the vaccination process can begin.\n2. The full amount ($' + vacFee.toFixed(2) + ') will be refunded immediately upon successful delivery of the pet.\n3. This fee covers all required vaccinations and health certifications per transport regulations.\n4. Please reply to confirm your payment method to proceed.', pad + 14, y + 14, { width: cW - 28, lineBreak: true });

      // Footer
      y += 80;
      doc.roundedRect(pad, y, cW, 44, 6).fill('white').stroke('#e2e8f0');
      doc.roundedRect(pad + 12, y + 8, 26, 26, 5).fill('#0d1f35');
      doc.fill('#e8820c').fontSize(11).font('Helvetica-Bold').text('ZC', pad + 16, y + 15);
      doc.fill('#0d1f35').fontSize(10).font('Helvetica-Bold').text('ZipCargo Logistics', pad + 46, y + 10);
      doc.fill('#94a3b8').fontSize(8).font('Helvetica').text('Ship Smarter. Deliver Faster.', pad + 46, y + 24);
      doc.fill('#94a3b8').fontSize(7).text(invoiceNo + '  •  ' + issueDate, 0, y + 28, { align: 'right', width: W - pad - 14 });
      doc.rect(pad, y + 44, cW, 3).fill('#e8820c');

      doc.end();
    });

    // ── Email ────────────────────────────────────────────────────────────
    const pmHtml = (() => {
      if (!paymentMethods || !paymentMethods.trim()) return '';
      const lines = paymentMethods.trim().split('\n').filter(l => l.trim());
      const items = lines.map(l => '<div style="color:#0d1f35;font-size:13px;padding:4px 0;font-weight:600;">&#8226; ' + l.trim() + '</div>').join('');
      return '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0;"><div style="color:#0d1f35;font-size:12px;font-weight:700;letter-spacing:.5px;margin-bottom:10px;">AVAILABLE PAYMENT METHODS</div>' + items + '<div style="color:#94a3b8;font-size:11px;margin-top:10px;font-style:italic;">Payment details will be sent to you upon confirmation.</div></div>';
    })();

    const emailHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="color-scheme" content="light only"/>
<meta name="supported-color-schemes" content="light only"/>
<meta name="x-apple-disable-message-reformatting"/>
<style>
body{margin:0;padding:0;background:#f3f4f6;font-family:Helvetica,Arial,sans-serif;}
</style>
</head>
<body class="body" bgcolor="#f3f4f6" style="margin:0;padding:20px;background:#f3f4f6;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
  <div class="zc-header" bgcolor="#0d1f35" style="background:#0d1f35;padding:24px 28px;">
    <img src="https://zipcargologistics.com/logo-light-email.png" alt="ZipCargo" style="height:64px;display:block;"/>
    <div style="color:#aac4e0;font-size:12px;margin-top:8px;">Global Logistics Solutions</div>
  </div>
  <div style="padding:28px;background:#ffffff;">
    <p style="color:#0d1f35;font-size:15px;font-weight:700;">GREETINGS,</p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">We hope this message finds you well.</p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      During our routine review of the shipment documentation, we noted that the pets currently require the necessary vaccinations prior to final delivery. At this time, the pet is safely with our agency.
    </p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      In line with agency health and transport regulations, the pet must complete the vaccination process through our agency before proceeding with delivery. This step ensures the pets safety and full compliance with transport standards.
    </p>
    <div style="background:#f0fdf4;border:2px solid #16a34a;border-radius:10px;padding:16px;text-align:center;margin:20px 0;">
      <div style="color:#64748b;font-size:11px;font-weight:700;letter-spacing:1px;">VACCINATION & PROCESSING FEE</div>
      <div style="color:#16a34a;font-size:28px;font-weight:800;margin-top:6px;">$${vacFee.toFixed(2)}</div>
      <div style="color:#15803d;font-size:12px;font-weight:700;margin-top:4px;">100% REFUNDABLE</div>
    </div>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;"><strong>Refund Policy:</strong><br/>
      The full amount will be refunded immediately once the pet arrives at their destination.
    </p>
    ${pmHtml}
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      Please respond to this email with your preferred payment method and we will send you the payment details to proceed.
    </p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      Thank you for your cooperation and continued trust.
    </p>
    <p style="color:#1e293b;font-size:14px;">
      Best regards,<br/>
      <strong>ZipCargo Logistics Team</strong><br/>
      <a href="mailto:${siteEmail}" style="color:#e8820c;">${siteEmail}</a>
    </p>
  </div>
  <div class="zc-footer" bgcolor="#0d1f35" style="background:#0d1f35;padding:16px 28px;text-align:center;">
    <div style="color:#aac4e0;font-size:11px;">ZipCargo Logistics &#8212; Delivering trust, one shipment at a time</div>
        <div style="color:#4a6a88;font-size:10px;margin-top:4px;">Your official vaccination invoice is attached to this email.</div>
  </div>
</div>
</body></html>`;

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept':'application/json','api-key':apiKey,'content-type':'application/json' },
      body: JSON.stringify({
        sender: { name: 'ZipCargo Logistics', email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        to: [{ email: shipment.rEmail, name: shipment.rName }],
        replyTo: { email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        subject: `Vaccination Fee Notice — ${shipment.tracking}`,
        htmlContent: emailHtml,
        trackingSettings: { clickTracking: { enabled: false }, openTracking: { enabled: false } },
        attachment: [{
          name: `ZipCargo-Vaccine-Invoice-${shipment.tracking}.pdf`,
          content: pdfBuffer.toString('base64'),
        }],
      }),
    });

    const data = await brevoRes.json();
    if (!brevoRes.ok) throw new Error(data.message || 'Brevo error');
    res.json({ success: true });

  } catch(err) {
    console.error('Vaccine invoice error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Insurance Invoice ─────────────────────────────────────────────────────
app.post('/api/email/insurance-invoice', async (req, res) => {
  try {
    const { shipment, fee, duration, paymentMethods, settings } = req.body;
    if (!shipment || !shipment.rEmail) return res.status(400).json({ error: 'Missing data.' });

    const apiKey    = process.env.BREVO_API_KEY;
    if (!apiKey) return res.json({ error: 'Email not configured.' });

    const siteEmail  = (settings && settings.email) || process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com';
    const insFee     = parseFloat(fee) || 103;
    const insDuration = duration || '8 months';
    const invoiceNo  = 'ZII-' + Date.now().toString().slice(-8);
    const issueDate  = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });

    const PDFDocument = require('pdfkit');
    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = 595, pad = 36, cW = W - pad * 2;
      doc.rect(0, 0, W, 842).fill('#ffffff');
      doc.rect(pad, 24, cW, 3).fill('#e8820c');

      // Header
      doc.roundedRect(pad, 27, cW, 88, 8).fill('#0d1f35');
      // ZipCargo logo PNG
      try {
        const logoPath = require('path').join(__dirname, 'public', 'logo-light.png');
        doc.image(logoPath, pad + 14, 38, { height: 44 });
      } catch(e) {
        // Fallback text logo if image fails
        doc.roundedRect(pad + 14, 42, 32, 32, 6).fill('#e8820c');
        doc.fill('white').fontSize(13).font('Helvetica-Bold').text('ZC', pad + 18, 50);
        doc.fill('white').fontSize(16).font('Helvetica-Bold').text('ZipCargo', pad + 54, 43);
        doc.fill('#aac4e0').fontSize(9).font('Helvetica').text('Global Logistics Solutions', pad + 54, 63);
      }
      doc.fill('#e8820c').fontSize(7).font('Helvetica-Bold')
         .text('I N S U R A N C E  I N V O I C E', 0, 38, { align: 'right', width: W - pad - 16 });
      doc.fill('#7a9ab8').fontSize(8).font('Helvetica')
         .text('Invoice No: ' + invoiceNo, 0, 52, { align: 'right', width: W - pad - 16 });
      doc.fill('white').fontSize(11).font('Helvetica-Bold')
         .text(shipment.tracking, 0, 65, { align: 'right', width: W - pad - 16 });
      doc.fill('#7a9ab8').fontSize(8)
         .text('Issued: ' + issueDate, 0, 81, { align: 'right', width: W - pad - 16 });

      // Badge
      doc.roundedRect(pad + 14, 87, 120, 18, 9).fill('#16a34a');
      doc.fill('white').fontSize(8).font('Helvetica-Bold')
         .text('FULLY REFUNDABLE', pad + 14, 93, { width: 120, align: 'center' });

      // Client info — compact
      let y = 130;
      doc.roundedRect(pad, y, cW, 44, 6).fill('#f8fafc').stroke('#e2e8f0');
      doc.fill('#94a3b8').fontSize(7).font('Helvetica-Bold').text('BILL TO', pad + 14, y + 8);
      doc.fill('#0d1f35').fontSize(10).font('Helvetica-Bold').text(shipment.rName, pad + 14, y + 19);
      doc.fill('#64748b').fontSize(8).font('Helvetica').text(shipment.rEmail, pad + 14, y + 31);
      doc.fill('#94a3b8').fontSize(7).font('Helvetica-Bold').text('SHIPMENT REF', 0, y + 8, { align: 'right', width: W - pad - 16 });
      doc.fill('#0d1f35').fontSize(10).font('Helvetica-Bold').text(shipment.tracking, 0, y + 19, { align: 'right', width: W - pad - 16 });
      doc.fill('#64748b').fontSize(8).font('Helvetica').text((shipment.origin||'-') + ' to ' + (shipment.dest||'-'), 0, y + 31, { align: 'right', width: W - pad - 16 });

      // Table header
      y += 50;
      doc.roundedRect(pad, y, cW, 22, 3).fill('#0d1f35');
      doc.fill('white').fontSize(8).font('Helvetica-Bold').text('DESCRIPTION', pad + 14, y + 7);
      doc.fill('white').fontSize(8).text('AMOUNT', 0, y + 7, { align: 'right', width: W - pad - 14 });

      // Line item
      y += 22;
      doc.rect(pad, y, cW, 34).fill('white').stroke('#e2e8f0');
      doc.fill('#0d1f35').fontSize(9).font('Helvetica-Bold').text('Insurance Registration Fee', pad + 14, y + 7);
      doc.fill('#64748b').fontSize(7).font('Helvetica')
         .text('Coverage for ' + insDuration + ' — ' + (shipment.description || 'package') + ' transport', pad + 14, y + 20, { width: cW - 100 });
      doc.fill('#0d1f35').fontSize(13).font('Helvetica-Bold')
         .text('$' + insFee.toFixed(2), 0, y + 10, { align: 'right', width: W - pad - 14 });

      // Refund row
      y += 34;
      doc.rect(pad, y, cW, 18).fill('#f0fdf4').stroke('#bbf7d0');
      doc.fill('#15803d').fontSize(7.5).font('Helvetica-Bold')
         .text('Refund Policy: 100% refunded immediately upon successful delivery of the shipment', pad + 14, y + 5);

      // Coverage + Next steps columns
      y += 22;
      const halfW = cW / 2 - 4;
      doc.roundedRect(pad, y, halfW, 54, 4).fill('#f0f7ff').stroke('#bfdbfe');
      doc.fill('#1d4ed8').fontSize(8).font('Helvetica-Bold').text('INSURANCE COVERAGE', pad + 10, y + 8);
      doc.fill('#1e40af').fontSize(7).font('Helvetica')
         .text('Duration: ' + insDuration + '\nCovers: Transit protection, customs compliance, HTS code classification.', pad + 10, y + 21, { width: halfW - 20 });

      doc.roundedRect(pad + halfW + 8, y, halfW, 54, 4).fill('#fff7ed').stroke('#fed7aa');
      doc.fill('#ea580c').fontSize(8).font('Helvetica-Bold').text('NEXT STEPS', pad + halfW + 18, y + 8);
      doc.fill('#9a3412').fontSize(7).font('Helvetica')
         .text('• Final package verification\n• Insurance activation\n• Scheduling delivery to your address', pad + halfW + 18, y + 21, { width: halfW - 20 });

      // Action required
      y += 60;
      doc.roundedRect(pad, y, cW, 20, 3).fill('#fef2f2').stroke('#fecaca');
      doc.fill('#dc2626').fontSize(8).font('Helvetica-Bold').text('ACTION REQUIRED: ', pad + 14, y + 6, { continued: true });
      doc.fill('#991b1b').fontSize(8).font('Helvetica').text('Please reply with your preferred payment method to proceed.');

      // Payment methods
      if (paymentMethods && paymentMethods.trim()) {
        y += 26;
        doc.roundedRect(pad, y, cW, 20, 3).fill('#0d1f35');
        doc.fill('white').fontSize(8).font('Helvetica-Bold').text('AVAILABLE PAYMENT METHODS', pad + 14, y + 6);
        y += 20;
        const pmLines = paymentMethods.trim().split(/\r?\n/).filter(l => l.trim());
        const pmH = Math.max(pmLines.length * 14 + 14, 32);
        doc.rect(pad, y, cW, pmH).fill('#f8fafc').stroke('#e2e8f0');
        pmLines.forEach((line, i) => {
          doc.fill('#0d1f35').fontSize(8).font('Helvetica-Bold')
             .text('• ' + line.trim(), pad + 14, y + 7 + i * 14, { width: cW - 28 });
        });
        y += pmH;
        doc.rect(pad, y, cW, 16).fill('#fff7ed').stroke('#fed7aa');
        doc.fill('#9a3412').fontSize(7).font('Helvetica')
           .text('Payment details provided upon confirmation of your choice.', pad + 14, y + 4);
        y += 16;
      }

      // Total banner
      y += 8;
      doc.roundedRect(pad, y, cW, 34, 5).fill('#0d1f35');
      doc.fill('#aac4e0').fontSize(8).font('Helvetica').text('TOTAL INSURANCE FEE', pad + 14, y + 8);
      doc.fill('#7a9ab8').fontSize(7).text('100% refundable upon successful delivery', pad + 14, y + 20);
      doc.fill('#e8820c').fontSize(18).font('Helvetica-Bold')
         .text('$' + insFee.toFixed(2), 0, y + 7, { align: 'right', width: W - pad - 14 });

      // Stamp (right) + Terms (left) side by side
      y += 42;
      const scx = W - pad - 52, scy = y + 50;
      doc.circle(scx, scy, 48).lineWidth(4).stroke('#16a34a');
      doc.circle(scx, scy, 40).lineWidth(1.5).stroke('#16a34a');
      for (let a = 0; a < 360; a += 20) {
        const rad = a * Math.PI / 180;
        doc.circle(scx + 44 * Math.cos(rad), scy + 44 * Math.sin(rad), 1.5).fill('#16a34a');
      }
      doc.fill('#16a34a').fontSize(8).font('Helvetica-Bold').text('FULLY', scx - 32, scy - 15, { width: 64, align: 'center' });
      doc.fill('#16a34a').fontSize(9).font('Helvetica-Bold').text('REFUNDABLE', scx - 32, scy - 2, { width: 64, align: 'center' });
      doc.fill('#16a34a').fontSize(6).font('Helvetica').text('ZIPCARGO CERTIFIED', scx - 32, scy + 11, { width: 64, align: 'center' });

      // Terms left of stamp
      doc.fill('#64748b').fontSize(7.5).font('Helvetica-Bold').text('Terms & Conditions:', pad + 14, y + 6);
      doc.fill('#64748b').fontSize(7).font('Helvetica')
         .text('1. Insurance fee required before delivery is scheduled.\n2. Full $' + insFee.toFixed(2) + ' refunded upon successful delivery.\n3. Coverage valid for ' + insDuration + '.\n4. Reply with payment method to proceed.', pad + 14, y + 19, { width: cW - 120, lineBreak: true });

      // Footer
      y += 112;
      doc.roundedRect(pad, y, cW, 36, 5).fill('white').stroke('#e2e8f0');
      doc.roundedRect(pad + 10, y + 6, 22, 22, 4).fill('#0d1f35');
      doc.fill('#e8820c').fontSize(10).font('Helvetica-Bold').text('ZC', pad + 14, y + 12);
      doc.fill('#0d1f35').fontSize(9).font('Helvetica-Bold').text('ZipCargo Logistics', pad + 40, y + 8);
      doc.fill('#94a3b8').fontSize(7.5).font('Helvetica').text('Ship Smarter. Deliver Faster.', pad + 40, y + 20);
      doc.fill('#94a3b8').fontSize(6.5).text(invoiceNo + '  •  ' + issueDate, 0, y + 22, { align: 'right', width: W - pad - 14 });
      doc.rect(pad, y + 36, cW, 3).fill('#e8820c');

      doc.end();
    });

    // Email
    const pmHtml = (() => {
      if (!paymentMethods || !paymentMethods.trim()) return '';
      const lines = paymentMethods.trim().split(/\r?\n/).filter(l => l.trim());
      const items = lines.map(l => '<div style="color:#0d1f35;font-size:13px;padding:4px 0;font-weight:600;">&#8226; ' + l.trim() + '</div>').join('');
      return '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0;"><div style="color:#0d1f35;font-size:12px;font-weight:700;letter-spacing:.5px;margin-bottom:10px;">AVAILABLE PAYMENT METHODS</div>' + items + '<div style="color:#94a3b8;font-size:11px;margin-top:10px;font-style:italic;">Payment details will be sent to you upon confirmation of your choice.</div></div>';
    })();

    const emailHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="color-scheme" content="light only"/>
<meta name="supported-color-schemes" content="light only"/>
<meta name="x-apple-disable-message-reformatting"/>
<style>
body{margin:0;padding:0;background:#f3f4f6;font-family:Helvetica,Arial,sans-serif;}
</style>
</head>
<body class="body" bgcolor="#f3f4f6" style="margin:0;padding:20px;background:#f3f4f6;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
  <div class="zc-header" bgcolor="#0d1f35" style="background:#0d1f35;padding:24px 28px;">
    <img src="https://zipcargologistics.com/logo-light-email.png" alt="ZipCargo" style="height:64px;display:block;"/>
    <div style="color:#aac4e0;font-size:12px;margin-top:8px;">Global Logistics Solutions — Official Insurance Notice</div>
  </div>
  <div style="padding:28px;background:#ffffff;">
    <p style="color:#0d1f35;font-size:15px;">Dear <strong>${shipment.rName}</strong>,</p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      During the final review of your shipment documentation, we identified that your package does not currently meet the insurance requirements needed for secure transportation. To ensure full protection during transit and compliance with international shipping regulations, an <strong>Insurance Registration</strong> must be completed before the package can be scheduled for delivery.
    </p>

    <div style="background:#f0f7ff;border-left:4px solid #2563eb;border-radius:0 8px 8px 0;padding:16px;margin:16px 0;">
      <div style="color:#1d4ed8;font-size:13px;font-weight:800;margin-bottom:10px;">Why Insurance Is Required</div>
      <div style="color:#1e40af;font-size:13px;line-height:1.8;">
        &#8226; Full protection of the package during handling and transit<br/>
        &#8226; Compliance with customs and transportation regulations<br/>
        &#8226; Accurate classification and processing based on HTS codes and applicable oversight agencies
      </div>
    </div>

    <div style="background:#f0fdf4;border:2px solid #16a34a;border-radius:10px;padding:16px;text-align:center;margin:20px 0;">
      <div style="color:#64748b;font-size:11px;font-weight:700;letter-spacing:1px;">INSURANCE REGISTRATION FEE</div>
      <div style="color:#16a34a;font-size:28px;font-weight:800;margin-top:6px;">$${insFee.toFixed(2)}</div>
      <div style="color:#15803d;font-size:12px;font-weight:700;margin-top:4px;">100% FULLY REFUNDABLE</div>
      <div style="color:#64748b;font-size:11px;margin-top:4px;">Refunded immediately upon successful delivery</div>
    </div>

    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0;">
      <div style="color:#0d1f35;font-size:13px;font-weight:800;margin-bottom:8px;">&#128737; Insurance Coverage</div>
      <p style="color:#1e293b;font-size:13px;line-height:1.8;margin:0;">
        Once registered, your insurance will remain valid for <strong>${insDuration}</strong> and will cover any additional shipments you choose to send or receive during that period.
      </p>
    </div>

    <div style="background:#fff7ed;border-left:4px solid #e8820c;border-radius:0 8px 8px 0;padding:16px;margin:16px 0;">
      <div style="color:#ea580c;font-size:13px;font-weight:800;margin-bottom:8px;">Next Steps</div>
      <div style="color:#9a3412;font-size:13px;line-height:1.8;">
        Please complete the insurance fee payment to allow us to proceed with:<br/>
        &#8226; Final package verification and documentation review<br/>
        &#8226; Insurance activation and coverage confirmation<br/>
        &#8226; Scheduling delivery to your address
      </div>
    </div>

    ${pmHtml}

    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      Please respond to this email with your preferred payment method and we will send you the payment details to proceed immediately.
    </p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      Thank you for your cooperation and continued trust in ZipCargo.
    </p>
    <p style="color:#1e293b;font-size:14px;">
      Best regards,<br/>
      <strong>ZipCargo Logistics Team</strong><br/>
      <a href="mailto:${siteEmail}" style="color:#e8820c;">${siteEmail}</a>
    </p>
  </div>
  <div class="zc-footer" bgcolor="#0d1f35" style="background:#0d1f35;padding:16px 28px;text-align:center;">
    <div style="color:#aac4e0;font-size:11px;">ZipCargo Logistics &#8212; Delivering trust, one shipment at a time</div>
        <div style="color:#4a6a88;font-size:10px;margin-top:4px;">Your official insurance invoice is attached to this email.</div>
  </div>
</div>
</body></html>`;

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept':'application/json','api-key':apiKey,'content-type':'application/json' },
      body: JSON.stringify({
        sender: { name: 'ZipCargo Logistics', email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        to: [{ email: shipment.rEmail, name: shipment.rName }],
        replyTo: { email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        subject: `Insurance Registration Required — ${shipment.tracking}`,
        htmlContent: emailHtml,
        trackingSettings: { clickTracking: { enabled: false }, openTracking: { enabled: false } },
        attachment: [{
          name: `ZipCargo-Insurance-Invoice-${shipment.tracking}.pdf`,
          content: pdfBuffer.toString('base64'),
        }],
      }),
    });

    const data = await brevoRes.json();
    if (!brevoRes.ok) throw new Error(data.message || 'Brevo error');
    res.json({ success: true });

  } catch(err) {
    console.error('Insurance invoice error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



// ── Delivery Authorization Invoice ───────────────────────────────────────
app.post('/api/email/delivery-auth', async (req, res) => {
  try {
    const { shipment, fee, paymentMethods, settings } = req.body;
    if (!shipment || !shipment.rEmail) return res.status(400).json({ error: 'Missing data.' });

    const apiKey   = process.env.BREVO_API_KEY;
    if (!apiKey) return res.json({ error: 'Email not configured.' });

    const siteEmail = (settings && settings.email) || process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com';
    const authFee   = parseFloat(fee) || 300;
    const invoiceNo = 'ZDA-' + Date.now().toString().slice(-8);
    const issueDate = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });

    const PDFDocument = require('pdfkit');
    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = 595, pad = 36, cW = W - pad * 2;
      doc.rect(0, 0, W, 842).fill('#ffffff');
      doc.rect(pad, 24, cW, 3).fill('#e8820c');

      // Header
      doc.roundedRect(pad, 27, cW, 88, 8).fill('#0d1f35');
      // ZipCargo logo PNG
      try {
        const logoPath = require('path').join(__dirname, 'public', 'logo-light.png');
        doc.image(logoPath, pad + 14, 38, { height: 44 });
      } catch(e) {
        // Fallback text logo if image fails
        doc.roundedRect(pad + 14, 42, 32, 32, 6).fill('#e8820c');
        doc.fill('white').fontSize(13).font('Helvetica-Bold').text('ZC', pad + 18, 50);
        doc.fill('white').fontSize(16).font('Helvetica-Bold').text('ZipCargo', pad + 54, 43);
        doc.fill('#aac4e0').fontSize(9).font('Helvetica').text('Global Logistics Solutions', pad + 54, 63);
      }
      doc.fill('#e8820c').fontSize(7).font('Helvetica-Bold')
         .text('D E L I V E R Y  A U T H O R I Z A T I O N', 0, 38, { align: 'right', width: W - pad - 16 });
      doc.fill('#7a9ab8').fontSize(8).font('Helvetica')
         .text('Invoice No: ' + invoiceNo, 0, 52, { align: 'right', width: W - pad - 16 });
      doc.fill('white').fontSize(11).font('Helvetica-Bold')
         .text(shipment.tracking, 0, 65, { align: 'right', width: W - pad - 16 });
      doc.fill('#7a9ab8').fontSize(8)
         .text('Issued: ' + issueDate, 0, 81, { align: 'right', width: W - pad - 16 });
      doc.roundedRect(pad + 14, 87, 130, 18, 9).fill('#16a34a');
      doc.fill('white').fontSize(8).font('Helvetica-Bold')
         .text('DEPOSIT FULLY REFUNDABLE', pad + 14, 93, { width: 130, align: 'center' });

      // Client info
      let y = 130;
      doc.roundedRect(pad, y, cW, 44, 6).fill('#f8fafc').stroke('#e2e8f0');
      doc.fill('#94a3b8').fontSize(7).font('Helvetica-Bold').text('BILL TO', pad + 14, y + 8);
      doc.fill('#0d1f35').fontSize(10).font('Helvetica-Bold').text(shipment.rName, pad + 14, y + 19);
      doc.fill('#64748b').fontSize(8).font('Helvetica').text(shipment.rEmail, pad + 14, y + 31);
      doc.fill('#94a3b8').fontSize(7).font('Helvetica-Bold').text('SHIPMENT REF', 0, y + 8, { align: 'right', width: W - pad - 16 });
      doc.fill('#0d1f35').fontSize(10).font('Helvetica-Bold').text(shipment.tracking, 0, y + 19, { align: 'right', width: W - pad - 16 });
      doc.fill('#64748b').fontSize(8).font('Helvetica').text((shipment.origin||'-') + ' to ' + (shipment.dest||'-'), 0, y + 31, { align: 'right', width: W - pad - 16 });

      // Table header
      y += 50;
      doc.roundedRect(pad, y, cW, 22, 3).fill('#0d1f35');
      doc.fill('white').fontSize(8).font('Helvetica-Bold').text('DESCRIPTION', pad + 14, y + 7);
      doc.fill('white').fontSize(8).text('AMOUNT', 0, y + 7, { align: 'right', width: W - pad - 14 });

      // Line item
      y += 22;
      doc.rect(pad, y, cW, 36).fill('white').stroke('#e2e8f0');
      doc.fill('#0d1f35').fontSize(9).font('Helvetica-Bold').text('City Delivery Authorization Deposit', pad + 14, y + 7);
      doc.fill('#64748b').fontSize(7).font('Helvetica')
         .text('Refundable deposit for city delivery clearance — ' + (shipment.description || 'pet') + ' transport to ' + (shipment.dest||'destination'), pad + 14, y + 20, { width: cW - 100 });
      doc.fill('#0d1f35').fontSize(13).font('Helvetica-Bold')
         .text('$' + authFee.toFixed(2), 0, y + 12, { align: 'right', width: W - pad - 14 });

      // Refund row
      y += 36;
      doc.rect(pad, y, cW, 18).fill('#f0fdf4').stroke('#bbf7d0');
      doc.fill('#15803d').fontSize(7.5).font('Helvetica-Bold')
         .text('Refund Policy: Deposit is fully refunded upon successful arrival and handover of your pet', pad + 14, y + 5);

      // Status notice
      y += 22;
      doc.roundedRect(pad, y, cW, 42, 4).fill('#fef3c7').stroke('#fcd34d');
      doc.fill('#92400e').fontSize(8).font('Helvetica-Bold').text('SHIPMENT STATUS NOTICE', pad + 14, y + 8);
      doc.fill('#78350f').fontSize(7.5).font('Helvetica')
         .text('Your shipment is currently on hold pending delivery authorization verification. Your ' + (shipment.description || 'pet') + ' remains safe, secure, and under professional care throughout this process.', pad + 14, y + 21, { width: cW - 28 });

      // What happens next
      y += 48;
      doc.roundedRect(pad, y, cW, 48, 4).fill('#f0f7ff').stroke('#bfdbfe');
      doc.fill('#1d4ed8').fontSize(8).font('Helvetica-Bold').text('WHAT HAPPENS NEXT', pad + 14, y + 8);
      doc.fill('#1e40af').fontSize(7.5).font('Helvetica')
         .text('1. Submit the authorization deposit payment\n2. Our team completes the city delivery authorization review\n3. Final delivery is scheduled to your address\n4. Deposit is fully refunded upon successful delivery', pad + 14, y + 21, { width: cW - 28 });

      // Action required
      y += 54;
      doc.roundedRect(pad, y, cW, 20, 3).fill('#fef2f2').stroke('#fecaca');
      doc.fill('#dc2626').fontSize(8).font('Helvetica-Bold').text('ACTION REQUIRED: ', pad + 14, y + 6, { continued: true });
      doc.fill('#991b1b').fontSize(8).font('Helvetica').text('Please reply with your preferred payment method to proceed.');

      // Payment methods
      if (paymentMethods && paymentMethods.trim()) {
        y += 26;
        doc.roundedRect(pad, y, cW, 20, 3).fill('#0d1f35');
        doc.fill('white').fontSize(8).font('Helvetica-Bold').text('AVAILABLE PAYMENT METHODS', pad + 14, y + 6);
        y += 20;
        const pmLines = paymentMethods.trim().split(/\r?\n/).filter(l => l.trim());
        const pmH = Math.max(pmLines.length * 14 + 14, 32);
        doc.rect(pad, y, cW, pmH).fill('#f8fafc').stroke('#e2e8f0');
        pmLines.forEach((line, i) => {
          doc.fill('#0d1f35').fontSize(8).font('Helvetica-Bold')
             .text('• ' + line.trim(), pad + 14, y + 7 + i * 14, { width: cW - 28 });
        });
        y += pmH;
        doc.rect(pad, y, cW, 16).fill('#fff7ed').stroke('#fed7aa');
        doc.fill('#9a3412').fontSize(7).font('Helvetica')
           .text('Payment details provided upon confirmation of your choice.', pad + 14, y + 4);
        y += 16;
      }

      // Total
      y += 8;
      doc.roundedRect(pad, y, cW, 34, 5).fill('#0d1f35');
      doc.fill('#aac4e0').fontSize(8).font('Helvetica').text('TOTAL DEPOSIT AMOUNT', pad + 14, y + 8);
      doc.fill('#7a9ab8').fontSize(7).text('Fully refundable upon successful delivery', pad + 14, y + 20);
      doc.fill('#e8820c').fontSize(18).font('Helvetica-Bold')
         .text('$' + authFee.toFixed(2), 0, y + 7, { align: 'right', width: W - pad - 14 });

      // Stamp + Terms
      y += 42;
      const scx = W - pad - 52, scy = y + 50;
      doc.circle(scx, scy, 48).lineWidth(4).stroke('#16a34a');
      doc.circle(scx, scy, 40).lineWidth(1.5).stroke('#16a34a');
      for (let a = 0; a < 360; a += 20) {
        const rad = a * Math.PI / 180;
        doc.circle(scx + 44 * Math.cos(rad), scy + 44 * Math.sin(rad), 1.5).fill('#16a34a');
      }
      doc.fill('#16a34a').fontSize(8).font('Helvetica-Bold').text('FULLY', scx - 32, scy - 15, { width: 64, align: 'center' });
      doc.fill('#16a34a').fontSize(9).font('Helvetica-Bold').text('REFUNDABLE', scx - 32, scy - 2, { width: 64, align: 'center' });
      doc.fill('#16a34a').fontSize(6).font('Helvetica').text('ZIPCARGO CERTIFIED', scx - 32, scy + 11, { width: 64, align: 'center' });

      // Terms
      doc.fill('#64748b').fontSize(7.5).font('Helvetica-Bold').text('Terms & Conditions:', pad + 14, y + 6);
      doc.fill('#64748b').fontSize(7).font('Helvetica')
         .text('1. Deposit is required to initiate delivery authorization review.\n2. Full $' + authFee.toFixed(2) + ' refunded upon successful delivery and handover.\n3. Shipment remains on hold until authorization is complete.\n4. Reply with preferred payment method to proceed.', pad + 14, y + 19, { width: cW - 120, lineBreak: true });

      // Footer
      y += 112;
      doc.roundedRect(pad, y, cW, 36, 5).fill('white').stroke('#e2e8f0');
      doc.roundedRect(pad + 10, y + 6, 22, 22, 4).fill('#0d1f35');
      doc.fill('#e8820c').fontSize(10).font('Helvetica-Bold').text('ZC', pad + 14, y + 12);
      doc.fill('#0d1f35').fontSize(9).font('Helvetica-Bold').text('ZipCargo Logistics', pad + 40, y + 8);
      doc.fill('#94a3b8').fontSize(7.5).font('Helvetica').text('Ship Smarter. Deliver Faster.', pad + 40, y + 20);
      doc.fill('#94a3b8').fontSize(6.5).text(invoiceNo + '  •  ' + issueDate, 0, y + 22, { align: 'right', width: W - pad - 14 });
      doc.rect(pad, y + 36, cW, 3).fill('#e8820c');

      doc.end();
    });

    // Email
    const pmHtml = (() => {
      if (!paymentMethods || !paymentMethods.trim()) return '';
      const lines = paymentMethods.trim().split(/\r?\n/).filter(l => l.trim());
      const items = lines.map(l => '<div style="color:#0d1f35;font-size:13px;padding:4px 0;font-weight:600;">&#8226; ' + l.trim() + '</div>').join('');
      return '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0;"><div style="color:#0d1f35;font-size:12px;font-weight:700;letter-spacing:.5px;margin-bottom:10px;">AVAILABLE PAYMENT METHODS</div>' + items + '<div style="color:#94a3b8;font-size:11px;margin-top:10px;font-style:italic;">Payment details will be sent to you upon confirmation of your choice.</div></div>';
    })();

    const emailHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="color-scheme" content="light only"/>
<meta name="supported-color-schemes" content="light only"/>
<meta name="x-apple-disable-message-reformatting"/>
<style>
body{margin:0;padding:0;background:#f3f4f6;font-family:Helvetica,Arial,sans-serif;}
</style>
</head>
<body class="body" bgcolor="#f3f4f6" style="margin:0;padding:20px;background:#f3f4f6;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
  <div class="zc-header" bgcolor="#0d1f35" style="background:#0d1f35;padding:24px 28px;">
    <img src="https://zipcargologistics.com/logo-light-email.png" alt="ZipCargo" style="height:64px;display:block;"/>
    <div style="color:#aac4e0;font-size:12px;margin-top:8px;">Delivery Authorization Notice</div>
  </div>
  <div style="padding:28px;background:#ffffff;">
    <p style="color:#0d1f35;font-size:15px;">Dear <strong>${shipment.rName}</strong>,</p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      We are writing to provide an important update regarding your pet's shipment, which is currently in transit to your delivery address.
    </p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      During a routine transit and documentation review, our logistics team identified that additional <strong>city delivery authorization</strong> may be required prior to final delivery scheduling. As a result, the shipment is temporarily on hold pending verification.
    </p>

    <div style="background:#fef3c7;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:16px;margin:16px 0;">
      <div style="color:#92400e;font-size:13px;font-weight:800;margin-bottom:6px;">&#9888; Shipment On Hold</div>
      <div style="color:#78350f;font-size:13px;line-height:1.7;">
        Your <strong>${shipment.description || 'pet'}</strong> remains safe, secure, and under professional care. Once the authorization review is completed, final delivery arrangements will proceed accordingly.
      </div>
    </div>

    <div style="background:#f0fdf4;border:2px solid #16a34a;border-radius:10px;padding:16px;text-align:center;margin:20px 0;">
      <div style="color:#64748b;font-size:11px;font-weight:700;letter-spacing:1px;">CITY DELIVERY AUTHORIZATION DEPOSIT</div>
      <div style="color:#16a34a;font-size:28px;font-weight:800;margin-top:6px;">$${authFee.toFixed(2)}</div>
      <div style="color:#15803d;font-size:12px;font-weight:700;margin-top:4px;">100% FULLY REFUNDABLE</div>
      <div style="color:#64748b;font-size:11px;margin-top:4px;">Refunded immediately upon successful delivery and handover</div>
    </div>

    <div style="background:#f0f7ff;border-left:4px solid #2563eb;border-radius:0 8px 8px 0;padding:16px;margin:16px 0;">
      <div style="color:#1d4ed8;font-size:13px;font-weight:800;margin-bottom:8px;">What Happens Next</div>
      <div style="color:#1e40af;font-size:13px;line-height:1.8;">
        1. Submit the authorization deposit payment<br/>
        2. Our team completes the city delivery authorization review<br/>
        3. Final delivery is scheduled to your address<br/>
        4. Deposit is fully refunded upon successful delivery
      </div>
    </div>

    ${pmHtml}

    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      Please respond to this email with your preferred payment method and we will send you the payment details to proceed immediately.
    </p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      We appreciate your patience and understanding.
    </p>
    <p style="color:#1e293b;font-size:14px;">
      Sincerely,<br/>
      <strong>Logistics & Pet Transport Coordination Team</strong><br/>
      <strong>ZipCargo</strong><br/>
      <a href="mailto:${siteEmail}" style="color:#e8820c;">${siteEmail}</a>
    </p>
  </div>
  <div class="zc-footer" bgcolor="#0d1f35" style="background:#0d1f35;padding:16px 28px;text-align:center;">
    <div style="color:#aac4e0;font-size:11px;">ZipCargo Logistics &#8212; Delivering trust, one shipment at a time</div>
        <div style="color:#4a6a88;font-size:10px;margin-top:4px;">Your official authorization invoice is attached to this email.</div>
  </div>
</div>
</body></html>`;

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept':'application/json','api-key':apiKey,'content-type':'application/json' },
      body: JSON.stringify({
        sender: { name: 'ZipCargo Logistics', email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        to: [{ email: shipment.rEmail, name: shipment.rName }],
        replyTo: { email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        subject: `Delivery Authorization Required — ${shipment.tracking}`,
        htmlContent: emailHtml,
        trackingSettings: { clickTracking: { enabled: false }, openTracking: { enabled: false } },
        attachment: [{
          name: `ZipCargo-Delivery-Auth-${shipment.tracking}.pdf`,
          content: pdfBuffer.toString('base64'),
        }],
      }),
    });

    const data = await brevoRes.json();
    if (!brevoRes.ok) throw new Error(data.message || 'Brevo error');
    res.json({ success: true });

  } catch(err) {
    console.error('Delivery auth error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Pet Travel Permit Invoice ─────────────────────────────────────────────
app.post('/api/email/travel-permit', async (req, res) => {
  try {
    const { shipment, fee, paymentMethods, settings } = req.body;
    if (!shipment || !shipment.rEmail) return res.status(400).json({ error: 'Missing data.' });

    const apiKey    = process.env.BREVO_API_KEY;
    if (!apiKey) return res.json({ error: 'Email not configured.' });

    const siteEmail  = (settings && settings.email) || process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com';
    const permitFee  = parseFloat(fee) || 100;
    const invoiceNo  = 'ZTP-' + Date.now().toString().slice(-8);
    const issueDate  = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });

    const PDFDocument = require('pdfkit');
    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = 595, pad = 36, cW = W - pad * 2;
      doc.rect(0, 0, W, 842).fill('#ffffff');
      doc.rect(pad, 24, cW, 3).fill('#e8820c');

      // Header
      doc.roundedRect(pad, 27, cW, 88, 8).fill('#0d1f35');
      // ZipCargo logo PNG
      try {
        const logoPath = require('path').join(__dirname, 'public', 'logo-light.png');
        doc.image(logoPath, pad + 14, 38, { height: 44 });
      } catch(e) {
        // Fallback text logo if image fails
        doc.roundedRect(pad + 14, 42, 32, 32, 6).fill('#e8820c');
        doc.fill('white').fontSize(13).font('Helvetica-Bold').text('ZC', pad + 18, 50);
        doc.fill('white').fontSize(16).font('Helvetica-Bold').text('ZipCargo', pad + 54, 43);
        doc.fill('#aac4e0').fontSize(9).font('Helvetica').text('Global Logistics Solutions', pad + 54, 63);
      }
      doc.fill('#e8820c').fontSize(7).font('Helvetica-Bold')
         .text('P E T  T R A V E L  P E R M I T', 0, 38, { align: 'right', width: W - pad - 16 });
      doc.fill('#7a9ab8').fontSize(8).font('Helvetica')
         .text('Invoice No: ' + invoiceNo, 0, 52, { align: 'right', width: W - pad - 16 });
      doc.fill('white').fontSize(11).font('Helvetica-Bold')
         .text(shipment.tracking, 0, 65, { align: 'right', width: W - pad - 16 });
      doc.fill('#7a9ab8').fontSize(8)
         .text('Issued: ' + issueDate, 0, 81, { align: 'right', width: W - pad - 16 });
      doc.roundedRect(pad + 14, 87, 120, 18, 9).fill('#16a34a');
      doc.fill('white').fontSize(8).font('Helvetica-Bold')
         .text('FULLY REFUNDABLE', pad + 14, 93, { width: 120, align: 'center' });

      // Client info
      let y = 130;
      doc.roundedRect(pad, y, cW, 44, 6).fill('#f8fafc').stroke('#e2e8f0');
      doc.fill('#94a3b8').fontSize(7).font('Helvetica-Bold').text('BILL TO', pad + 14, y + 8);
      doc.fill('#0d1f35').fontSize(10).font('Helvetica-Bold').text(shipment.rName, pad + 14, y + 19);
      doc.fill('#64748b').fontSize(8).font('Helvetica').text(shipment.rEmail, pad + 14, y + 31);
      doc.fill('#94a3b8').fontSize(7).font('Helvetica-Bold').text('SHIPMENT REF', 0, y + 8, { align: 'right', width: W - pad - 16 });
      doc.fill('#0d1f35').fontSize(10).font('Helvetica-Bold').text(shipment.tracking, 0, y + 19, { align: 'right', width: W - pad - 16 });
      doc.fill('#64748b').fontSize(8).font('Helvetica').text((shipment.origin||'-') + ' to ' + (shipment.dest||'-'), 0, y + 31, { align: 'right', width: W - pad - 16 });

      // Table header
      y += 50;
      doc.roundedRect(pad, y, cW, 22, 3).fill('#0d1f35');
      doc.fill('white').fontSize(8).font('Helvetica-Bold').text('DESCRIPTION', pad + 14, y + 7);
      doc.fill('white').fontSize(8).text('AMOUNT', 0, y + 7, { align: 'right', width: W - pad - 14 });

      // Line item
      y += 22;
      doc.rect(pad, y, cW, 36).fill('white').stroke('#e2e8f0');
      doc.fill('#0d1f35').fontSize(9).font('Helvetica-Bold').text('Pet Travel Permit Processing Fee', pad + 14, y + 7);
      doc.fill('#64748b').fontSize(7).font('Helvetica')
         .text('Official travel permit issuance and processing for ' + (shipment.description || 'pet') + ' — ' + (shipment.origin||'-') + ' to ' + (shipment.dest||'-'), pad + 14, y + 20, { width: cW - 100 });
      doc.fill('#0d1f35').fontSize(13).font('Helvetica-Bold')
         .text('$' + permitFee.toFixed(2), 0, y + 12, { align: 'right', width: W - pad - 14 });

      // Refund row
      y += 36;
      doc.rect(pad, y, cW, 18).fill('#f0fdf4').stroke('#bbf7d0');
      doc.fill('#15803d').fontSize(7.5).font('Helvetica-Bold')
         .text('Refund Policy: 100% refunded immediately upon successful delivery of your pet', pad + 14, y + 5);

      // Why required + What is included (two columns)
      y += 22;
      const halfW = cW / 2 - 4;
      doc.roundedRect(pad, y, halfW, 62, 4).fill('#f0f7ff').stroke('#bfdbfe');
      doc.fill('#1d4ed8').fontSize(8).font('Helvetica-Bold').text('WHY IT IS REQUIRED', pad + 10, y + 8);
      doc.fill('#1e40af').fontSize(7).font('Helvetica')
         .text('International pet transport regulations require an official travel permit before crossing borders. This ensures your pet meets all entry requirements at the destination country.', pad + 10, y + 21, { width: halfW - 20 });

      doc.roundedRect(pad + halfW + 8, y, halfW, 62, 4).fill('#fff7ed').stroke('#fed7aa');
      doc.fill('#ea580c').fontSize(8).font('Helvetica-Bold').text('WHAT IS INCLUDED', pad + halfW + 18, y + 8);
      doc.fill('#9a3412').fontSize(7).font('Helvetica')
         .text('• Official permit documentation\n• Border crossing clearance\n• Destination country compliance\n• ZipCargo permit seal & registration', pad + halfW + 18, y + 21, { width: halfW - 20 });

      // Action required
      y += 68;
      doc.roundedRect(pad, y, cW, 20, 3).fill('#fef2f2').stroke('#fecaca');
      doc.fill('#dc2626').fontSize(8).font('Helvetica-Bold').text('ACTION REQUIRED: ', pad + 14, y + 6, { continued: true });
      doc.fill('#991b1b').fontSize(8).font('Helvetica').text('Please reply with your preferred payment method to proceed.');

      // Payment methods
      if (paymentMethods && paymentMethods.trim()) {
        y += 26;
        doc.roundedRect(pad, y, cW, 20, 3).fill('#0d1f35');
        doc.fill('white').fontSize(8).font('Helvetica-Bold').text('AVAILABLE PAYMENT METHODS', pad + 14, y + 6);
        y += 20;
        const pmLines = paymentMethods.trim().split(/\r?\n/).filter(l => l.trim());
        const pmH = Math.max(pmLines.length * 14 + 14, 32);
        doc.rect(pad, y, cW, pmH).fill('#f8fafc').stroke('#e2e8f0');
        pmLines.forEach((line, i) => {
          doc.fill('#0d1f35').fontSize(8).font('Helvetica-Bold')
             .text('• ' + line.trim(), pad + 14, y + 7 + i * 14, { width: cW - 28 });
        });
        y += pmH;
        doc.rect(pad, y, cW, 16).fill('#fff7ed').stroke('#fed7aa');
        doc.fill('#9a3412').fontSize(7).font('Helvetica')
           .text('Payment details provided upon confirmation of your choice.', pad + 14, y + 4);
        y += 16;
      }

      // Total
      y += 8;
      doc.roundedRect(pad, y, cW, 34, 5).fill('#0d1f35');
      doc.fill('#aac4e0').fontSize(8).font('Helvetica').text('TOTAL PERMIT FEE', pad + 14, y + 8);
      doc.fill('#7a9ab8').fontSize(7).text('100% refundable upon successful delivery', pad + 14, y + 20);
      doc.fill('#e8820c').fontSize(18).font('Helvetica-Bold')
         .text('$' + permitFee.toFixed(2), 0, y + 7, { align: 'right', width: W - pad - 14 });

      // Stamp + Terms
      y += 42;
      const scx = W - pad - 52, scy = y + 50;
      doc.circle(scx, scy, 48).lineWidth(4).stroke('#16a34a');
      doc.circle(scx, scy, 40).lineWidth(1.5).stroke('#16a34a');
      for (let a = 0; a < 360; a += 20) {
        const rad = a * Math.PI / 180;
        doc.circle(scx + 44 * Math.cos(rad), scy + 44 * Math.sin(rad), 1.5).fill('#16a34a');
      }
      doc.fill('#16a34a').fontSize(8).font('Helvetica-Bold').text('FULLY', scx - 32, scy - 15, { width: 64, align: 'center' });
      doc.fill('#16a34a').fontSize(9).font('Helvetica-Bold').text('REFUNDABLE', scx - 32, scy - 2, { width: 64, align: 'center' });
      doc.fill('#16a34a').fontSize(6).font('Helvetica').text('ZIPCARGO CERTIFIED', scx - 32, scy + 11, { width: 64, align: 'center' });

      // Terms
      doc.fill('#64748b').fontSize(7.5).font('Helvetica-Bold').text('Terms & Conditions:', pad + 14, y + 6);
      doc.fill('#64748b').fontSize(7).font('Helvetica')
         .text('1. Permit fee required before processing can begin.\n2. Full $' + permitFee.toFixed(2) + ' refunded upon successful delivery.\n3. Permit is valid for the specified shipment route only.\n4. Reply with preferred payment method to proceed.', pad + 14, y + 19, { width: cW - 120, lineBreak: true });

      // Footer
      y += 112;
      doc.roundedRect(pad, y, cW, 36, 5).fill('white').stroke('#e2e8f0');
      doc.roundedRect(pad + 10, y + 6, 22, 22, 4).fill('#0d1f35');
      doc.fill('#e8820c').fontSize(10).font('Helvetica-Bold').text('ZC', pad + 14, y + 12);
      doc.fill('#0d1f35').fontSize(9).font('Helvetica-Bold').text('ZipCargo Logistics', pad + 40, y + 8);
      doc.fill('#94a3b8').fontSize(7.5).font('Helvetica').text('Ship Smarter. Deliver Faster.', pad + 40, y + 20);
      doc.fill('#94a3b8').fontSize(6.5).text(invoiceNo + '  •  ' + issueDate, 0, y + 22, { align: 'right', width: W - pad - 14 });
      doc.rect(pad, y + 36, cW, 3).fill('#e8820c');

      doc.end();
    });

    // Email
    const pmHtml = (() => {
      if (!paymentMethods || !paymentMethods.trim()) return '';
      const lines = paymentMethods.trim().split(/\r?\n/).filter(l => l.trim());
      const items = lines.map(l => '<div style="color:#0d1f35;font-size:13px;padding:4px 0;font-weight:600;">&#8226; ' + l.trim() + '</div>').join('');
      return '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0;"><div style="color:#0d1f35;font-size:12px;font-weight:700;letter-spacing:.5px;margin-bottom:10px;">AVAILABLE PAYMENT METHODS</div>' + items + '<div style="color:#94a3b8;font-size:11px;margin-top:10px;font-style:italic;">Payment details will be sent to you upon confirmation of your choice.</div></div>';
    })();

    const emailHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="color-scheme" content="light only"/>
<meta name="supported-color-schemes" content="light only"/>
<meta name="x-apple-disable-message-reformatting"/>
<style>
body{margin:0;padding:0;background:#f3f4f6;font-family:Helvetica,Arial,sans-serif;}
</style>
</head>
<body class="body" bgcolor="#f3f4f6" style="margin:0;padding:20px;background:#f3f4f6;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
  <div class="zc-header" bgcolor="#0d1f35" style="background:#0d1f35;padding:24px 28px;">
    <img src="https://zipcargologistics.com/logo-light-email.png" alt="ZipCargo" style="height:64px;display:block;"/>
    <div style="color:#aac4e0;font-size:12px;margin-top:8px;">Pet Travel Permit Notice</div>
  </div>
  <div style="padding:28px;background:#ffffff;">
    <p style="color:#0d1f35;font-size:15px;">Dear <strong>${shipment.rName}</strong>,</p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      We are writing regarding your pet shipment currently being processed for delivery. During our final documentation review, our compliance team identified that an official <strong>Pet Travel Permit</strong> is required before your ${shipment.description || 'pet'} can be cleared for international transport to ${shipment.dest || 'the destination'}.
    </p>

    <div style="background:#f0f7ff;border-left:4px solid #2563eb;border-radius:0 8px 8px 0;padding:16px;margin:16px 0;">
      <div style="color:#1d4ed8;font-size:13px;font-weight:800;margin-bottom:8px;">Why This Is Required</div>
      <div style="color:#1e40af;font-size:13px;line-height:1.8;">
        International pet transport regulations require an official travel permit before crossing borders. This document ensures your pet meets all entry requirements at the destination country and is legally cleared for transport under international animal welfare standards.
      </div>
    </div>

    <div style="background:#f0fdf4;border:2px solid #16a34a;border-radius:10px;padding:16px;text-align:center;margin:20px 0;">
      <div style="color:#64748b;font-size:11px;font-weight:700;letter-spacing:1px;">PET TRAVEL PERMIT PROCESSING FEE</div>
      <div style="color:#16a34a;font-size:28px;font-weight:800;margin-top:6px;">$${permitFee.toFixed(2)}</div>
      <div style="color:#15803d;font-size:12px;font-weight:700;margin-top:4px;">100% FULLY REFUNDABLE</div>
      <div style="color:#64748b;font-size:11px;margin-top:4px;">Refunded immediately upon successful delivery of your pet</div>
    </div>

    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0;">
      <div style="color:#0d1f35;font-size:13px;font-weight:800;margin-bottom:8px;">What Is Included</div>
      <div style="color:#1e293b;font-size:13px;line-height:1.8;">
        &#8226; Official travel permit documentation<br/>
        &#8226; Border crossing clearance authorization<br/>
        &#8226; Destination country compliance certification<br/>
        &#8226; ZipCargo permit seal and registration
      </div>
    </div>

    ${pmHtml}

    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      Please respond to this email with your preferred payment method and we will send you the payment details to proceed. Once the permit fee is received, we will immediately begin processing your pet's travel permit and schedule delivery.
    </p>
    <p style="color:#1e293b;font-size:14px;line-height:1.8;">
      We appreciate your prompt attention to this matter and look forward to completing the delivery of your ${shipment.description || 'pet'} safely and on time.
    </p>
    <p style="color:#1e293b;font-size:14px;">
      Warm regards,<br/>
      <strong>ZipCargo Pet Transport Division</strong><br/>
      <strong>ZipCargo Logistics</strong><br/>
      <a href="mailto:${siteEmail}" style="color:#e8820c;">${siteEmail}</a>
    </p>
  </div>
  <div class="zc-footer" bgcolor="#0d1f35" style="background:#0d1f35;padding:16px 28px;text-align:center;">
    <div style="color:#aac4e0;font-size:11px;">ZipCargo Logistics &#8212; Delivering trust, one shipment at a time</div>
        <div style="color:#4a6a88;font-size:10px;margin-top:4px;">Your official pet travel permit invoice is attached to this email.</div>
  </div>
</div>
</body></html>`;

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept':'application/json','api-key':apiKey,'content-type':'application/json' },
      body: JSON.stringify({
        sender: { name: 'ZipCargo Logistics', email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        to: [{ email: shipment.rEmail, name: shipment.rName }],
        replyTo: { email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        subject: `Pet Travel Permit Required — ${shipment.tracking}`,
        htmlContent: emailHtml,
        trackingSettings: { clickTracking: { enabled: false }, openTracking: { enabled: false } },
        attachment: [{
          name: `ZipCargo-Travel-Permit-${shipment.tracking}.pdf`,
          content: pdfBuffer.toString('base64'),
        }],
      }),
    });

    const data = await brevoRes.json();
    if (!brevoRes.ok) throw new Error(data.message || 'Brevo error');
    res.json({ success: true });

  } catch(err) {
    console.error('Travel permit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Test email config ─────────────────────────────────────────────────────
app.get('/api/email/test', async (req, res) => {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey) {
    return res.json({ ok: false, error: 'Missing BREVO_API_KEY env var' });
  }
  try {
    // Test by calling Brevo account info endpoint
    const r = await fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': apiKey, 'accept': 'application/json' }
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || 'Brevo API error');
    res.json({ ok: true, message: 'Brevo API connected!', email: d.email, plan: d.plan?.[0]?.type });
  } catch(err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Shipment notification email with professional PDF ────────────────────
app.post('/api/email/shipment', async (req, res) => {
  try {
    const { shipment } = req.body;
    if (!shipment || !shipment.rEmail) {
      return res.status(400).json({ error: 'Missing shipment data or recipient email.' });
    }

    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) return res.json({ error: 'Email service not configured.' });

    // Clean siteUrl — always use the correct URL
    const rawUrl = (req.body.settings && req.body.settings.website) || process.env.SITE_URL || 'https://zipcargologistics.com';
    // Strip ALL protocol prefixes then add https:// once
    const cleanedUrl = rawUrl.replace(/^(https?:\/\/)+/, '').replace(/\/$/, '');
    const siteUrl = 'https://' + cleanedUrl;
    const siteEmail = (req.body.settings && req.body.settings.email)   || process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com';
    const sitePhone = (req.body.settings && req.body.settings.phone)   || '';
    const displayUrl = siteUrl.replace(/^https?:\/\//, '');
    const receiptNo  = 'ZCR-' + new Date().getFullYear() + '-' + (shipment.tracking||'').replace('ZC-','').replace(/-/g,'').slice(-6);
    const issueDate  = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });

    // ── Build PDF ──────────────────────────────────────────────────────────
    const PDFDocument = require('pdfkit');
    const QRCode = require('qrcode');

    const qrBuffer = await QRCode.toBuffer(siteUrl + '/tracking.html?id=' + shipment.tracking, {
      width: 90, margin: 1, color: { dark: '#0d1f35', light: '#ffffff' }
    });

    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = 595, pad = 36, cW = W - pad * 2;

      // White background
      doc.rect(0, 0, W, 842).fill('#ffffff');

      // ── HEADER ──
      // Orange top border
      doc.rect(pad, 24, cW, 3).fill('#e8820c');

      // Dark header card
      doc.roundedRect(pad, 27, cW, 88, 8).fill('#0d1f35');

      // Logo image
      try {
        const logoPath = require('path').join(__dirname, 'public', 'logo-light.png');
        doc.image(logoPath, pad + 14, 38, { height: 44 });
      } catch(e) {
        doc.roundedRect(pad + 14, 42, 32, 32, 6).fill('#e8820c');
        doc.fill('white').fontSize(14).font('Helvetica-Bold').text('ZC', pad + 18, 50, { lineBreak: false });
        doc.fill('white').fontSize(16).font('Helvetica-Bold').text('ZipCargo', pad + 54, 43);
        doc.fill('#aac4e0').fontSize(9).font('Helvetica').text('Global Logistics Solutions', pad + 54, 63);
      }

      // Receipt info (right side)
      doc.fill('#e8820c').fontSize(7).font('Helvetica-Bold')
         .text('O F F I C I A L  R E C E I P T', 0, 38, { align: 'right', width: W - pad - 16 });
      doc.fill('#7a9ab8').fontSize(8).font('Helvetica')
         .text('Receipt No: ' + receiptNo, 0, 52, { align: 'right', width: W - pad - 16 });
      doc.fill('white').fontSize(14).font('Helvetica-Bold')
         .text(shipment.tracking, 0, 65, { align: 'right', width: W - pad - 16 });
      doc.fill('#7a9ab8').fontSize(8).font('Helvetica')
         .text('Issued: ' + issueDate, 0, 83, { align: 'right', width: W - pad - 16 });

      // Status pill
      const sColors = { 'Delivered':'#16a34a','In Transit':'#2563eb','Pending':'#f59e0b','On Hold':'#ef4444','Out for Delivery':'#8b5cf6' };
      doc.roundedRect(pad + 14, 87, 68, 18, 9).fill(sColors[shipment.status] || '#64748b');
      doc.fill('white').fontSize(8).font('Helvetica-Bold')
         .text(shipment.status || 'Pending', pad + 14, 93, { width: 68, align: 'center' });

      // ── ROUTE ──
      let y = 128;
      doc.roundedRect(pad, y, cW, 48, 6).fill('#f8fafc').stroke('#e2e8f0');
      doc.fill('#94a3b8').fontSize(8).font('Helvetica').text('ORIGIN', pad + 14, y + 10);
      doc.fill('#0d1f35').fontSize(12).font('Helvetica-Bold').text(String(shipment.origin||'-'), pad + 14, y + 22);
      doc.fill('#94a3b8').fontSize(8).text('DESTINATION', 0, y + 10, { align: 'right', width: W - pad - 14 });
      doc.fill('#0d1f35').fontSize(12).font('Helvetica-Bold').text(String(shipment.dest||'-'), 0, y + 22, { align: 'right', width: W - pad - 14 });
      // Arrow
      doc.moveTo(W/2 - 18, y + 28).lineTo(W/2 + 2, y + 28).stroke('#e8820c');
      doc.moveTo(W/2 - 2, y + 22).lineTo(W/2 + 10, y + 28).lineTo(W/2 - 2, y + 34).fill('#e8820c');

      // ── PROGRESS ──
      y += 58;
      doc.roundedRect(pad, y, cW, 58, 6).fill('white').stroke('#e2e8f0');
      doc.fill('#64748b').fontSize(8).font('Helvetica-Bold').text('SHIPMENT PROGRESS', pad + 14, y + 10);

      const stages = ['Order Placed', 'In Transit', 'Out for Delivery', 'Delivered'];
      const sIdx = { 'Pending':0,'In Transit':1,'Out for Delivery':2,'Delivered':3,'On Hold':0 };
      const cur = sIdx[shipment.status] ?? 0;
      const sw = cW / stages.length;

      // Draw connecting line first
      doc.moveTo(pad + sw/2, y + 34).lineTo(pad + cW - sw/2, y + 34).stroke('#e2e8f0');

      stages.forEach((st, i) => {
        const sx = pad + sw * i + sw / 2;
        const active = i <= cur;
        const current = i === cur;

        // Active line segment
        if (i < cur) {
          doc.moveTo(sx, y + 34).lineTo(pad + sw * (i+1) + sw/2, y + 34)
             .lineWidth(3).stroke('#e8820c');
        }

        // Circle
        if (current) {
          doc.circle(sx, y + 34, 10).fill('#e8820c');
          doc.circle(sx, y + 34, 5).fill('white');
        } else if (active) {
          doc.circle(sx, y + 34, 7).fill('#e8820c');
        } else {
          doc.circle(sx, y + 34, 7).fill('#e2e8f0');
        }

        // Label
        doc.fill(current ? '#e8820c' : active ? '#0d1f35' : '#94a3b8')
           .fontSize(6.5).font(current ? 'Helvetica-Bold' : 'Helvetica')
           .text(st, sx - sw/2 + 4, y + 46, { width: sw - 8, align: 'center' });
      });

      // ── SENDER / RECIPIENT ──
      y += 66;
      doc.roundedRect(pad, y, cW, 72, 6).fill('white').stroke('#e2e8f0');

      // Left: Sender
      doc.fill('#94a3b8').fontSize(8).font('Helvetica-Bold').text('SENDER', pad + 14, y + 10);
      doc.moveTo(pad + 14, y + 22).lineTo(pad + cW/2 - 8, y + 22).lineWidth(0.5).stroke('#f1f5f9');
      [['Name', shipment.sName], ['Phone', shipment.sPhone], ['Email', shipment.sEmail]]
        .forEach(([l, v], i) => {
          if (!v) return;
          doc.fill('#94a3b8').fontSize(7).font('Helvetica').text(l, pad + 14, y + 28 + i * 15);
          doc.fill('#0d1f35').fontSize(8).font('Helvetica-Bold').text(String(v).substring(0,26), pad + 50, y + 28 + i * 15);
        });

      // Divider
      doc.moveTo(pad + cW/2, y + 8).lineTo(pad + cW/2, y + 64).lineWidth(0.5).stroke('#f1f5f9');

      // Right: Recipient
      const rx = pad + cW/2 + 10;
      doc.fill('#94a3b8').fontSize(8).font('Helvetica-Bold').text('RECIPIENT', rx, y + 10);
      doc.moveTo(rx, y + 22).lineTo(pad + cW - 8, y + 22).lineWidth(0.5).stroke('#f1f5f9');
      [['Name', shipment.rName], ['Phone', shipment.rPhone], ['Email', shipment.rEmail]]
        .forEach(([l, v], i) => {
          if (!v) return;
          doc.fill('#94a3b8').fontSize(7).font('Helvetica').text(l, rx, y + 28 + i * 15);
          doc.fill('#0d1f35').fontSize(8).font('Helvetica-Bold').text(String(v).substring(0,26), rx + 50, y + 28 + i * 15);
        });

      // ── PACKAGE / DELIVERY ──
      y += 80;
      const hasDeliveryAddr = !!(shipment.deliveryAddress && String(shipment.deliveryAddress).trim());
      const cardH = hasDeliveryAddr ? 106 : 84;
      doc.roundedRect(pad, y, cW, cardH, 6).fill('white').stroke('#e2e8f0');

      // Left: Package
      doc.fill('#94a3b8').fontSize(8).font('Helvetica-Bold').text('PACKAGE', pad + 14, y + 10);
      doc.moveTo(pad + 14, y + 22).lineTo(pad + cW/2 - 8, y + 22).lineWidth(0.5).stroke('#f1f5f9');
      [['Service', shipment.service], ['Weight', shipment.weight ? shipment.weight+' kg' : null],
       ['Declared Value', shipment.value ? '$'+shipment.value : null], ['Description', shipment.description]]
        .forEach(([l, v], i) => {
          if (!v) return;
          doc.fill('#94a3b8').fontSize(7).font('Helvetica').text(l, pad + 14, y + 28 + i * 15);
          doc.fill('#0d1f35').fontSize(8).font('Helvetica-Bold').text(String(v).substring(0,20), pad + 72, y + 28 + i * 15);
        });

      // Divider
      doc.moveTo(pad + cW/2, y + 8).lineTo(pad + cW/2, y + cardH - 8).lineWidth(0.5).stroke('#f1f5f9');

      // Right: Delivery
      doc.fill('#94a3b8').fontSize(8).font('Helvetica-Bold').text('DELIVERY', rx, y + 10);
      doc.moveTo(rx, y + 22).lineTo(pad + cW - 8, y + 22).lineWidth(0.5).stroke('#f1f5f9');
      const delRows = [];
      if (hasDeliveryAddr) delRows.push(['Delivery Addr.', String(shipment.deliveryAddress).trim()]);
      delRows.push(['Est. Delivery', shipment.eta]);
      delRows.push(['Current Location', shipment.location]);
      delRows.push(['Status', shipment.status]);
      delRows.push(['Date Issued', issueDate]);

      delRows.slice(0, 5).forEach(([l, v], i) => {
        if (!v) return;
        doc.fill('#94a3b8').fontSize(7).font('Helvetica').text(l, rx, y + 28 + i * 14);
        const valStr = String(v).substring(0, 45);
        doc.fill('#0d1f35').fontSize(7.5).font('Helvetica-Bold')
           .text(valStr, rx + 72, y + 28 + i * 14, { width: cW/2 - 84, lineBreak: false });
      });

      // ── COST BANNER ──
      y += cardH + 8;
      doc.roundedRect(pad, y, cW, 38, 6).fill('#0d1f35');
      doc.fill('#aac4e0').fontSize(8).font('Helvetica').text('TOTAL SHIPPING COST', pad + 14, y + 10);
      doc.fill('#64748b').fontSize(7).text('Inclusive of all applicable fees', pad + 14, y + 23);
      const cost = shipment.cost ? '$' + parseFloat(shipment.cost).toFixed(2) : (shipment.value ? '$' + parseFloat(shipment.value).toFixed(2) : 'TBD');
      doc.fill('#e8820c').fontSize(20).font('Helvetica-Bold').text(cost, 0, y + 8, { align: 'right', width: W - pad - 16 });

      // ── FOOTER ──
      y += 46;
      doc.roundedRect(pad, y, cW, 62, 6).fill('white').stroke('#e2e8f0');

      // Logo
      doc.roundedRect(pad + 12, y + 16, 26, 26, 5).fill('#0d1f35');
      doc.fill('#e8820c').fontSize(11).font('Helvetica-Bold').text('ZC', pad + 16, y + 22, { lineBreak: false });
      doc.fill('#0d1f35').fontSize(11).font('Helvetica-Bold').text('ZipCargo Logistics', pad + 46, y + 15);
      doc.fill('#94a3b8').fontSize(8).font('Helvetica').text('Ship Smarter. Deliver Faster.', pad + 46, y + 29);
      doc.fill('#94a3b8').fontSize(7).text('Please retain for your records', pad + 46, y + 43);
      doc.fill('#94a3b8').fontSize(6.5).text(shipment.tracking + '  •  ' + receiptNo, pad + 46, y + 53);

      // QR code
      doc.image(qrBuffer, W - pad - 62, y + 5, { width: 52, height: 52 });
      doc.fill('#94a3b8').fontSize(6).text('Scan to track', W - pad - 62, y + 58, { width: 52, align: 'center' });

      // Bottom border
      doc.rect(pad, y + 62, cW, 3).fill('#e8820c');

      doc.end();
    });

    // ── Send email with PDF ────────────────────────────────────────────────
    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'ZipCargo Logistics', email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        to: [{ email: shipment.rEmail, name: shipment.rName }],
        replyTo: { email: process.env.BREVO_SENDER_EMAIL || 'zipcargo99@gmail.com' },
        subject: `Your ZipCargo Shipment — ${shipment.tracking}`,
        trackingSettings: {
          clickTracking: { enabled: false },
          openTracking: { enabled: false },
        },
        htmlContent: `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light only"/>
<meta name="supported-color-schemes" content="light only"/>
<meta name="x-apple-disable-message-reformatting"/>
<style>
  body { margin:0; padding:0; background:#f3f4f6; font-family:Helvetica,Arial,sans-serif; }
  a { color:#e8820c; }
</style>
</head>
<body class="body" bgcolor="#f3f4f6" style="margin:0;padding:20px;background:#f3f4f6;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">

  <!-- Header -->
  <div class="zc-header" bgcolor="#0d1f35" style="background:#0d1f35;padding:24px 28px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <img src="https://zipcargologistics.com/logo-light-email.png" alt="ZipCargo" style="height:64px;display:block;"/>
        <div style="color:#aac4e0;font-size:12px;font-family:Helvetica,Arial,sans-serif;margin-top:8px;">Global Logistics Solutions</div>
      </td>
    </tr></table>
  </div>

  <!-- Body -->
  <div style="padding:28px;background:#ffffff;">
    <p style="color:#0d1f35;font-size:15px;font-family:Helvetica,Arial,sans-serif;">Dear <strong>${shipment.rName}</strong>,</p>
    <p style="color:#1e293b;font-size:14px;line-height:1.7;font-family:Helvetica,Arial,sans-serif;">
      Warm regards from the team at <strong>ZipCargo!</strong><br/>
      We are pleased to inform you that a package has been successfully registered in your name.
    </p>

    <!-- Tracking Number Box -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      <tr>
        <td bgcolor="#f0f7ff" style="background:#f0f7ff;border:2px solid #0d1f35;border-radius:10px;padding:16px;text-align:center;">
          <div style="color:#64748b;font-size:11px;font-weight:700;letter-spacing:1px;font-family:Helvetica,Arial,sans-serif;">TRACKING NUMBER</div>
          <div style="color:#e8820c;font-size:24px;font-weight:800;letter-spacing:2px;margin-top:6px;font-family:Helvetica,Arial,sans-serif;">${shipment.tracking}</div>
        </td>
      </tr>
    </table>

    <p style="color:#1e293b;font-size:14px;line-height:1.7;font-family:Helvetica,Arial,sans-serif;">
      To verify the details and track the status of your shipment, kindly visit our website at:
    </p>

    <!-- Track Button -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      <tr>
        <td align="center">
          <a href="https://zipcargologistics.com/tracking.html?id=${shipment.tracking}"
             style="background:#e8820c;color:#ffffff;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;font-family:Helvetica,Arial,sans-serif;">
            Track Your Shipment &#8594;
          </a>
        </td>
      </tr>
    </table>

    <p style="color:#64748b;font-size:12px;text-align:center;font-family:Helvetica,Arial,sans-serif;">
      Or visit: https://zipcargologistics.com/tracking.html<br/>
      and enter your tracking number: <strong>${shipment.tracking}</strong>
    </p>

    <!-- Shipment Summary -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border:1px solid #e2e8f0;border-radius:8px;">
      <tr><td style="padding:14px 16px;background:#f8fafc;border-radius:8px 8px 0 0;">
        <div style="color:#0d1f35;font-size:12px;font-weight:700;letter-spacing:.5px;font-family:Helvetica,Arial,sans-serif;">SHIPMENT SUMMARY</div>
      </td></tr>
      <tr><td style="padding:0 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;font-family:Helvetica,Arial,sans-serif;">
          <tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:8px 0;color:#64748b;">Status</td><td style="padding:8px 0;color:#0d1f35;font-weight:700;">${shipment.status||'Pending'}</td></tr>
          <tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:8px 0;color:#64748b;">Service</td><td style="padding:8px 0;color:#0d1f35;font-weight:700;">${shipment.service}</td></tr>
          <tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:8px 0;color:#64748b;">From</td><td style="padding:8px 0;color:#0d1f35;font-weight:700;">${shipment.origin}</td></tr>
          <tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:8px 0;color:#64748b;">To</td><td style="padding:8px 0;color:#0d1f35;font-weight:700;">${shipment.dest}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Est. Delivery</td><td style="padding:8px 0;color:#0d1f35;font-weight:700;">${shipment.eta||'TBD'}</td></tr>
        </table>
      </td></tr>
    </table>

    <p style="color:#1e293b;font-size:13px;line-height:1.7;font-family:Helvetica,Arial,sans-serif;">
      Please reply to this email with any questions or concerns regarding your package.
      We recommend checking your email regularly for updates on the whereabouts and details of your shipment.
    </p>
    <p style="color:#1e293b;font-size:14px;font-family:Helvetica,Arial,sans-serif;">
      Thank you for choosing <strong>ZipCargo</strong>.<br/>
      Best regards,<br/>
      <strong>ZipCargo Logistics Team</strong><br/>
      <a href="mailto:${siteEmail}" style="color:#e8820c;">${siteEmail}</a>
    </p>
  </div>

  <!-- Footer -->
  <div class="zc-footer" bgcolor="#0d1f35" style="background:#0d1f35;padding:16px 28px;text-align:center;">
    <div style="color:#aac4e0;font-size:11px;font-family:Helvetica,Arial,sans-serif;">ZipCargo Logistics &#8212; Delivering trust, one shipment at a time</div>
        <div style="color:#4a6a88;font-size:10px;margin-top:4px;font-family:Helvetica,Arial,sans-serif;">This is an official ZipCargo document. Please keep for your records.</div>
  </div>

</div>
</body>
</html>`,
        attachment: [{
          name: `ZipCargo-Receipt-${shipment.tracking}.pdf`,
          content: pdfBuffer.toString('base64'),
        }],
      }),
    });

    const brevoData = await brevoRes.json();
    if (!brevoRes.ok) throw new Error(brevoData.message || 'Brevo error');
    res.json({ success: true });

  } catch (err) {
    console.error('Email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI Chat — Groq powered (free, fast, no restrictions) ─────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history, isAdmin } = req.body;
    if (!message) return res.json({ reply: 'No message received.' });

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.json({ reply: 'Our AI assistant is being set up. Please contact us at info@zipcargo.com — we respond within 24 hours!' });
    }

    // Pull persistent settings from the database — same source for every
    // browser, device, and admin session. No more localStorage drift.
    const AiSettings = require('./models/AiSettings');
    let settings = { announcements: '', restrictions: [], knowledgeNotes: '' };
    try {
      settings = await AiSettings.getSingleton();
    } catch (e) {
      console.error('AiSettings load error:', e.message);
    }

    // Restrictions are rendered as their own clearly-labeled, highest-priority
    // block — never blended into general instructions — so the model treats
    // them as hard constraints rather than suggestions.
    const restrictionsBlock = (settings.restrictions && settings.restrictions.length)
      ? `\n\nABSOLUTE RESTRICTIONS — NEVER VIOLATE THESE, EVEN IF ASKED DIRECTLY OR INDIRECTLY:\n${settings.restrictions.map((r, i) => `${i + 1}. ${r.text}`).join('\n')}\nIf a question would require violating a restriction above, politely decline and redirect the customer to contact human support at info@zipcargo.com instead of answering.`
      : '';

    const announcementsBlock = settings.announcements
      ? `\n\nCURRENT ANNOUNCEMENTS (mention naturally when relevant to the conversation):\n${settings.announcements}`
      : '';

    const knowledgeBlock = settings.knowledgeNotes
      ? `\n\nADDITIONAL CONTEXT (for your understanding, use only if relevant):\n${settings.knowledgeNotes}`
      : '';

    const adminModeBlock = isAdmin
      ? `\n\nADMIN MODE: You are speaking directly with the ZipCargo admin/owner, not a customer. Be detailed and direct. You may discuss internal operations, fee structures, and business strategy. The restrictions above still apply — they protect against accidental customer-facing disclosure even when the admin is testing.`
      : '';

    const systemText = `You are Zara, the official AI Assistant for ZipCargo Logistics. You are professional, warm, knowledgeable, and genuinely helpful. You work exclusively for ZipCargo.

ABOUT ZIPCARGO:
- Global logistics and freight company serving 150+ countries
- 99.8% on-time delivery rate
- Fully insured shipments
- 24/7 customer support
- Specializes in: cargo shipping AND live animal/pet transport
- Major hubs: New York, London, Dubai, Singapore, Sydney, Tokyo, Toronto, Miami, Shanghai

SERVICES WE OFFER:
1. Air Freight — 1-5 business days, urgent/high-value shipments, 200+ destinations
2. Sea Freight — 2-6 weeks, FCL and LCL options, best for large cargo
3. Road Transport — 1-10 days, cross-border with real-time GPS tracking
4. Express Delivery — same-day or next-day for time-critical shipments
5. Pet & Animal Transport — IATA-compliant crates, vet-approved handling, full permit/vaccine documentation
6. Warehousing — climate-controlled storage, smart inventory, fulfilment
7. Customs Clearance — full import/export documentation and compliance handled by our team

PET TRANSPORT (we specialize in this):
- We handle required documentation: health certificates, vaccination records, travel permits, import permits
- Climate-controlled, IATA-compliant crates for safe animal transport
- Dedicated pet transport coordination with vet liaison
- Available for dogs, cats, birds, exotic animals and livestock

PRICING:
- Rates depend on service type, weight, dimensions, and route
- Always direct customers to request a FREE quote via the contact form — we respond within 24 hours
- Never invent or guess exact prices without knowing the full shipment details
- Never state specific fee amounts unless they appear in the announcements or context below — if asked about fees and you don't have current information, direct the customer to the contact form

TRACKING:
- Customers can track shipments at the Tracking page on our site
- Tracking format: ZC-YYYY-NNNNN (example: ZC-2026-00123)
- Real-time updates at every stage of delivery

BEHAVIOR RULES:
- Always respond in the same language the customer uses
- Never state a fact you are not confident is true — if unsure, say you'll connect them with the team instead of guessing
- Never say "I'm an AI" — you ARE Zara from ZipCargo, but never claim certifications, statistics, or credentials not explicitly listed above
- Be warm, professional and conversational
- Use line breaks to keep responses readable
- Always end with a helpful next step or offer
- For specific shipment details, ask for the tracking number
- For quotes, direct to the contact form
- Keep responses focused and under 200 words unless detail is genuinely needed${restrictionsBlock}${announcementsBlock}${knowledgeBlock}${adminModeBlock}`;

    const messages = [
      { role: 'system', content: systemText },
      ...(Array.isArray(history) ? history : []).slice(-10).map(m => ({
        role: m.r === 'assistant' ? 'assistant' : 'user',
        content: String(m.t || '')
      })),
      { role: 'user', content: message }
    ];

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages,
        max_tokens: 800,
        temperature: 0.5
      })
    });

    const data = await groqRes.json();

    if (!groqRes.ok || !data.choices) {
      console.error('Groq error:', JSON.stringify(data).slice(0, 200));
      return res.json({ reply: "I'm having a moment — please try again, or reach us at info@zipcargo.com." });
    }

    const reply = data.choices[0]?.message?.content
      || "Could you rephrase that? I want to make sure I help you properly.";
    res.json({ reply });

  } catch (err) {
    console.error('Chat error:', err.message);
    res.json({ reply: "Something went wrong. Please try again or contact info@zipcargo.com." });
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
}));

const knownPages = ['index', 'services', 'tracking', 'about', 'testimonials', 'contact', 'admin', 'privacy', 'terms', 'cookies', 'portal'];
app.get('*', (req, res) => {
  const urlPath = req.path.replace(/^\//, '').replace(/\.html$/, '') || 'index';
  if (knownPages.includes(urlPath)) {
    return res.sendFile(path.join(__dirname, 'public', urlPath + '.html'));
  }
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 3000;
// Central error handler — must be last
app.use(errorHandler);

app.listen(PORT, () => console.log(`ZipCargo running on port ${PORT}`));

if (process.env.SITE_URL) {
  setInterval(() => {
    try {
      const u = new URL(process.env.SITE_URL + '/health');
      https.get({ hostname: u.hostname, path: u.pathname, timeout: 10000 }, r =>
        console.log(`[keep-alive] ${r.statusCode}`)
      ).on('error', e => console.warn('[keep-alive]', e.message));
    } catch {}
  }, 14 * 60 * 1000);
}
