require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const multer = require('multer');
const https = require('https');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const Puppy = require('./models/Puppy');
const Litter = require('./models/Litter');
const Contact = require('./models/Contact');
const Testimonial = require('./models/Testimonial');
const Faq = require('./models/Faq');
const Settings = require('./models/Settings');
const Post = require('./models/Post');
const Dog     = require('./models/Dog');
const Invoice     = require('./models/Invoice');
const Certificate = require('./models/Certificate');
const Application = require('./models/Application');
const Waitlist = require('./models/Waitlist');
const WaitlistInvoice = require('./models/WaitlistInvoice');
const PDFDocument = require('pdfkit');

const app = express();

// Safety net: without this, ANY unexpected error anywhere in the app (a brief
// MongoDB hiccup, a bad third-party API response, etc.) can crash the entire
// server and take the whole site down. These log the problem instead of
// crashing, so one bad request can't bring down every visitor's connection.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Prevented a crash:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Prevented a crash:', err.message);
});

// Security headers — protects against clickjacking, MIME-sniffing, and other
// common attacks. CSP is disabled because the site relies on inline scripts
// and styles throughout (chat widgets, admin dashboard); a strict CSP would
// break those without a larger rewrite. Every other protection stays active.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Rate limiters for public-facing forms — defined here, early, so they're
// available to every route below regardless of where each route is declared.

// Prevents spam/abuse on the contact form — 5 submissions per 15 min per IP
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('contact', { message: 'Too many messages sent. Please wait a few minutes and try again.', success: false });
  }
});

// Prevents spam/fake review submissions — 5 per 15 min per IP
const reviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('submit-review', { sent: false, error: 'Too many submissions. Please wait a few minutes and try again.' });
  }
});

// Prevents spam applications — 5 per 15 min per IP
const applicationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('apply', { sent: false, error: 'Too many submissions. Please wait a few minutes and try again.', puppies: [] });
  }
});

// Prevents spam waitlist signups — 5 per 15 min per IP
const waitlistLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('waitlist', { sent: false, error: 'Too many submissions. Please wait a few minutes and try again.' });
  }
});

// Prevents abuse of the AI chat, which costs API credits per message — 20 per 5 min per IP
const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ reply: "You've sent a lot of messages! Please wait a few minutes before trying again." });
  }
});

// ===== EMAIL NOTIFICATIONS via Resend =====
// Free tier: 100 emails/day, no SMTP (works on Render free plan).
// Sign up at resend.com, verify your email, get your API key,
// then add RESEND_API_KEY to Render environment variables.
const NOTIFY_EMAIL = 'shantibryan644@gmail.com';

console.log('[email] RESEND_API_KEY set:', !!process.env.RESEND_API_KEY);

async function sendNotification(subject, html) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[email] RESEND_API_KEY not set — notification skipped:', subject);
    return;
  }
  try {
    console.log('[email] Attempting to send:', subject);
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: '"Shanti and Bryan Pinscher Kennel" <info@shantibryankennel.com>',
        to: [NOTIFY_EMAIL],
        subject,
        html
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || JSON.stringify(data));
    console.log('[email] SUCCESS — id:', data.id);
  } catch (err) {
    console.error('[email] FAILED —', err.message);
  }
}

// Sends a warm, branded confirmation email to a client right after they submit
// the contact form, letting them know their message was received.
async function sendClientAutoReply(name, email, subject) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[email] RESEND_API_KEY not set — auto-reply skipped');
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: '"Shanti and Bryan Pinscher Kennel" <info@shantibryankennel.com>',
        to: [email],
        replyTo: NOTIFY_EMAIL,
        subject: `We've received your message — Shanti and Bryan Pinscher Kennel`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
            <div style="background:#7a1e1e;padding:26px 30px;border-radius:8px 8px 0 0;text-align:center;">
              <h1 style="color:#fff;margin:0;font-size:19px;">Thank You for Reaching Out!</h1>
              <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:12px;">Shanti and Bryan Pinscher Kennel</p>
            </div>
            <div style="background:#fff;padding:26px 30px;border:1px solid #e6ddc8;">
              <p style="color:#1e293b;font-size:14px;">Hi <strong>${name}</strong>,</p>
              <p style="color:#4a5568;font-size:14px;line-height:1.6;">Thank you for contacting Shanti and Bryan Pinscher Kennel! We've received your message${subject ? ` about "<strong>${subject}</strong>"` : ''} and a member of our team will get back to you personally, usually within 24 hours.</p>
              <div style="background:#f9f7f4;border:1px solid #ece5d8;border-radius:8px;padding:16px 18px;margin:18px 0;">
                <p style="margin:0 0 8px;color:#7a1e1e;font-weight:700;font-size:13px;">While you wait, feel free to:</p>
                <p style="margin:0 0 6px;font-size:13px;"><a href="https://shantibryankennel.com/puppies" style="color:#7a1e1e;text-decoration:none;">🐾 Browse our available puppies</a></p>
                <p style="margin:0 0 6px;font-size:13px;"><a href="https://shantibryankennel.com/faq" style="color:#7a1e1e;text-decoration:none;">❓ Check our frequently asked questions</a></p>
                <p style="margin:0;font-size:13px;"><a href="https://shantibryankennel.com/testimonials" style="color:#7a1e1e;text-decoration:none;">⭐ Read reviews from happy families</a></p>
              </div>
              <p style="color:#4a5568;font-size:13px;">If your inquiry is urgent, you can reply directly to this email.</p>
              <p style="color:#4a5568;font-size:14px;margin-top:20px;">With love,<br><strong>Shanti and Bryan Pinscher Kennel</strong></p>
            </div>
            <div style="background:#f0ece3;padding:12px 30px;text-align:center;border-radius:0 0 8px 8px;">
              <p style="margin:0;color:#9ca3af;font-size:10px;">shantibryankennel.com | info@shantibryankennel.com</p>
            </div>
          </div>`
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || JSON.stringify(data));
    console.log('[email] Auto-reply sent to', email, '— id:', data.id);
  } catch (err) {
    console.error('[email] Auto-reply FAILED —', err.message);
  }
}

// Confirms receipt of a puppy application to the applicant
async function sendApplicationAutoReply(name, email) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: '"Shanti and Bryan Pinscher Kennel" <info@shantibryankennel.com>',
        to: [email],
        replyTo: NOTIFY_EMAIL,
        subject: `We've received your application — Shanti and Bryan Pinscher Kennel`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
            <div style="background:#7a1e1e;padding:26px 30px;border-radius:8px 8px 0 0;text-align:center;">
              <h1 style="color:#fff;margin:0;font-size:19px;">Application Received!</h1>
              <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:12px;">Shanti and Bryan Pinscher Kennel</p>
            </div>
            <div style="background:#fff;padding:26px 30px;border:1px solid #e6ddc8;">
              <p style="color:#1e293b;font-size:14px;">Hi <strong>${name}</strong>,</p>
              <p style="color:#4a5568;font-size:14px;line-height:1.6;">Thank you for applying to adopt a puppy from Shanti and Bryan Pinscher Kennel! We take great care in reviewing every application personally to make sure our puppies go to the right homes.</p>
              <p style="color:#4a5568;font-size:14px;line-height:1.6;">We will review your application and reach out within 2-3 days with next steps.</p>
              <p style="color:#4a5568;font-size:13px;">If you have any questions in the meantime, feel free to reply directly to this email.</p>
              <p style="color:#4a5568;font-size:14px;margin-top:20px;">With love,<br><strong>Shanti and Bryan Pinscher Kennel</strong></p>
            </div>
            <div style="background:#f0ece3;padding:12px 30px;text-align:center;border-radius:0 0 8px 8px;">
              <p style="margin:0;color:#9ca3af;font-size:10px;">shantibryankennel.com | info@shantibryankennel.com</p>
            </div>
          </div>`
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || JSON.stringify(data));
    console.log('[email] Application auto-reply sent to', email);
  } catch (err) {
    console.error('[email] Application auto-reply FAILED —', err.message);
  }
}

// Confirms a waitlist request and explains that a deposit is required to activate it
async function sendWaitlistAutoReply(name, email) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: '"Shanti and Bryan Pinscher Kennel" <info@shantibryankennel.com>',
        to: [email],
        replyTo: NOTIFY_EMAIL,
        subject: `We've received your waitlist request — Shanti and Bryan Pinscher Kennel`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
            <div style="background:#7a1e1e;padding:26px 30px;border-radius:8px 8px 0 0;text-align:center;">
              <h1 style="color:#fff;margin:0;font-size:19px;">Waitlist Request Received!</h1>
              <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:12px;">Shanti and Bryan Pinscher Kennel</p>
            </div>
            <div style="background:#fff;padding:26px 30px;border:1px solid #e6ddc8;">
              <p style="color:#1e293b;font-size:14px;">Hi <strong>${name}</strong>,</p>
              <p style="color:#4a5568;font-size:14px;line-height:1.6;">Thank you for your interest in joining our waitlist for an upcoming litter!</p>
              <div style="background:#fff8f0;border:2px solid #7a1e1e;border-radius:8px;padding:16px 18px;margin:18px 0;">
                <p style="margin:0 0 8px;color:#7a1e1e;font-size:14px;font-weight:700;">✍️ Next Step: Deposit Required</p>
                <p style="margin:0;color:#4a5568;font-size:13px;line-height:1.6;">To secure an active spot on our waitlist, a deposit is required. We will personally reach out within 2-3 days to arrange this with you. Once received, your place will be confirmed and the deposit applied toward your future puppy.</p>
              </div>
              <p style="color:#4a5568;font-size:13px;">If you have any questions in the meantime, feel free to reply directly to this email.</p>
              <p style="color:#4a5568;font-size:14px;margin-top:20px;">With love,<br><strong>Shanti and Bryan Pinscher Kennel</strong></p>
            </div>
            <div style="background:#f0ece3;padding:12px 30px;text-align:center;border-radius:0 0 8px 8px;">
              <p style="margin:0;color:#9ca3af;font-size:10px;">shantibryankennel.com | info@shantibryankennel.com</p>
            </div>
          </div>`
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || JSON.stringify(data));
    console.log('[email] Waitlist auto-reply sent to', email);
  } catch (err) {
    console.error('[email] Waitlist auto-reply FAILED —', err.message);
  }
}

// Logs the real error for debugging, but never exposes raw error details
// (stack traces, database messages, etc.) to whoever is looking at the page.
function adminError(res, context, err) {
  if (err) console.error(context, err);
  res.status(500).send(`
    <div style="font-family:'Poppins',sans-serif;max-width:480px;margin:80px auto;text-align:center;padding:32px;background:#151b26;color:#fff;border-radius:14px;border:1px solid #1f2733;">
      <h2 style="color:#e8848f;margin-bottom:12px;">Something Went Wrong</h2>
      <p style="color:#c5cdd8;margin-bottom:24px;">We couldn't complete that action. Please try again, and if it keeps happening, double-check your connection or try again in a moment.</p>
      <a href="/admin/dashboard" style="display:inline-block;background:#c9a227;color:#0d1117;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Back to Dashboard</a>
    </div>
  `);
}
// Render sits in front of this app behind one reverse proxy hop. Trusting
// exactly that one hop gives accurate visitor IPs (used for rate limiting and
// location detection) without letting a spoofed header fake a different IP.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'shanti-bryan-kennel',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp']
  }
});
const upload = multer({ storage: storage });

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static + body parsing
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Lightweight health-check (used by the keep-alive self-ping below, and can
// also be pointed to by an external uptime monitor like UptimeRobot or cron-job.org)
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// Sessions — stored in MongoDB instead of server memory, so logins survive
// server restarts and redeploys (previously everyone was logged out on every deploy).
if (!process.env.SESSION_SECRET) {
  console.warn('[security] SESSION_SECRET is not set in your environment variables. Using a random secret generated for this run instead. Set SESSION_SECRET in Render for consistent session encryption across restarts.');
}
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: 'sessions',
    ttl: 14 * 24 * 60 * 60 // sessions expire after 14 days of inactivity
  }),
  cookie: {
    maxAge: 14 * 24 * 60 * 60 * 1000 // 14 days
  }
}));

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

// Auth middleware
function requireLogin(req, res, next) {
  if (req.session.isAdmin) {
    next();
  } else {
    res.redirect('/admin/login');
  }
}

// Helper for litter photo fields
const litterUpload = upload.fields([
  { name: 'photos', maxCount: 20 },
  { name: 'sirePhoto', maxCount: 1 },
  { name: 'damPhoto', maxCount: 1 }
]);

// Turns a title into a URL-friendly slug
// Removes <think>...</think> reasoning blocks that thinking-mode models
// sometimes include in their output — visitors should only see the final answer.
// Auto-detects a visitor's approximate location from their IP address.
// Best-effort — never throws, just returns '' on any failure.
async function detectLocation(req) {
  try {
    let ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
    ip = ip.replace('::ffff:', '');
    if (ip && ip !== '127.0.0.1' && ip !== '::1' && !ip.startsWith('192.168.') && !ip.startsWith('10.')) {
      const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city`);
      const geo = await geoRes.json();
      if (geo && geo.status === 'success') {
        return [geo.city, geo.regionName, geo.country].filter(Boolean).join(', ');
      }
    }
  } catch (geoErr) {
    console.log('Geo lookup skipped:', geoErr.message);
  }
  return '';
}

// Calls Groq's chat completions API, automatically retrying once if we hit
// their per-minute rate limit — Groq's error tells us exactly how long to
// wait, so we parse that and retry instead of just failing.
async function callGroqWithRetry(apiKey, body) {
  const doCall = async () => {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return { res, data };
  };

  let { res, data } = await doCall();

  if (!res.ok && res.status === 429) {
    const msg = data?.error?.message || '';
    const match = msg.match(/try again in ([\d.]+)s/i);
    const waitSeconds = match ? Math.min(parseFloat(match[1]) + 0.5, 20) : 5;
    console.log(`[groq] Rate limited, waiting ${waitSeconds.toFixed(1)}s before retry...`);
    await new Promise(r => setTimeout(r, waitSeconds * 1000));
    ({ res, data } = await doCall());
  }

  return { res, data };
}

function stripThinking(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function makeSlug(title) {
  return title.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// Always returns the single settings document, creating it if missing
async function getSettings() {
  let settings = await Settings.findOne();
  if (!settings) settings = await Settings.create({});
  return settings;
}

// Checks a plain-text password against, in order of preference:
// 1) the hash stored in the database (set via Admin Settings > Change Password)
// 2) the ADMIN_PASSWORD_HASH environment variable
// 3) the plain ADMIN_PASSWORD environment variable (legacy fallback)
async function verifyAdminPassword(plainPassword, settings) {
  if (settings && settings.adminPasswordHash) {
    return bcrypt.compare(plainPassword, settings.adminPasswordHash);
  }
  if (process.env.ADMIN_PASSWORD_HASH) {
    return bcrypt.compare(plainPassword, process.env.ADMIN_PASSWORD_HASH);
  }
  if (process.env.ADMIN_PASSWORD) {
    return plainPassword === process.env.ADMIN_PASSWORD;
  }
  return false;
}

// Make settings available to ALL views automatically
app.use(async (req, res, next) => {
  try {
    res.locals.settings = await getSettings();
    res.locals.reqPath = req.path;
  } catch (err) {
    res.locals.settings = {};
    res.locals.reqPath = req.path;
  }
  next();
});

// ===== PUBLIC ROUTES =====
app.get('/', async (req, res) => {
  try {
    const featuredPuppies = await Puppy.find({ status: 'Available' }).sort({ createdAt: -1 }).limit(3);
    const testimonials = await Testimonial.find({ approved: true }).sort({ createdAt: -1 }).limit(3);
    const dogs = await Dog.find().sort({ order: 1, createdAt: 1 });
    res.render('home', { featuredPuppies, testimonials, dogs, description: 'Home-raised Miniature Pinscher puppies placed in loving families worldwide. Health guaranteed, fully vaccinated, and socialized with daily care.' });
  } catch (err) {
    console.error(err);
    res.render('home', { featuredPuppies: [], testimonials: [], dogs: [] });
  }
});

app.get('/puppies', async (req, res) => {
  try {
    const puppies = await Puppy.find().sort({ createdAt: -1 });
    res.render('puppies', { puppies });
  } catch (err) {
    console.error(err);
    res.render('puppies', { puppies: [] });
  }
});

app.get('/puppies/:id', async (req, res) => {
  try {
    const puppy = await Puppy.findById(req.params.id);
    if (!puppy) return res.redirect('/puppies');
    res.render('puppy-detail', { puppy, description: `Meet ${puppy.name} — a ${puppy.color} ${puppy.gender} Miniature Pinscher available from Shanti and Bryan Pinscher Kennel. ${puppy.description ? puppy.description.substring(0, 100) : ''}`, ogImg: puppy.photos && puppy.photos.length > 0 ? puppy.photos[0] : '' });
  } catch (err) {
    console.error(err);
    res.redirect('/puppies');
  }
});

app.get('/litters', async (req, res) => {
  try {
    const litters = await Litter.find().sort({ createdAt: -1 });
    res.render('litters', { litters });
  } catch (err) {
    console.error(err);
    res.render('litters', { litters: [] });
  }
});

app.get('/litters/:id', async (req, res) => {
  try {
    const litter = await Litter.findById(req.params.id);
    if (!litter) return res.redirect('/litters');
    res.render('litter-detail', { litter });
  } catch (err) {
    console.error(err);
    res.redirect('/litters');
  }
});

// ===== PUBLIC REVIEW SUBMISSION =====
app.get('/submit-review', (req, res) => {
  res.render('submit-review', { sent: false, error: '' });
});

app.post('/submit-review', reviewLimiter, upload.single('photo'), async (req, res) => {
  try {
    const { customerName, location, tag, rating, message } = req.body;
    if (!customerName || !message) {
      return res.render('submit-review', { sent: false, error: 'Please fill in your name and message.' });
    }
    const testimonial = new Testimonial({
      customerName,
      location: location || '',
      tag: tag || '',
      rating: parseInt(rating) || 5,
      message,
      photo: req.file ? req.file.path : '',
      approved: false
    });
    await testimonial.save();

    // Notify you by email
    const stars = '⭐'.repeat(parseInt(rating) || 5);
    sendNotification(
      `⭐ New Review from ${customerName} — Needs Approval`,
      `<div style="font-family:Arial,sans-serif;max-width:580px;">
        <h2 style="color:#7a1e1e;">New Review Submitted</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;font-weight:bold;color:#555;width:100px;">Name</td><td style="padding:8px 0;">${customerName}</td></tr>
          ${location ? `<tr><td style="padding:8px 0;font-weight:bold;color:#555;">Location</td><td style="padding:8px 0;">${location}</td></tr>` : ''}
          ${tag ? `<tr><td style="padding:8px 0;font-weight:bold;color:#555;">Tag</td><td style="padding:8px 0;">${tag}</td></tr>` : ''}
          <tr><td style="padding:8px 0;font-weight:bold;color:#555;">Rating</td><td style="padding:8px 0;">${stars}</td></tr>
        </table>
        <div style="margin-top:16px;padding:16px;background:#f9f9f9;border-left:4px solid #c9a227;border-radius:4px;">
          <p style="margin:0;white-space:pre-wrap;">${message}</p>
        </div>
        <p style="margin-top:20px;"><a href="https://shantibryankennel.com/admin/testimonials" style="background:#c9a227;color:#0d1117;padding:10px 20px;text-decoration:none;border-radius:6px;font-weight:bold;">Approve or Reject in Admin</a></p>
      </div>`
    );

    res.render('submit-review', { sent: true, error: '' });
  } catch (err) {
    console.error('SUBMIT REVIEW ERROR:', err);
    res.render('submit-review', { sent: false, error: 'Something went wrong. Please try again.' });
  }
});

// ===== PUPPY APPLICATION =====
app.get('/apply', async (req, res) => {
  try {
    const puppies = await Puppy.find({ status: { $ne: 'Sold' } }).sort({ createdAt: -1 });
    res.render('apply', { sent: false, error: '', puppies });
  } catch (err) {
    console.error(err);
    res.render('apply', { sent: false, error: '', puppies: [] });
  }
});

app.post('/apply', applicationLimiter, async (req, res) => {
  try {
    const data = req.body;
    if (!data.applicantName || !data.email || !data.homeOwnership) {
      const puppies = await Puppy.find({ status: { $ne: 'Sold' } }).sort({ createdAt: -1 });
      return res.render('apply', { sent: false, error: 'Please fill in all required fields.', puppies });
    }

    const detectedLocation = await detectLocation(req);

    const application = await Application.create({
      applicantName: data.applicantName,
      email: data.email,
      phone: data.phone || '',
      location: data.location || '',
      detectedLocation,
      interestedIn: data.interestedIn || 'General / Future Litter',
      homeOwnership: data.homeOwnership,
      landlordApproval: data.landlordApproval || 'N/A',
      yardOrExercise: data.yardOrExercise || '',
      otherPets: data.otherPets || '',
      previousExperience: data.previousExperience || '',
      childrenInHome: data.childrenInHome || '',
      primaryCaretaker: data.primaryCaretaker || '',
      whyMinPin: data.whyMinPin || '',
      readyForResponsibility: data.readyForResponsibility === 'yes',
      status: 'Pending'
    });

    // Notify Bryan
    sendNotification(
      `📋 New Puppy Application from ${application.applicantName}`,
      `<div style="font-family:Arial,sans-serif;max-width:580px;">
        <h2 style="color:#7a1e1e;">New Puppy Application</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;font-weight:bold;color:#555;width:130px;">Name</td><td style="padding:8px 0;">${application.applicantName}</td></tr>
          <tr><td style="padding:8px 0;font-weight:bold;color:#555;">Email</td><td style="padding:8px 0;"><a href="mailto:${application.email}">${application.email}</a></td></tr>
          <tr><td style="padding:8px 0;font-weight:bold;color:#555;">Interested In</td><td style="padding:8px 0;">${application.interestedIn}</td></tr>
          <tr><td style="padding:8px 0;font-weight:bold;color:#555;">Home</td><td style="padding:8px 0;">${application.homeOwnership}</td></tr>
        </table>
        <p style="margin-top:20px;"><a href="https://shantibryankennel.com/admin/applications" style="background:#c9a227;color:#0d1117;padding:10px 20px;text-decoration:none;border-radius:6px;font-weight:bold;">Review Application</a></p>
      </div>`
    );

    // Confirm to applicant
    sendApplicationAutoReply(application.applicantName, application.email);

    res.render('apply', { sent: true, error: '', puppies: [] });
  } catch (err) {
    console.error('APPLICATION ERROR:', err);
    const puppies = await Puppy.find({ status: { $ne: 'Sold' } }).sort({ createdAt: -1 }).catch(() => []);
    res.render('apply', { sent: false, error: 'Something went wrong. Please try again.', puppies });
  }
});

// ===== PUPPY WAITLIST =====
app.get('/waitlist', (req, res) => {
  res.render('waitlist', { sent: false, error: '' });
});

app.post('/waitlist', waitlistLimiter, async (req, res) => {
  try {
    const data = req.body;
    if (!data.name || !data.email) {
      return res.render('waitlist', { sent: false, error: 'Please fill in your name and email.' });
    }

    const detectedLocation = await detectLocation(req);

    const entry = await Waitlist.create({
      name: data.name,
      email: data.email,
      phone: data.phone || '',
      location: data.location || '',
      detectedLocation,
      preferredGender: data.preferredGender || 'No preference',
      preferredColor: data.preferredColor || 'No preference',
      notes: data.notes || '',
      status: 'Pending Deposit'
    });

    sendNotification(
      `📋 New Waitlist Request from ${entry.name}`,
      `<div style="font-family:Arial,sans-serif;max-width:580px;">
        <h2 style="color:#7a1e1e;">New Waitlist Request</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;font-weight:bold;color:#555;width:130px;">Name</td><td style="padding:8px 0;">${entry.name}</td></tr>
          <tr><td style="padding:8px 0;font-weight:bold;color:#555;">Email</td><td style="padding:8px 0;"><a href="mailto:${entry.email}">${entry.email}</a></td></tr>
          <tr><td style="padding:8px 0;font-weight:bold;color:#555;">Wants</td><td style="padding:8px 0;">${entry.preferredGender}, ${entry.preferredColor}</td></tr>
        </table>
        <p style="margin-top:20px;color:#7a8494;font-size:13px;">A deposit is required before this request becomes active on the waitlist.</p>
        <p style="margin-top:14px;"><a href="https://shantibryankennel.com/admin/waitlist" style="background:#c9a227;color:#0d1117;padding:10px 20px;text-decoration:none;border-radius:6px;font-weight:bold;">Review in Admin</a></p>
      </div>`
    );

    sendWaitlistAutoReply(entry.name, entry.email);

    res.render('waitlist', { sent: true, error: '' });
  } catch (err) {
    console.error('WAITLIST ERROR:', err);
    res.render('waitlist', { sent: false, error: 'Something went wrong. Please try again.' });
  }
});

app.get('/testimonials', async (req, res) => {
  try {
    const testimonials = await Testimonial.find({ approved: true }).sort({ createdAt: -1 });
    res.render('testimonials', { testimonials });
  } catch (err) {
    console.error(err);
    res.render('testimonials', { testimonials: [] });
  }
});

app.get('/faq', async (req, res) => {
  try {
    const faqs = await Faq.find().sort({ order: 1, createdAt: 1 });
    res.render('faq', { faqs });
  } catch (err) {
    console.error(err);
    res.render('faq', { faqs: [] });
  }
});

app.get('/privacy', (req, res) => {
  res.render('privacy');
});

app.get('/blog', async (req, res) => {
  try {
    const posts = await Post.find({ published: true }).sort({ createdAt: -1 });
    res.render('blog', { posts });
  } catch (err) {
    console.error(err);
    res.render('blog', { posts: [] });
  }
});

app.get('/blog/:slug', async (req, res) => {
  try {
    const post = await Post.findOne({ slug: req.params.slug });
    if (!post) return res.redirect('/blog');
    res.render('post-detail', { post });
  } catch (err) {
    console.error(err);
    res.redirect('/blog');
  }
});

app.get('/deposit', (req, res) => {
  res.render('deposit');
});

app.get('/process', (req, res) => {
  res.render('process');
});

app.get('/our-dogs', async (req, res) => {
  try {
    const dogs = await Dog.find().sort({ order: 1, createdAt: 1 });
    res.render('our-dogs', { dogs });
  } catch (err) {
    console.error(err);
    res.render('our-dogs', { dogs: [] });
  }
});

app.get('/seed-faqs', async (req, res) => {
  try {
    await Faq.deleteMany({});
    await Faq.insertMany([
      { question: 'How much do your puppies cost?', answer: 'Our puppy prices vary depending on bloodline, conformation, and availability. Please contact us for current pricing on available puppies.', order: 1 },
      { question: 'Are the puppies vaccinated and dewormed?', answer: 'Yes. All our puppies are up to date on age-appropriate vaccinations and deworming before going to their new homes, and come with a health record.', order: 2 },
      { question: 'Do you offer delivery?', answer: 'Yes, we offer safe delivery arrangements. Delivery options and costs depend on your location — please contact us to discuss.', order: 3 },
      { question: 'Are your puppies registered?', answer: 'Our puppies come from quality bloodlines. Registration details are available per litter — please ask us about a specific puppy.', order: 4 },
      { question: 'Do you offer a health guarantee?', answer: 'Yes, all our puppies come with a health guarantee. We are committed to the lifelong health and wellbeing of every puppy we place.', order: 5 },
      { question: 'How do I reserve a puppy?', answer: 'Reach out through our Contact page with the puppy you are interested in. We will guide you through the reservation process step by step.', order: 6 }
    ]);
    res.send('✅ FAQs seeded! Visit <a href="/faq">/faq</a> to see them.');
  } catch (err) {
    adminError(res, 'Admin action error', err);
  }
});

app.get('/about', (req, res) => {
  res.render('about');
});

app.get('/contact', (req, res) => {
  res.render('contact', { message: '', success: false });
});

app.post('/contact', contactLimiter, async (req, res) => {
  try {
    const { name, email, phone, location, subject, message } = req.body;
    if (!name || !email || !subject || !message) {
      return res.render('contact', { message: 'All fields are required.', success: false });
    }

    // Auto-detect location from the visitor's IP (best-effort, never blocks the message)
    const detectedLocation = await detectLocation(req);

    await new Contact({ name, email, phone, location, detectedLocation, subject, message }).save();

    // Notify you by email
    sendNotification(
      `📬 New Message from ${name} — ${subject}`,
      `<div style="font-family:Arial,sans-serif;max-width:580px;">
        <h2 style="color:#7a1e1e;">New Contact Form Message</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;font-weight:bold;color:#555;width:100px;">Name</td><td style="padding:8px 0;">${name}</td></tr>
          <tr><td style="padding:8px 0;font-weight:bold;color:#555;">Email</td><td style="padding:8px 0;"><a href="mailto:${email}">${email}</a></td></tr>
          ${phone ? `<tr><td style="padding:8px 0;font-weight:bold;color:#555;">Phone</td><td style="padding:8px 0;">${phone}</td></tr>` : ''}
          ${location ? `<tr><td style="padding:8px 0;font-weight:bold;color:#555;">Location</td><td style="padding:8px 0;">${location}</td></tr>` : ''}
          ${detectedLocation ? `<tr><td style="padding:8px 0;font-weight:bold;color:#555;">Detected</td><td style="padding:8px 0;">${detectedLocation}</td></tr>` : ''}
          <tr><td style="padding:8px 0;font-weight:bold;color:#555;">Subject</td><td style="padding:8px 0;">${subject}</td></tr>
        </table>
        <div style="margin-top:16px;padding:16px;background:#f9f9f9;border-left:4px solid #c9a227;border-radius:4px;">
          <p style="margin:0;white-space:pre-wrap;">${message}</p>
        </div>
        <p style="margin-top:20px;"><a href="https://shantibryankennel.com/admin/inquiries" style="background:#7a1e1e;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">View in Admin</a></p>
      </div>`
    );

    // Send an automatic confirmation reply to the client
    sendClientAutoReply(name, email, subject);

    res.render('contact', { message: 'Thank you! Your message has been received. We\'ll get back to you soon.', success: true });
  } catch (err) {
    console.error(err);
    res.render('contact', { message: 'Something went wrong. Please try again.', success: false });
  }
});

// ===== ADMIN AUTH =====
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5, // 5 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('admin-login', { error: 'Too many login attempts. Please wait 15 minutes and try again.' });
  }
});

app.get('/admin/login', (req, res) => {
  res.render('admin-login', { error: '' });
});

app.post('/admin/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const validUsername = username === process.env.ADMIN_USERNAME;
    const validPassword = await verifyAdminPassword(password, res.locals.settings);

    if (validUsername && validPassword) {
      req.session.isAdmin = true;
      res.redirect('/admin/dashboard');
    } else {
      res.render('admin-login', { error: 'Invalid username or password.' });
    }
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    res.render('admin-login', { error: 'Something went wrong. Please try again.' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// ===== ADMIN DASHBOARD =====
app.get('/admin/dashboard', requireLogin, async (req, res) => {
  const puppies = await Puppy.find().sort({ createdAt: -1 });
  const litters = await Litter.find().sort({ createdAt: -1 });
  const testimonials = await Testimonial.find({ approved: true }).sort({ createdAt: -1 });
  const pendingReviews = await Testimonial.countDocuments({ approved: false });
  const faqs = await Faq.find().sort({ order: 1 });
  const posts = await Post.find().sort({ createdAt: -1 });
  const inquiries = await Contact.find().sort({ createdAt: -1 });
  const dogs = await Dog.find().sort({ order: 1 });

  // Extra pipeline data so the dashboard can surface what actually needs attention
  const pendingApplications = await Application.countDocuments({ status: 'Pending' });
  const totalApplications   = await Application.countDocuments();
  const waitlistPendingDeposit = await Waitlist.countDocuments({ status: 'Pending Deposit' });
  const waitlistActive = await Waitlist.countDocuments({ status: 'Active' });
  const totalWaitlist = await Waitlist.countDocuments();
  const totalInvoices = await Invoice.countDocuments();
  const unpaidInvoices = await Invoice.countDocuments({ status: { $ne: 'Paid' } });
  const totalCertificates = await Certificate.countDocuments();

  // ── Chart data: last 6 months of actual sales activity, from real invoices ──
  const monthLabels = [];
  const monthKeys = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthLabels.push(d.toLocaleDateString('en-US', { month: 'short' }));
    monthKeys.push(`${d.getFullYear()}-${d.getMonth()}`);
  }
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const recentInvoices = await Invoice.find({ createdAt: { $gte: sixMonthsAgo } }).select('createdAt puppyPrice').lean();

  const puppiesPlacedByMonth = monthKeys.map(() => 0);
  const revenueByMonth = monthKeys.map(() => 0);
  recentInvoices.forEach(inv => {
    const d = new Date(inv.createdAt);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const idx = monthKeys.indexOf(key);
    if (idx !== -1) {
      puppiesPlacedByMonth[idx] += 1;
      revenueByMonth[idx] += (inv.puppyPrice || 0);
    }
  });

  res.render('admin-dashboard', {
    puppies, litters, testimonials, pendingReviews, faqs, posts, inquiries, dogs,
    pendingApplications, totalApplications,
    waitlistPendingDeposit, waitlistActive, totalWaitlist,
    totalInvoices, unpaidInvoices, totalCertificates,
    chartLabels: monthLabels, puppiesPlacedByMonth, revenueByMonth
  });
});

// ===== ADMIN INQUIRIES =====
app.get('/admin/inquiries', requireLogin, async (req, res) => {
  const inquiries = await Contact.find().sort({ createdAt: -1 });
  res.render('admin-inquiries', { inquiries });
});

app.get('/admin/inquiries/delete/:id', requireLogin, async (req, res) => {
  await Contact.findByIdAndDelete(req.params.id);
  res.redirect('/admin/inquiries');
});

// ===== ADMIN PUPPIES =====
app.get('/admin/puppies', requireLogin, async (req, res) => {
  const puppies = await Puppy.find().sort({ createdAt: -1 });
  res.render('admin-puppies-list', { puppies });
});

app.get('/admin/puppies/new', requireLogin, (req, res) => {
  res.render('admin-puppy-form', { puppy: null });
});

app.post('/admin/puppies/new', requireLogin, upload.array('photos', 5), async (req, res) => {
  try {
    const data = req.body;
    const puppy = new Puppy({
      name: data.name,
      price: data.price,
      gender: data.gender,
      dateOfBirth: data.dateOfBirth,
      color: data.color,
      weight: data.weight,
      status: data.status,
      description: data.description,
      sireName: data.sireName,
      damName: data.damName,
      vaccinated: data.vaccinated === 'on',
      dewormed: data.dewormed === 'on',
      microchipped: data.microchipped === 'on',
      photos: req.files ? req.files.map(f => f.path) : []
    });
    await puppy.save();
    res.redirect('/admin/dashboard');
  } catch (err) {
    adminError(res, 'ADD PUPPY ERROR:', err);
  }
});

app.get('/admin/puppies/edit/:id', requireLogin, async (req, res) => {
  try {
    const puppy = await Puppy.findById(req.params.id);
    res.render('admin-puppy-form', { puppy });
  } catch (err) {
    adminError(res, 'EDIT PUPPY ERROR:', err);
  }
});

app.post('/admin/puppies/edit/:id', requireLogin, upload.array('photos', 5), async (req, res) => {
  try {
    const data = req.body;
    const puppy = await Puppy.findById(req.params.id);
    const updateData = {
      name: data.name,
      price: data.price,
      gender: data.gender,
      dateOfBirth: data.dateOfBirth,
      color: data.color,
      weight: data.weight,
      status: data.status,
      description: data.description,
      sireName: data.sireName,
      damName: data.damName,
      vaccinated: data.vaccinated === 'on',
      dewormed: data.dewormed === 'on',
      microchipped: data.microchipped === 'on'
    };

    // Keep existing photos except any the admin checked for removal,
    // then append any newly uploaded photos (instead of wiping the whole gallery).
    const deletePhotos = Array.isArray(data.deletePhotos) ? data.deletePhotos : (data.deletePhotos ? [data.deletePhotos] : []);
    let remainingPhotos = (puppy.photos || []).filter(p => !deletePhotos.includes(p));
    if (req.files && req.files.length > 0) {
      remainingPhotos = remainingPhotos.concat(req.files.map(f => f.path));
    }
    updateData.photos = remainingPhotos;

    await Puppy.findByIdAndUpdate(req.params.id, updateData);
    res.redirect('/admin/dashboard');
  } catch (err) {
    adminError(res, 'UPDATE PUPPY ERROR:', err);
  }
});

app.get('/admin/puppies/delete/:id', requireLogin, async (req, res) => {
  await Puppy.findByIdAndDelete(req.params.id);
  res.redirect('/admin/dashboard');
});

// ===== ADMIN LITTERS =====
app.get('/admin/litters', requireLogin, async (req, res) => {
  const litters = await Litter.find().sort({ createdAt: -1 });
  res.render('admin-litters-list', { litters });
});

app.get('/admin/litters/new', requireLogin, (req, res) => {
  res.render('admin-litter-form', { litter: null });
});

app.post('/admin/litters/new', requireLogin, litterUpload, async (req, res) => {
  try {
    const data = req.body;
    const files = req.files || {};
    const litter = new Litter({
      litterName: data.litterName,
      birthDate: data.birthDate,
      numberOfPuppies: data.numberOfPuppies,
      description: data.description,
      photos: files.photos ? files.photos.map(f => f.path) : [],
      sireName: data.sireName,
      sireWeight: data.sireWeight,
      sirePhoto: files.sirePhoto ? files.sirePhoto[0].path : '',
      damName: data.damName,
      damWeight: data.damWeight,
      damPhoto: files.damPhoto ? files.damPhoto[0].path : ''
    });
    await litter.save();
    res.redirect('/admin/dashboard');
  } catch (err) {
    adminError(res, 'ADD LITTER ERROR:', err);
  }
});

app.get('/admin/litters/edit/:id', requireLogin, async (req, res) => {
  try {
    const litter = await Litter.findById(req.params.id);
    res.render('admin-litter-form', { litter });
  } catch (err) {
    adminError(res, 'EDIT LITTER ERROR:', err);
  }
});

app.post('/admin/litters/edit/:id', requireLogin, litterUpload, async (req, res) => {
  try {
    const data = req.body;
    const files = req.files || {};
    const litter = await Litter.findById(req.params.id);
    const updateData = {
      litterName: data.litterName,
      birthDate: data.birthDate,
      numberOfPuppies: data.numberOfPuppies,
      description: data.description,
      sireName: data.sireName,
      sireWeight: data.sireWeight,
      damName: data.damName,
      damWeight: data.damWeight
    };

    // Keep existing litter photos except any checked for removal, then append new uploads
    const deletePhotos = Array.isArray(data.deletePhotos) ? data.deletePhotos : (data.deletePhotos ? [data.deletePhotos] : []);
    let remainingPhotos = (litter.photos || []).filter(p => !deletePhotos.includes(p));
    if (files.photos && files.photos.length > 0) {
      remainingPhotos = remainingPhotos.concat(files.photos.map(f => f.path));
    }
    updateData.photos = remainingPhotos;

    if (files.sirePhoto) updateData.sirePhoto = files.sirePhoto[0].path;
    if (files.damPhoto) updateData.damPhoto = files.damPhoto[0].path;

    await Litter.findByIdAndUpdate(req.params.id, updateData);
    res.redirect('/admin/dashboard');
  } catch (err) {
    adminError(res, 'UPDATE LITTER ERROR:', err);
  }
});

app.get('/admin/litters/delete/:id', requireLogin, async (req, res) => {
  await Litter.findByIdAndDelete(req.params.id);
  res.redirect('/admin/dashboard');
});

// ===== ADMIN TESTIMONIALS =====
app.get('/admin/testimonials', requireLogin, async (req, res) => {
  const pending = await Testimonial.find({ approved: false }).sort({ createdAt: -1 });
  const approved = await Testimonial.find({ approved: true }).sort({ createdAt: -1 });
  res.render('admin-testimonials-list', { testimonials: approved, pending });
});

app.get('/admin/testimonials/new', requireLogin, (req, res) => {
  res.render('admin-testimonial-form', { testimonial: null });
});

app.post('/admin/testimonials/new', requireLogin, upload.single('photo'), async (req, res) => {
  try {
    const data = req.body;
    const testimonial = new Testimonial({
      customerName: data.customerName,
      location: data.location,
      tag: data.tag,
      rating: parseInt(data.rating),
      message: data.message,
      photo: req.file ? req.file.path : ''
    });
    await testimonial.save();
    res.redirect('/admin/dashboard');
  } catch (err) {
    adminError(res, 'ADD TESTIMONIAL ERROR:', err);
  }
});

app.get('/admin/testimonials/edit/:id', requireLogin, async (req, res) => {
  try {
    const testimonial = await Testimonial.findById(req.params.id);
    res.render('admin-testimonial-form', { testimonial });
  } catch (err) {
    adminError(res, 'EDIT TESTIMONIAL ERROR:', err);
  }
});

app.post('/admin/testimonials/edit/:id', requireLogin, upload.single('photo'), async (req, res) => {
  try {
    const data = req.body;
    const updateData = {
      customerName: data.customerName,
      location: data.location,
      tag: data.tag,
      rating: parseInt(data.rating),
      message: data.message
    };
    // If a new photo is uploaded, replace the old one
    if (req.file) {
      updateData.photo = req.file.path;
    }
    // If the delete checkbox was checked and no new photo uploaded, clear the photo
    if (data.deletePhoto === 'yes' && !req.file) {
      updateData.photo = '';
    }
    await Testimonial.findByIdAndUpdate(req.params.id, updateData);
    res.redirect('/admin/testimonials');
  } catch (err) {
    adminError(res, 'UPDATE TESTIMONIAL ERROR:', err);
  }
});

app.get('/admin/testimonials/approve/:id', requireLogin, async (req, res) => {
  await Testimonial.findByIdAndUpdate(req.params.id, { approved: true });
  res.redirect('/admin/testimonials');
});

app.get('/admin/testimonials/reject/:id', requireLogin, async (req, res) => {
  await Testimonial.findByIdAndDelete(req.params.id);
  res.redirect('/admin/testimonials');
});

app.get('/admin/testimonials/delete/:id', requireLogin, async (req, res) => {
  await Testimonial.findByIdAndDelete(req.params.id);
  res.redirect('/admin/dashboard');
});

// ===== ADMIN FAQS =====
app.get('/admin/faqs', requireLogin, async (req, res) => {
  const faqs = await Faq.find().sort({ order: 1 });
  res.render('admin-faqs-list', { faqs });
});

app.get('/admin/faqs/new', requireLogin, (req, res) => {
  res.render('admin-faq-form', { faq: null });
});

app.post('/admin/faqs/new', requireLogin, async (req, res) => {
  try {
    await new Faq({ question: req.body.question, answer: req.body.answer, order: req.body.order || 0 }).save();
    res.redirect('/admin/dashboard');
  } catch (err) {
    adminError(res, 'Admin action error', err);
  }
});

app.get('/admin/faqs/edit/:id', requireLogin, async (req, res) => {
  try {
    const faq = await Faq.findById(req.params.id);
    res.render('admin-faq-form', { faq });
  } catch (err) {
    adminError(res, 'Admin action error', err);
  }
});

app.post('/admin/faqs/edit/:id', requireLogin, async (req, res) => {
  try {
    await Faq.findByIdAndUpdate(req.params.id, { question: req.body.question, answer: req.body.answer, order: req.body.order || 0 });
    res.redirect('/admin/dashboard');
  } catch (err) {
    adminError(res, 'Admin action error', err);
  }
});

app.get('/admin/faqs/delete/:id', requireLogin, async (req, res) => {
  await Faq.findByIdAndDelete(req.params.id);
  res.redirect('/admin/dashboard');
});

// ===== ADMIN SETTINGS =====
app.get('/admin/settings', requireLogin, async (req, res) => {
  const settings = await getSettings();
  res.render('admin-settings', {
    settings,
    saved: req.query.saved === '1',
    pwsaved: req.query.pwsaved === '1',
    pwerror: req.query.pwerror || ''
  });
});

app.post('/admin/settings', requireLogin, async (req, res) => {
  try {
    const settings = await getSettings();
    settings.email = req.body.email;
    settings.phone = req.body.phone;
    settings.statYears = req.body.statYears;
    settings.statPuppies = req.body.statPuppies;
    settings.statHealth = req.body.statHealth;
    settings.aiInstructions = req.body.aiInstructions || '';
    settings.updatedAt = Date.now();
    await settings.save();
    res.redirect('/admin/settings?saved=1');
  } catch (err) {
    adminError(res, 'Admin action error', err);
  }
});

app.post('/admin/settings/password', requireLogin, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const settings = await getSettings();

    const currentIsValid = await verifyAdminPassword(currentPassword, settings);
    if (!currentIsValid) {
      return res.redirect('/admin/settings?pwerror=' + encodeURIComponent('Your current password is incorrect.'));
    }
    if (!newPassword || newPassword.length < 8) {
      return res.redirect('/admin/settings?pwerror=' + encodeURIComponent('New password must be at least 8 characters.'));
    }
    if (newPassword !== confirmPassword) {
      return res.redirect('/admin/settings?pwerror=' + encodeURIComponent('New password and confirmation do not match.'));
    }

    settings.adminPasswordHash = await bcrypt.hash(newPassword, 10);
    settings.updatedAt = Date.now();
    await settings.save();
    res.redirect('/admin/settings?pwsaved=1');
  } catch (err) {
    adminError(res, 'CHANGE PASSWORD ERROR:', err);
  }
});

// ===== ADMIN POSTS =====
app.get('/admin/posts', requireLogin, async (req, res) => {
  const posts = await Post.find().sort({ createdAt: -1 });
  res.render('admin-posts-list', { posts });
});

app.get('/admin/posts/new', requireLogin, (req, res) => {
  res.render('admin-post-form', { post: null });
});

app.post('/admin/posts/new', requireLogin, upload.single('image'), async (req, res) => {
  try {
    let slug = makeSlug(req.body.title);
    const existing = await Post.findOne({ slug });
    if (existing) slug = slug + '-' + Date.now();
    const post = new Post({
      title: req.body.title,
      slug: slug,
      excerpt: req.body.excerpt,
      content: req.body.content,
      image: req.file ? req.file.path : ''
    });
    await post.save();
    res.redirect('/admin/dashboard');
  } catch (err) {
    adminError(res, 'ADD POST ERROR:', err);
  }
});

app.get('/admin/posts/edit/:id', requireLogin, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    res.render('admin-post-form', { post });
  } catch (err) {
    adminError(res, 'Admin action error', err);
  }
});

app.post('/admin/posts/edit/:id', requireLogin, upload.single('image'), async (req, res) => {
  try {
    const updateData = {
      title: req.body.title,
      excerpt: req.body.excerpt,
      content: req.body.content
    };
    if (req.file) updateData.image = req.file.path;
    await Post.findByIdAndUpdate(req.params.id, updateData);
    res.redirect('/admin/dashboard');
  } catch (err) {
    adminError(res, 'UPDATE POST ERROR:', err);
  }
});

app.get('/admin/posts/delete/:id', requireLogin, async (req, res) => {
  await Post.findByIdAndDelete(req.params.id);
  res.redirect('/admin/dashboard');
});

// ===== ADMIN DOGS =====
app.get('/admin/dogs', requireLogin, async (req, res) => {
  const dogs = await Dog.find().sort({ order: 1 });
  res.render('admin-dogs-list', { dogs });
});

app.get('/admin/dogs/new', requireLogin, (req, res) => {
  res.render('admin-dog-form', { dog: null });
});

app.post('/admin/dogs/new', requireLogin, upload.array('photos', 8), async (req, res) => {
  try {
    const dog = new Dog({
      name: req.body.name,
      gender: req.body.gender,
      role: req.body.role,
      order: req.body.order || 0,
      description: req.body.description,
      photos: req.files ? req.files.map(f => f.path) : []
    });
    await dog.save();
    res.redirect('/admin/dashboard');
  } catch (err) {
    adminError(res, 'ADD DOG ERROR:', err);
  }
});

app.get('/admin/dogs/edit/:id', requireLogin, async (req, res) => {
  try {
    const dog = await Dog.findById(req.params.id);
    res.render('admin-dog-form', { dog });
  } catch (err) {
    adminError(res, 'Admin action error', err);
  }
});

app.post('/admin/dogs/edit/:id', requireLogin, upload.array('photos', 8), async (req, res) => {
  try {
    const data = req.body;
    const dog = await Dog.findById(req.params.id);
    const updateData = {
      name: data.name,
      gender: data.gender,
      role: data.role,
      order: data.order || 0,
      description: data.description
    };

    // Migrate the legacy single `photo` field into the photos array if needed,
    // then apply removals and append any newly uploaded photos.
    const existingPhotos = (dog.photos && dog.photos.length > 0) ? dog.photos : (dog.photo ? [dog.photo] : []);
    const deletePhotos = Array.isArray(data.deletePhotos) ? data.deletePhotos : (data.deletePhotos ? [data.deletePhotos] : []);
    let remainingPhotos = existingPhotos.filter(p => !deletePhotos.includes(p));
    if (req.files && req.files.length > 0) {
      remainingPhotos = remainingPhotos.concat(req.files.map(f => f.path));
    }
    updateData.photos = remainingPhotos;

    await Dog.findByIdAndUpdate(req.params.id, updateData);
    res.redirect('/admin/dashboard');
  } catch (err) {
    adminError(res, 'UPDATE DOG ERROR:', err);
  }
});

app.get('/admin/dogs/delete/:id', requireLogin, async (req, res) => {
  await Dog.findByIdAndDelete(req.params.id);
  res.redirect('/admin/dashboard');
});

// ===== AI CHAT (public + admin) =====
// Shared function that builds the full live context from the database
async function buildSiteContext(isAdmin = false) {
  const sections = [];

  // --- ALL PUPPIES ---
  try {
    const puppies = await Puppy.find().sort({ createdAt: -1 }).lean();
    if (puppies.length > 0) {
      const available = puppies.filter(p => p.status === 'Available');
      const reserved  = puppies.filter(p => p.status === 'Reserved');
      const sold      = puppies.filter(p => p.status === 'Sold');
      let block = '\n\n=== PUPPIES (LIVE DATABASE) ===';
      if (available.length) block += '\nAVAILABLE:\n' + available.map(p => `  • ${p.name} — ${p.gender}, ${p.color}, $${p.price}${p.weight ? ', ' + p.weight : ''}${p.dateOfBirth ? ', DOB: ' + new Date(p.dateOfBirth).toLocaleDateString() : ''}`).join('\n');
      if (reserved.length)  block += '\nRESERVED:\n'  + reserved.map(p => `  • ${p.name} — ${p.gender}, ${p.color}, $${p.price}`).join('\n');
      if (sold.length)      block += '\nSOLD:\n'      + sold.map(p => `  • ${p.name} — ${p.gender}, ${p.color}`).join('\n');
      if (!available.length && !reserved.length) block += '\n  No puppies currently listed. New litters coming soon.';
      sections.push(block);
    } else {
      sections.push('\n\n=== PUPPIES ===\n  No puppies currently listed. New litters coming soon.');
    }
  } catch(e) { sections.push('\n\n=== PUPPIES ===\n  (data unavailable)'); }

  // --- LITTERS ---
  try {
    const litters = await Litter.find().sort({ birthDate: -1 }).lean();
    if (litters.length > 0) {
      let block = '\n\n=== LITTERS (LIVE DATABASE) ===\n';
      block += litters.map(l => `  • ${l.litterName} — Born: ${new Date(l.birthDate).toLocaleDateString()}, Sire: ${l.sireName}, Dam: ${l.damName}${l.numberOfPuppies ? ', ' + l.numberOfPuppies + ' puppies' : ''}`).join('\n');
      sections.push(block);
    }
  } catch(e) {}

  // --- OUR DOGS ---
  try {
    const dogs = await Dog.find().sort({ order: 1 }).lean();
    if (dogs.length > 0) {
      let block = '\n\n=== OUR BREEDING DOGS ===\n';
      block += dogs.map(d => `  • ${d.name} — ${d.gender}${d.role ? ', ' + d.role : ''}${d.description ? ': ' + d.description.substring(0, 100) : ''}`).join('\n');
      sections.push(block);
    }
  } catch(e) {}

  // --- TESTIMONIALS (approved) ---
  try {
    const reviews = await Testimonial.find({ approved: true }).sort({ createdAt: -1 }).lean();
    if (reviews.length > 0) {
      let block = '\n\n=== CUSTOMER REVIEWS ===\n';
      block += reviews.map(r => `  • ${r.customerName}${r.location ? ' (' + r.location + ')' : ''} — ${r.rating}/5 stars: "${r.message.substring(0, 120)}${r.message.length > 120 ? '...' : ''}"`).join('\n');
      sections.push(block);
    }
  } catch(e) {}

  // --- FAQs ---
  try {
    const faqs = await Faq.find().sort({ order: 1 }).lean();
    if (faqs.length > 0) {
      let block = '\n\n=== FAQ PAGE (LIVE) ===\n';
      block += faqs.map(f => `  • Q: ${f.question}\n    A: ${f.answer.substring(0, 90)}${f.answer.length > 90 ? '...' : ''}`).join('\n');
      sections.push(block);
    } else {
      sections.push('\n\n=== FAQ PAGE ===\n  No FAQs added yet.');
    }
  } catch(e) {}

  // --- PUPPY APPLICATIONS (admin only) ---
  if (isAdmin) {
    try {
      const applications = await Application.find().sort({ createdAt: -1 }).limit(8).lean();
      if (applications.length > 0) {
        const pendingApps = applications.filter(a => a.status === 'Pending');
        let block = '\n\n=== PUPPY APPLICATIONS (most recent 15) ===\n';
        block += applications.map(a => `  • [${a.status}] ${a.applicantName} (${a.email}) — Interested in: ${a.interestedIn}, Home: ${a.homeOwnership}${a.location ? ', ' + a.location : ''}`).join('\n');
        if (pendingApps.length > 0) block += `\n  → ${pendingApps.length} application(s) awaiting review`;
        sections.push(block);
      }
    } catch(e) {}

    // --- WAITLIST (admin only) ---
    try {
      const waitlist = await Waitlist.find().sort({ createdAt: -1 }).limit(10).lean();
      if (waitlist.length > 0) {
        const pendingDeposit = waitlist.filter(w => w.status === 'Pending Deposit');
        const active = waitlist.filter(w => w.status === 'Active');
        let block = '\n\n=== WAITLIST (most recent 20) ===\n';
        block += waitlist.map(w => `  • [${w.status}] ${w.name} (${w.email}) — Wants: ${w.preferredGender}, ${w.preferredColor}`).join('\n');
        block += `\n  → ${pendingDeposit.length} awaiting deposit, ${active.length} active on waitlist`;
        sections.push(block);
      }
    } catch(e) {}

    // --- INVOICES (admin only) ---
    try {
      const invoices = await Invoice.find().sort({ createdAt: -1 }).limit(10).lean();
      if (invoices.length > 0) {
        let block = '\n\n=== RECENT PUPPY PURCHASE INVOICES (last 10) ===\n';
        block += invoices.map(i => `  • ${i.invoiceNumber} — ${i.clientName}, ${i.puppyName}, Balance Due: $${i.balanceDue}, Status: ${i.status}`).join('\n');
        sections.push(block);
      }
    } catch(e) {}

    // --- CERTIFICATES (admin only) ---
    try {
      const certificates = await Certificate.find().sort({ createdAt: -1 }).limit(10).lean();
      if (certificates.length > 0) {
        let block = '\n\n=== OWNERSHIP CERTIFICATES ISSUED (last 10) ===\n';
        block += certificates.map(c => `  • ${c.certificateNumber} — ${c.puppyName} → ${c.buyerName}`).join('\n');
        sections.push(block);
      }
    } catch(e) {}
  }

  // --- PENDING REVIEWS (admin only) ---
  if (isAdmin) {
    try {
      const pending = await Testimonial.find({ approved: false }).lean();
      if (pending.length > 0) {
        let block = '\n\n=== PENDING REVIEWS (awaiting approval) ===\n';
        block += pending.map(r => `  • ${r.customerName} — ${r.rating}/5 stars: "${r.message.substring(0, 100)}..."`).join('\n');
        sections.push(block);
      }
    } catch(e) {}

    // --- RECENT INQUIRIES (admin only) ---
    try {
      const inquiries = await Contact.find().sort({ createdAt: -1 }).limit(10).lean();
      if (inquiries.length > 0) {
        let block = '\n\n=== RECENT CONTACT INQUIRIES (last 10) ===\n';
        block += inquiries.map(i => `  • ${i.name} (${i.email})${i.location ? ' — ' + i.location : ''}: "${i.subject}" — ${i.message.substring(0, 80)}...`).join('\n');
        sections.push(block);
      }
    } catch(e) {}

    // --- STATS SUMMARY (admin only) ---
    try {
      const [totalPuppies, availablePuppies, reservedPuppies, soldPuppies, totalLitters, totalDogs, totalReviews, pendingReviews, totalInquiries, totalApplications, pendingApplications, totalWaitlist, activeWaitlist, totalInvoices, totalCertificates, totalFaqs] = await Promise.all([
        Puppy.countDocuments(),
        Puppy.countDocuments({ status: 'Available' }),
        Puppy.countDocuments({ status: 'Reserved' }),
        Puppy.countDocuments({ status: 'Sold' }),
        Litter.countDocuments(),
        Dog.countDocuments(),
        Testimonial.countDocuments({ approved: true }),
        Testimonial.countDocuments({ approved: false }),
        Contact.countDocuments(),
        Application.countDocuments(),
        Application.countDocuments({ status: 'Pending' }),
        Waitlist.countDocuments(),
        Waitlist.countDocuments({ status: 'Active' }),
        Invoice.countDocuments(),
        Certificate.countDocuments(),
        Faq.countDocuments()
      ]);
      sections.push(`\n\n=== SITE STATS ===\n  Puppies: ${totalPuppies} total (${availablePuppies} available, ${reservedPuppies} reserved, ${soldPuppies} sold)\n  Litters: ${totalLitters} | Dogs: ${totalDogs} | FAQs: ${totalFaqs}\n  Reviews: ${totalReviews} approved, ${pendingReviews} pending\n  Inquiries: ${totalInquiries} total\n  Applications: ${totalApplications} total, ${pendingApplications} pending review\n  Waitlist: ${totalWaitlist} total, ${activeWaitlist} active\n  Puppy Purchase Invoices: ${totalInvoices} | Ownership Certificates: ${totalCertificates}`);
    } catch(e) {}
  }

  return sections.join('');
}

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.json({ reply: 'No message received.' });

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.json({ reply: "Hi! I'm Bella, your kennel assistant. Our AI is being set up right now. In the meantime, please reach out at info@shantibryankennel.com and we'll get back to you shortly!" });
    }

    const liveContext = await buildSiteContext(false);
    const settings = res.locals.settings || {};

    const systemText = `You are Bella, the friendly and knowledgeable AI assistant for Shanti and Bryan Pinscher Kennel. You are warm, helpful, and passionate about Miniature Pinschers. You work exclusively for this kennel.

ABOUT THE KENNEL:
- Name: Shanti and Bryan Pinscher Kennel
- Website: shantibryankennel.com
- Specialization: Home-raised Miniature Pinscher (Min Pin) puppies
- Experience: 15+ years of breeding experience
- Location: Based in the United States (we deliver nationwide and worldwide)
- Mission: Placing healthy, well-socialized Min Pin puppies into loving homes

BREEDING PROGRAM:
- All puppies are home-raised with daily love, care, and socialization
- Puppies are raised inside the family home, not in kennels or cages
- Every puppy receives full veterinary care before going home
- We prioritize temperament, health, and beauty in our breeding pairs

HEALTH & VETERINARY:
- All puppies come with a 1-Year Written Health Guarantee
- Fully vaccinated with age-appropriate vaccines before going home
- Dewormed on a regular schedule from birth
- Microchipping available on request
- Complete vet records provided with every puppy

PRICING & DEPOSITS:
- Puppy prices vary by gender, color, and availability — see the live puppy data below
- To reserve a puppy, visitors should first fill out our Puppy Application at shantibryankennel.com/apply — this helps us make sure our puppies go to the right homes
- A non-refundable deposit is required to reserve a puppy after an application is approved
- The deposit is applied toward the total purchase price
- If no puppies are currently available matching what they want, direct them to join our Waitlist at shantibryankennel.com/waitlist — a deposit is required to activate a waitlist spot, but it's fully applied toward their future puppy

DELIVERY & PICKUP:
- Nationwide delivery through a trusted professional pet transport agency
- Local pickup available at our home
- Delivery timeline confirmed at time of purchase

ABOUT MINIATURE PINSCHERS:
- Bold, energetic, loyal — "big dogs in small bodies"
- Excellent family companions with proper training and socialization
- Highly intelligent, respond well to positive reinforcement
- Need daily exercise and mental stimulation
- Lifespan 12-16 years, low-shedding, easy to groom

CONTACT & KEY PAGES:
- Email: info@shantibryankennel.com
- Contact form: shantibryankennel.com/contact
- Puppy Application (to reserve a puppy): shantibryankennel.com/apply
- Join Waitlist (for future litters): shantibryankennel.com/waitlist
- Available Puppies: shantibryankennel.com/puppies
- Submit a review: shantibryankennel.com/submit-review
- FAQ: shantibryankennel.com/faq (also see live FAQ content below — answer directly from it when relevant)

BEHAVIOR RULES:
- Always respond warmly and helpfully
- You CAN share puppy prices when asked — the data is below
- Never make up information — if unsure, direct to the contact form
- Keep responses concise and friendly, under 200 words unless more detail is needed
- Use line breaks for readability
- Always end with a helpful next step
- Respond in the same language the customer uses${liveContext}${settings.aiInstructions ? `\n\nSPECIAL INSTRUCTIONS FROM THE KENNEL OWNER (follow these closely — they override general guidance above where they conflict):\n${settings.aiInstructions}` : ''}`;

    const messages = [
      { role: 'system', content: systemText },
      ...(Array.isArray(history) ? history : []).slice(-10).map(m => ({
        role: m.r === 'assistant' ? 'assistant' : 'user',
        content: String(m.t || '')
      })),
      { role: 'user', content: message }
    ];

    const { res: groqRes, data } = await callGroqWithRetry(apiKey, {
      model: 'openai/gpt-oss-120b', messages, max_tokens: 600, temperature: 0.5, reasoning_effort: 'low'
    });

    if (!groqRes.ok || !data.choices) {
      console.error('Groq error:', JSON.stringify(data).slice(0, 200));
      return res.json({ reply: "I'm having a moment — please try again or reach us at info@shantibryankennel.com!" });
    }

    res.json({ reply: stripThinking(data.choices[0]?.message?.content) || "Could you rephrase that?" });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.json({ reply: "Something went wrong. Please try again or contact info@shantibryankennel.com" });
  }
});

// Admin AI chat — knows everything including pending reviews, inquiries, and stats
// ===== ADMIN AI — ACTION EXECUTOR =====
app.post('/api/admin-action', requireLogin, async (req, res) => {
  const { action, params } = req.body;
  try {
    switch (action) {
      case 'approve_review': {
        const t = await Testimonial.findByIdAndUpdate(params.id, { approved: true }, { new: true });
        return res.json({ ok: true, message: `✅ Review by **${t.customerName}** approved and now live.` });
      }
      case 'reject_review': {
        await Testimonial.findByIdAndDelete(params.id);
        return res.json({ ok: true, message: '🗑️ Review deleted.' });
      }
      case 'approve_all_reviews': {
        const r = await Testimonial.updateMany({ approved: false }, { approved: true });
        return res.json({ ok: true, message: `✅ Approved **${r.modifiedCount}** pending reviews. Now live on site.` });
      }
      case 'update_puppy_status': {
        const p = await Puppy.findByIdAndUpdate(params.id, { status: params.status }, { new: true });
        return res.json({ ok: true, message: `✅ **${p.name}** is now marked as **${params.status}**.` });
      }
      case 'update_puppy_price': {
        const p = await Puppy.findByIdAndUpdate(params.id, { price: params.price }, { new: true });
        return res.json({ ok: true, message: `✅ **${p.name}** price updated to **$${params.price}**.` });
      }
      case 'delete_puppy': {
        const p = await Puppy.findByIdAndDelete(params.id);
        return res.json({ ok: true, message: `🗑️ Puppy **${p ? p.name : params.id}** deleted.` });
      }
      case 'delete_inquiry': {
        await Contact.findByIdAndDelete(params.id);
        return res.json({ ok: true, message: '🗑️ Inquiry deleted.' });
      }
      case 'delete_all_inquiries': {
        const r = await Contact.deleteMany({});
        return res.json({ ok: true, message: `🗑️ Deleted **${r.deletedCount}** inquiries.` });
      }
      case 'mark_invoice_paid': {
        const inv = await Invoice.findByIdAndUpdate(params.id, { status: 'Paid' }, { new: true });
        return res.json({ ok: true, message: `✅ Invoice **${inv.invoiceNumber}** marked as Paid.` });
      }
      case 'delete_invoice': {
        const inv = await Invoice.findByIdAndDelete(params.id);
        return res.json({ ok: true, message: `🗑️ Invoice **${inv ? inv.invoiceNumber : params.id}** deleted.` });
      }
      case 'send_email_to_client': {
        await sendNotification(params.subject, params.html);
        return res.json({ ok: true, message: `📧 Email sent with subject: "${params.subject}".` });
      }
      case 'update_stats': {
        const settings = await getSettings();
        if (params.statYears   !== undefined) settings.statYears   = params.statYears;
        if (params.statPuppies !== undefined) settings.statPuppies = params.statPuppies;
        if (params.statHealth  !== undefined) settings.statHealth  = params.statHealth;
        await settings.save();
        return res.json({ ok: true, message: '✅ Homepage stats updated.' });
      }

      case 'create_faq': {
        const count = await Faq.countDocuments();
        const faq = await Faq.create({
          question: params.question,
          answer: params.answer,
          order: params.order !== undefined ? params.order : count
        });
        return res.json({ ok: true, message: `✅ New FAQ added: **"${faq.question}"** — now live on the FAQ page.` });
      }
      case 'update_faq': {
        const faq = await Faq.findByIdAndUpdate(params.id, {
          question: params.question,
          answer: params.answer
        }, { new: true });
        return res.json({ ok: true, message: `✅ FAQ updated: **"${faq.question}"**.` });
      }
      case 'delete_faq': {
        const faq = await Faq.findByIdAndDelete(params.id);
        return res.json({ ok: true, message: `🗑️ FAQ **"${faq ? faq.question : params.id}"** deleted.` });
      }
      case 'delete_all_faqs': {
        const r = await Faq.deleteMany({});
        return res.json({ ok: true, message: `🗑️ Deleted all **${r.deletedCount}** FAQs.` });
      }

      case 'approve_application': {
        const a = await Application.findByIdAndUpdate(params.id, { status: 'Approved' }, { new: true });
        return res.json({ ok: true, message: `✅ Application from **${a.applicantName}** approved.` });
      }
      case 'decline_application': {
        const a = await Application.findByIdAndUpdate(params.id, { status: 'Declined' }, { new: true });
        return res.json({ ok: true, message: `❌ Application from **${a.applicantName}** declined.` });
      }
      case 'delete_application': {
        const a = await Application.findByIdAndDelete(params.id);
        return res.json({ ok: true, message: `🗑️ Application from **${a ? a.applicantName : params.id}** deleted.` });
      }

      case 'mark_waitlist_matched': {
        const w = await Waitlist.findByIdAndUpdate(params.id, { status: 'Matched' }, { new: true });
        return res.json({ ok: true, message: `✅ **${w.name}** marked as Matched on the waitlist.` });
      }
      case 'mark_waitlist_fulfilled': {
        const w = await Waitlist.findByIdAndUpdate(params.id, { status: 'Fulfilled' }, { new: true });
        return res.json({ ok: true, message: `✅ **${w.name}**'s waitlist entry marked Fulfilled.` });
      }
      case 'cancel_waitlist': {
        const w = await Waitlist.findByIdAndUpdate(params.id, { status: 'Cancelled' }, { new: true });
        return res.json({ ok: true, message: `🗑️ Waitlist entry for **${w.name}** cancelled.` });
      }

      default:
        return res.json({ ok: false, message: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('Admin action error:', err.message);
    return res.json({ ok: false, message: `Action failed: ${err.message}` });
  }
});

app.post('/api/admin-chat', requireLogin, async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.json({ reply: 'No message received.' });

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.json({ reply: 'GROQ_API_KEY not set.' });

    const liveContext = await buildSiteContext(true);

    const systemText = `You are an all-powerful AI admin for Shanti and Bryan Pinscher Kennel. You speak directly with Bryan the owner. You know everything about the site AND can take real actions.

HOW TO TRIGGER ACTIONS:
When you want to do something, include this in your reply:
<ACTION>{"action":"action_name","params":{...}}</ACTION>

AVAILABLE ACTIONS:
- approve_review: params: {id} — approve a pending review
- reject_review: params: {id} — delete a review  
- approve_all_reviews: params: {} — approve ALL pending reviews
- update_puppy_status: params: {id, status} — status must be Available, Reserved, or Sold
- update_puppy_price: params: {id, price} — update price (number)
- delete_puppy: params: {id} — permanently delete a puppy
- delete_inquiry: params: {id} — delete one inquiry
- delete_all_inquiries: params: {} — clear all inquiries
- mark_invoice_paid: params: {id} — mark a puppy purchase invoice as paid
- delete_invoice: params: {id} — delete a puppy purchase invoice
- send_email_to_client: params: {subject, html} — send notification email
- update_stats: params: {statYears, statPuppies, statHealth} — update homepage stats
- create_faq: params: {question, answer, order} — add a new FAQ to the public FAQ page (order is optional, controls position)
- update_faq: params: {id, question, answer} — edit an existing FAQ
- delete_faq: params: {id} — remove a single FAQ
- delete_all_faqs: params: {} — remove ALL FAQs in one action (use this instead of many delete_faq calls when Bryan wants everything cleared)
- approve_application: params: {id} — approve a puppy application
- decline_application: params: {id} — decline a puppy application
- delete_application: params: {id} — permanently delete an application
- mark_waitlist_matched: params: {id} — mark a waitlist entry as Matched to a puppy
- mark_waitlist_fulfilled: params: {id} — mark a waitlist entry as Fulfilled (puppy placed)
- cancel_waitlist: params: {id} — cancel a waitlist entry

NOTE ON DOCUMENTS: Invoices are for puppy purchases (created manually via the Invoices page with a signature). Waitlist deposits use a SEPARATE document called a Waitlist Deposit Receipt, created from the Waitlist page — you cannot generate either of these documents yourself, only manage their status once created.

RULES:
- Always use IDs from the live data — never guess an ID
- For destructive actions (delete, delete_all), describe what you will do and ask Bryan to confirm BEFORE including the ACTION block
- When Bryan confirms, include the ACTION block in your response
- You can include multiple ACTION blocks in one response, but keep it to a small number (roughly 5 or fewer) — if a bulk action exists (like delete_all_faqs, delete_all_inquiries, approve_all_reviews), always use that instead of many individual actions, since generating many action blocks in one reply can fail
- If Bryan wants to bulk-delete something that has no dedicated bulk action available, say so honestly and offer to do a few at a time across multiple messages, rather than attempting a large number of individual actions in one response
- Keep responses concise — Bryan is busy
- You can also draft content, answer questions, and give advice without any action${liveContext}`;

    const messages = [
      { role: 'system', content: systemText },
      ...(Array.isArray(history) ? history : []).slice(-8).map(m => ({
        role: m.r === 'assistant' ? 'assistant' : 'user',
        content: String(m.t || '').slice(0, 800)
      })),
      { role: 'user', content: message }
    ];

    const { res: groqRes, data } = await callGroqWithRetry(apiKey, {
      model: 'openai/gpt-oss-120b', messages, max_tokens: 900, temperature: 0.3, reasoning_effort: 'low'
    });

    if (!groqRes.ok || !data.choices) {
      console.error('Admin chat Groq error:', JSON.stringify(data).slice(0, 500));
      return res.json({ reply: `AI error: ${data.error?.message || 'Unknown — check server logs for details.'}` });
    }
    res.json({ reply: stripThinking(data.choices[0]?.message?.content) || 'No response.' });

  } catch (err) {
    console.error('Admin chat error:', err.message);
    res.json({ reply: 'Something went wrong.' });
  }
});

// ===== ADMIN VISION — Single image analysis (describe puppy, captions) =====
app.post('/api/admin-vision', requireLogin, async (req, res) => {
  try {
    const { imageData, mimeType, prompt } = req.body;
    if (!imageData) return res.json({ reply: 'No image received.' });

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.json({ reply: 'GROQ_API_KEY not set.' });

    const userPrompt = prompt || 'You are an expert Min Pin breeder assistant. Please analyze this puppy photo and provide: 1) A professional puppy description for a kennel website listing (3-4 sentences), 2) Three social media caption ideas, 3) Any notable physical traits you can see (color, markings, build). Be warm, professional, and enthusiastic about the puppy.';

    const { res: groqRes, data } = await callGroqWithRetry(apiKey, {
      model: 'qwen/qwen3.6-27b',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageData}` } },
            { type: 'text', text: userPrompt }
          ]
        }
      ],
      max_tokens: 800,
      temperature: 0.5,
      reasoning_effort: 'none'
    });

    if (!groqRes.ok || !data.choices) {
      console.error('Vision error:', JSON.stringify(data).slice(0, 400));
      return res.json({ reply: `Vision AI error: ${data.error?.message || 'Unknown error'}. Try a smaller JPEG image.` });
    }

    res.json({ reply: stripThinking(data.choices[0]?.message?.content) || 'No response.' });
  } catch (err) {
    console.error('Vision error:', err.message);
    res.json({ reply: `Something went wrong: ${err.message}` });
  }
});

// ===== PUPPY APPLICATIONS (ADMIN) =====
app.get('/admin/applications', requireLogin, async (req, res) => {
  const all = await Application.find().sort({ createdAt: -1 });
  const pending = all.filter(a => a.status === 'Pending');
  const approved = all.filter(a => a.status === 'Approved');
  const declined = all.filter(a => a.status === 'Declined');
  res.render('admin-applications-list', { pending, approved, declined });
});

app.get('/admin/applications/:id', requireLogin, async (req, res) => {
  try {
    const app_ = await Application.findById(req.params.id);
    if (!app_) return res.status(404).send('Application not found');
    res.render('admin-application-detail', { app: app_ });
  } catch (err) {
    adminError(res, 'APPLICATION DETAIL ERROR:', err);
  }
});

app.get('/admin/applications/:id/approve', requireLogin, async (req, res) => {
  await Application.findByIdAndUpdate(req.params.id, { status: 'Approved' });
  res.redirect('/admin/applications/' + req.params.id);
});

app.get('/admin/applications/:id/decline', requireLogin, async (req, res) => {
  await Application.findByIdAndUpdate(req.params.id, { status: 'Declined' });
  res.redirect('/admin/applications/' + req.params.id);
});

app.get('/admin/applications/:id/delete', requireLogin, async (req, res) => {
  await Application.findByIdAndDelete(req.params.id);
  res.redirect('/admin/applications');
});

// ===== PUPPY WAITLIST (ADMIN) =====
app.get('/admin/waitlist', requireLogin, async (req, res) => {
  const all = await Waitlist.find().sort({ createdAt: 1 });
  const pending = all.filter(w => w.status === 'Pending Deposit');
  const active = all.filter(w => w.status === 'Active');
  const matched = all.filter(w => w.status === 'Matched');
  const fulfilled = all.filter(w => w.status === 'Fulfilled');
  res.render('admin-waitlist-list', { pending, active, matched, fulfilled });
});

app.get('/admin/waitlist/:id/matched', requireLogin, async (req, res) => {
  await Waitlist.findByIdAndUpdate(req.params.id, { status: 'Matched' });
  res.redirect('/admin/waitlist');
});

app.get('/admin/waitlist/:id/fulfilled', requireLogin, async (req, res) => {
  await Waitlist.findByIdAndUpdate(req.params.id, { status: 'Fulfilled' });
  res.redirect('/admin/waitlist');
});

app.get('/admin/waitlist/:id/cancel', requireLogin, async (req, res) => {
  await Waitlist.findByIdAndUpdate(req.params.id, { status: 'Cancelled' });
  res.redirect('/admin/waitlist');
});

// ===== WAITLIST DEPOSIT RECEIPT — separate document from puppy purchase invoices =====
app.get('/admin/waitlist/:id/deposit-invoice/new', requireLogin, async (req, res) => {
  try {
    const entry = await Waitlist.findById(req.params.id);
    if (!entry) return res.status(404).send('Waitlist entry not found');
    res.render('admin-waitlist-invoice-form', { entry });
  } catch (err) {
    adminError(res, 'WAITLIST INVOICE FORM ERROR:', err);
  }
});

app.post('/admin/waitlist/:id/deposit-invoice', requireLogin, async (req, res) => {
  try {
    const data = req.body;
    const year = new Date().getFullYear();
    const count = await WaitlistInvoice.countDocuments();
    const receiptNumber = `SBK-WL-${year}-${String(count + 1).padStart(4, '0')}`;

    const wInv = await WaitlistInvoice.create({
      receiptNumber,
      waitlist: req.params.id,
      clientName: data.clientName,
      clientEmail: data.clientEmail,
      clientPhone: data.clientPhone,
      clientAddress: data.clientAddress,
      preferredGender: data.preferredGender,
      preferredColor: data.preferredColor,
      depositAmount: parseFloat(data.depositAmount) || 0,
      notes: data.notes,
      signatureData: data.signatureData,
      status: 'Draft'
    });

    try {
      const pdfBuf = await generateWaitlistInvoicePDF(wInv);
      await sendWaitlistInvoiceEmail(wInv, pdfBuf);
      await WaitlistInvoice.findByIdAndUpdate(wInv._id, { status: 'Sent' });
    } catch (emailErr) {
      console.error('Waitlist invoice PDF/email error:', emailErr.message);
    }

    // Mark the waitlist entry Active and link the receipt
    await Waitlist.findByIdAndUpdate(req.params.id, { status: 'Active', invoice: wInv._id });

    res.redirect('/admin/waitlist');
  } catch (err) {
    adminError(res, 'CREATE WAITLIST INVOICE ERROR:', err);
  }
});

app.get('/admin/waitlist-invoices/:id/pdf', requireLogin, async (req, res) => {
  try {
    const wInv = await WaitlistInvoice.findById(req.params.id);
    if (!wInv) return res.status(404).send('Not found');
    const pdfBuf = await generateWaitlistInvoicePDF(wInv);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${wInv.receiptNumber}.pdf"` });
    res.send(pdfBuf);
  } catch (err) { adminError(res, 'WAITLIST PDF ERROR:', err); }
});

async function generateWaitlistInvoicePDF(wInv) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', autoFirstPage: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const maroon = '#7a1e1e', gold = '#c9a227', navy = '#0d1117', gray = '#6b7585', light = '#f9f7f4';
    const W = 495;

    // Header
    doc.rect(0, 0, 595, 90).fill(maroon);
    const possibleLogoPaths = [
      require('path').join(__dirname, 'public', 'images', 'images', 'emblem.png'),
      require('path').join(__dirname, 'public', 'images', 'emblem.png'),
    ];
    for (const lp of possibleLogoPaths) {
      try { if (require('fs').existsSync(lp)) { doc.image(lp, 50, 15, { width: 58, height: 58 }); break; } } catch(e) {}
    }
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(14)
       .text('SHANTI & BRYAN PINSCHER KENNEL', 118, 22, { width: 300 });
    doc.font('Helvetica').fontSize(8).fillColor('rgba(255,255,255,0.75)')
       .text('info@shantibryankennel.com  |  shantibryankennel.com', 118, 42)
       .text('Nationwide Delivery  |  1-Year Health Guarantee', 118, 54);
    doc.fillColor(gold).font('Helvetica-Bold').fontSize(16).text('WAITLIST RECEIPT', 350, 30, { width: 195, align: 'right' });
    doc.fillColor('rgba(255,255,255,0.85)').font('Helvetica').fontSize(9).text(wInv.receiptNumber, 350, 52, { width: 195, align: 'right' });

    // Meta strip
    doc.rect(0, 90, 595, 34).fill('#f0ece3');
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(7.5)
       .text('DATE ISSUED', 50, 99).text('STATUS', 340, 99).text('PREFERENCES', 450, 99);
    doc.fillColor(navy).font('Helvetica').fontSize(8.5)
       .text(new Date(wInv.createdAt).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}), 50, 110)
       .text(wInv.status.toUpperCase(), 340, 110)
       .text(`${wInv.preferredGender || 'N/A'}, ${wInv.preferredColor || 'N/A'}`, 450, 110, { width: 100 });

    let y = 144;

    // Client info
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(8).text('CLIENT', 50, y);
    y += 13;
    doc.moveTo(50, y).lineTo(545, y).strokeColor(gold).lineWidth(1.5).stroke();
    y += 12;
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(10).text(wInv.clientName, 50, y); y += 15;
    doc.fillColor(gray).font('Helvetica').fontSize(8.5);
    if (wInv.clientEmail)   { doc.text(wInv.clientEmail, 50, y); y += 12; }
    if (wInv.clientPhone)   { doc.text(wInv.clientPhone, 50, y); y += 12; }
    if (wInv.clientAddress) { doc.text(wInv.clientAddress, 50, y); y += 12; }

    y += 16;

    // Deposit amount box
    doc.rect(50, y, W, 30).fill('#f0ece3');
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(11)
       .text('WAITLIST DEPOSIT RECEIVED', 60, y + 9)
       .text(`$${wInv.depositAmount.toLocaleString()}`, 490, y + 9, { width: 55, align: 'right' });
    y += 40;

    // Terms — waitlist-specific, distinct from puppy purchase terms
    doc.rect(50, y, W, 13).fill(maroon);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7.5).text('WAITLIST TERMS & CONDITIONS', 60, y + 3);
    y += 18;

    const policies = [
      '1. This deposit secures your place on our waitlist for an upcoming litter matching your stated preferences.',
      '2. This receipt does NOT guarantee a specific puppy, litter, or exact timeline — placement depends on availability.',
      '3. The deposit is non-refundable, but is fully transferable and will be applied toward your future puppy purchase.',
      '4. Once you are matched with a specific puppy, a separate Puppy Purchase Invoice will be issued for the remaining balance.',
      '5. You are responsible for keeping your contact information up to date so we can reach you when a match is available.',
      '6. Waitlist position is maintained in the order deposits are received, though matching also depends on puppy availability, gender, and color preferences.',
      '7. Shanti and Bryan Pinscher Kennel will make reasonable efforts to match you within a fair timeframe, but cannot guarantee an exact date.',
      '8. By signing below, you acknowledge and accept these waitlist terms.',
    ];
    doc.fillColor(navy).font('Helvetica').fontSize(7.8);
    policies.forEach(p => { doc.text(p, 50, y, { width: W, lineGap: 1 }); y += 18; });
    y += 6;

    if (wInv.notes && wInv.notes.trim()) {
      doc.rect(50, y, W, 13).fill('#1a2433');
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7.5).text('NOTES', 60, y + 3);
      y += 17;
      doc.fillColor(navy).font('Helvetica').fontSize(8).text(wInv.notes, 50, y, { width: W });
      y += 20;
    }

    // Stamp (dedicated section, own space)
    y += 10;
    const stampPaths = [
      require('path').join(__dirname, 'public', 'stamp.png'),
    ];
    for (const sp of stampPaths) {
      try { if (require('fs').existsSync(sp)) { doc.image(sp, 50, y, { width: 120, height: 112 }); break; } } catch(e) {}
    }
    y += 128;

    // Signature
    if (wInv.signatureData && wInv.signatureData.startsWith('data:image/png;base64,')) {
      try {
        const sigBuf = Buffer.from(wInv.signatureData.split(',')[1], 'base64');
        doc.image(sigBuf, 50, y - 45, { width: 160, height: 42 });
      } catch(e) {}
    }
    doc.moveTo(50, y).lineTo(230, y).strokeColor(gold).lineWidth(1).stroke();
    doc.moveTo(310, y).lineTo(545, y).strokeColor(gold).lineWidth(1).stroke();
    y += 7;
    doc.fillColor(gray).font('Helvetica').fontSize(7.5)
       .text('Authorized Signature — Shanti & Bryan Kennel', 50, y, { width: 200 })
       .text('Client Signature & Date (Required)', 310, y, { width: 200 });
    y += 14;
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(7)
       .text('ACTION REQUIRED: Sign above, photograph this page, and email to info@shantibryankennel.com', 50, y, { width: W, align: 'center' });
    y += 24;

    doc.rect(50, y, W, 1).fill('#ece5d8');
    y += 8;
    doc.fillColor(gray).font('Helvetica').fontSize(7)
       .text('Thank you for your patience — we look forward to matching you with your future companion.', 50, y, { width: W, align: 'center' });
    y += 12;
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(7)
       .text('info@shantibryankennel.com | shantibryankennel.com', 50, y, { width: W, align: 'center' });

    doc.end();
  });
}

async function sendWaitlistInvoiceEmail(wInv, pdfBuf) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: '"Shanti and Bryan Pinscher Kennel" <info@shantibryankennel.com>',
        to: [wInv.clientEmail],
        replyTo: NOTIFY_EMAIL,
        subject: `Waitlist Deposit Receipt ${wInv.receiptNumber} | Shanti and Bryan Pinscher Kennel`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;">
            <div style="background:#7a1e1e;padding:28px 32px;border-radius:8px 8px 0 0;">
              <h1 style="color:#fff;margin:0;font-size:20px;">Waitlist Deposit Receipt</h1>
              <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:13px;">Shanti and Bryan Pinscher Kennel</p>
            </div>
            <div style="background:#fff;padding:28px 32px;border:1px solid #e6ddc8;">
              <p style="color:#1e293b;font-size:15px;">Dear <strong>${wInv.clientName}</strong>,</p>
              <p style="color:#4a5568;font-size:14px;line-height:1.6;">Thank you! Your deposit has been received and your place on our waitlist is now <strong>active</strong>.</p>
              <div style="background:#f9f7f4;border:1px solid #ece5d8;border-radius:8px;padding:18px;margin:20px 0;">
                <table style="width:100%;border-collapse:collapse;">
                  <tr><td style="padding:5px 0;color:#6b7585;font-size:13px;">Receipt No.</td><td style="padding:5px 0;font-weight:700;color:#1e293b;font-size:13px;text-align:right;">${wInv.receiptNumber}</td></tr>
                  <tr><td style="padding:5px 0;color:#6b7585;font-size:13px;">Preferences</td><td style="padding:5px 0;color:#1e293b;font-size:13px;text-align:right;">${wInv.preferredGender || 'N/A'}, ${wInv.preferredColor || 'N/A'}</td></tr>
                  <tr><td style="padding:5px 0;color:#6b7585;font-size:13px;">Deposit Received</td><td style="padding:5px 0;font-weight:700;color:#2e9e4f;font-size:13px;text-align:right;">$${wInv.depositAmount.toLocaleString()}</td></tr>
                </table>
              </div>
              <div style="background:#fff8f0;border:2px solid #7a1e1e;border-radius:8px;padding:16px;margin:16px 0;">
                <p style="margin:0 0 8px;color:#7a1e1e;font-weight:700;font-size:13px;">✍️ Action Required</p>
                <p style="margin:0;color:#4a5568;font-size:13px;">Please sign the attached receipt, photograph the signed page, and email it back to <a href="mailto:info@shantibryankennel.com" style="color:#7a1e1e;">info@shantibryankennel.com</a>.</p>
              </div>
              <p style="color:#4a5568;font-size:13px;">We'll reach out as soon as a matching puppy becomes available. Thank you for your patience!</p>
              <p style="color:#4a5568;font-size:14px;margin-top:20px;">With love,<br><strong>Shanti and Bryan Pinscher Kennel</strong></p>
            </div>
            <div style="background:#f0ece3;padding:14px 32px;text-align:center;border-radius:0 0 8px 8px;">
              <p style="margin:0;color:#9ca3af;font-size:11px;">shantibryankennel.com | info@shantibryankennel.com</p>
            </div>
          </div>`,
        attachments: [{ filename: `${wInv.receiptNumber}.pdf`, content: pdfBuf.toString('base64') }]
      })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || JSON.stringify(d));
    console.log('[waitlist invoice email] Sent to', wInv.clientEmail);
  } catch (err) {
    console.error('[waitlist invoice email] Failed:', err.message);
  }
}

// ===== INVOICES =====
app.get('/admin/invoices', requireLogin, async (req, res) => {
  const invoices = await Invoice.find().sort({ createdAt: -1 });
  res.render('admin-invoices-list', { invoices });
});

app.get('/admin/invoices/new', requireLogin, async (req, res) => {
  const puppies = await Puppy.find().sort({ createdAt: -1 });
  res.render('admin-invoice-form', { puppies, prefill: null });
});

// Generate the PDF as a buffer (shared by create and resend routes)
async function generateInvoicePDF(inv) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', autoFirstPage: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const maroon = '#7a1e1e';
    const gold   = '#c9a227';
    const navy   = '#0d1117';
    const gray   = '#6b7585';
    const light  = '#f9f7f4';
    const W = 495; // usable width (595 - 50 left - 50 right)

    // ── Header bar ──
    doc.rect(0, 0, 595, 90).fill(maroon);

    // Logo
    const possibleLogoPaths = [
      require('path').join(__dirname, 'public', 'images', 'images', 'emblem.png'),
      require('path').join(__dirname, 'public', 'images', 'emblem.png'),
    ];
    for (const lp of possibleLogoPaths) {
      try {
        if (require('fs').existsSync(lp)) { doc.image(lp, 50, 15, { width: 58, height: 58 }); break; }
      } catch(e) {}
    }

    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(14)
       .text('SHANTI & BRYAN PINSCHER KENNEL', 118, 22, { width: 300 });
    doc.font('Helvetica').fontSize(8).fillColor('rgba(255,255,255,0.75)')
       .text('info@shantibryankennel.com  |  shantibryankennel.com', 118, 42)
       .text('Nationwide Delivery  |  1-Year Health Guarantee', 118, 54);

    doc.fillColor(gold).font('Helvetica-Bold').fontSize(22).text('INVOICE', 430, 22);
    doc.fillColor('rgba(255,255,255,0.85)').font('Helvetica').fontSize(9).text(inv.invoiceNumber, 430, 50);

    // ── Meta strip ──
    doc.rect(0, 90, 595, 34).fill('#f0ece3');
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(7.5)
       .text('DATE ISSUED', 50, 99).text('PAYMENT DUE', 190, 99)
       .text('STATUS', 340, 99).text('DELIVERY', 450, 99);
    doc.fillColor(navy).font('Helvetica').fontSize(8.5)
       .text(new Date(inv.createdAt).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}), 50, 110)
       .text('Before delivery/pickup', 190, 110)
       .text(inv.status.toUpperCase(), 340, 110)
       .text(inv.deliveryMethod, 450, 110);

    let y = 144;

    // ── Bill To + Puppy Details side by side ──
    // Left column header
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(8).text('BILL TO', 50, y);
    // Right column header
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(8).text('PUPPY DETAILS', 320, y);
    y += 13;

    // Gold dividers
    doc.moveTo(50, y).lineTo(268, y).strokeColor(gold).lineWidth(1.5).stroke();
    doc.moveTo(320, y).lineTo(545, y).strokeColor(gold).lineWidth(1.5).stroke();
    y += 12;

    // Left column — client info
    const leftStartY = y;
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(10).text(inv.clientName, 50, y);
    y += 15;
    doc.fillColor(gray).font('Helvetica').fontSize(8.5);
    if (inv.clientEmail)   { doc.text(inv.clientEmail,   50, y); y += 12; }
    if (inv.clientPhone)   { doc.text(inv.clientPhone,   50, y); y += 12; }
    if (inv.clientAddress) { doc.text(inv.clientAddress, 50, y); y += 12; }
    const leftEndY = y;

    // Right column — puppy info (starts at same Y as left column)
    let ry = leftStartY;
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(10).text(inv.puppyName, 320, ry);
    ry += 15;
    doc.fillColor(gray).font('Helvetica').fontSize(8.5);
    doc.text('Breed: Miniature Pinscher', 320, ry); ry += 12;
    if (inv.puppyGender) { doc.text(`Gender: ${inv.puppyGender}`, 320, ry); ry += 12; }
    if (inv.puppyColor)  { doc.text(`Color: ${inv.puppyColor}`,   320, ry); ry += 12; }
    if (inv.puppyDOB)    { doc.text(`DOB: ${new Date(inv.puppyDOB).toLocaleDateString()}`, 320, ry); ry += 12; }

    y = Math.max(leftEndY, ry) + 20;

    // ── Payment table ──
    doc.rect(50, y, W, 26).fill(maroon);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.5)
       .text('DESCRIPTION', 60, y + 8)
       .text('AMOUNT', 460, y + 8, { width: 75, align: 'right' });
    y += 26;

    const rows = [
      [`Miniature Pinscher Puppy — ${inv.puppyName}`, `$${inv.puppyPrice.toLocaleString()}`],
      ['Deposit Received', `- $${inv.depositPaid.toLocaleString()}`],
    ];
    rows.forEach((row, i) => {
      doc.rect(50, y, W, 24).fill(i % 2 === 0 ? '#fff' : light);
      doc.fillColor(navy).font('Helvetica').fontSize(8.5)
         .text(row[0], 60, y + 7)
         .text(row[1], 460, y + 7, { width: 75, align: 'right' });
      y += 24;
    });

    // Balance due
    doc.rect(50, y, W, 30).fill('#f0ece3');
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(11)
       .text('BALANCE DUE', 60, y + 8)
       .text(`$${inv.balanceDue.toLocaleString()}`, 460, y + 8, { width: 75, align: 'right' });
    y += 38;

    // ── Terms ──
    doc.rect(50, y, W, 13).fill(maroon);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7.5).text('TERMS & CONDITIONS', 60, y + 3);
    y += 18;

    const policies = [
      '1. Full balance must be paid IN FULL before the puppy is delivered or picked up. No exceptions.',
      '2. The deposit is non-refundable and is applied toward the total purchase price of the puppy.',
      '3. The buyer is responsible for all delivery/transport costs unless otherwise agreed in writing.',
      '4. This puppy comes with a 1-Year Written Health Guarantee against heritable genetic defects.',
      '5. The buyer agrees to provide proper veterinary care, nutrition, shelter, and a safe loving home.',
      '6. Shanti and Bryan Pinscher Kennel reserves the right to cancel the sale if welfare concerns arise.',
      '7. Once the puppy is in the buyer\'s care, the buyer assumes full legal responsibility for the animal.',
      '8. By proceeding with this purchase, the buyer confirms acceptance of all terms in this invoice.',
    ];
    doc.fillColor(navy).font('Helvetica').fontSize(7.8);
    policies.forEach(p => { doc.text(p, 50, y, { width: W, lineGap: 1 }); y += 13; });
    y += 6;

    // ── Notes ──
    if (inv.notes && inv.notes.trim()) {
      doc.rect(50, y, W, 13).fill('#1a2433');
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7.5).text('ADDITIONAL NOTES', 60, y + 3);
      y += 17;
      doc.fillColor(navy).font('Helvetica').fontSize(8).text(inv.notes, 50, y, { width: W });
      y += 20;
    }

    // ── Official Stamp ── (your real stamp image, recolored maroon)
    y += 14;
    const stampPaths = [
      require('path').join(__dirname, 'public', 'stamp.png'),
      require('path').join(__dirname, 'public', 'images', 'stamp.png'),
    ];
    let stampDrawn = false;
    for (const sp of stampPaths) {
      try {
        if (require('fs').existsSync(sp)) {
          doc.image(sp, 50, y, { width: 140, height: 130 });
          stampDrawn = true;
          break;
        }
      } catch(e) {}
    }
    if (!stampDrawn) {
      // Fallback: simple text stamp if image not found
      doc.circle(115, y + 65, 60).lineWidth(2).strokeColor(maroon).stroke();
      doc.fillColor(maroon).font('Helvetica-Bold').fontSize(8)
         .text('SHANTI & BRYAN', 75, y + 40, { width: 80, align: 'center' })
         .text('PINSCHER KENNEL', 75, y + 52, { width: 80, align: 'center' })
         .text('OFFICIAL BREEDING SEAL', 68, y + 72, { width: 94, align: 'center' })
         .text('★★ EST. 2011 ★★', 75, y + 84, { width: 80, align: 'center' });
    }
    y += 148;

    // ── Signature lines ── clearly below the stamp
    if (inv.signatureData && inv.signatureData.startsWith('data:image/png;base64,')) {
      try {
        const sigBuf = Buffer.from(inv.signatureData.split(',')[1], 'base64');
        doc.image(sigBuf, 50, y - 48, { width: 180, height: 45 });
      } catch(e) {}
    }

    doc.moveTo(50, y).lineTo(230, y).strokeColor(gold).lineWidth(1).stroke();
    doc.moveTo(310, y).lineTo(545, y).strokeColor(gold).lineWidth(1).stroke();
    y += 7;
    doc.fillColor(gray).font('Helvetica').fontSize(7.5)
       .text('Authorized Signature — Shanti & Bryan Kennel', 50, y, { width: 200 })
       .text('Client Signature & Date (Required)', 310, y, { width: 200 });
    y += 14;
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(7)
       .text('ACTION REQUIRED: Sign above, photograph this page, and email to info@shantibryankennel.com', 50, y, { width: W, align: 'center' });
    y += 30;

    // ── Footer (drawn inline, no absolute positioning) ──
    doc.rect(50, y, W, 1).fill('#ece5d8');
    y += 8;
    doc.fillColor(gray).font('Helvetica').fontSize(7)
       .text('Thank you for choosing Shanti and Bryan Pinscher Kennel. We are honored to place one of our beloved puppies with your family.', 50, y, { width: W, align: 'center' });
    y += 12;
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(7)
       .text('info@shantibryankennel.com  |  shantibryankennel.com', 50, y, { width: W, align: 'center' });

    doc.end();
  });
}

// Create invoice + generate PDF + send email
app.post('/admin/invoices/new', requireLogin, async (req, res) => {
  try {
    const data = req.body;

    // Generate invoice number safely here instead of in a pre-save hook
    const year = new Date().getFullYear();
    const count = await Invoice.countDocuments();
    const invoiceNumber = `SBK-${year}-${String(count + 1).padStart(4, '0')}`;

    // Calculate balance
    const puppyPrice  = parseFloat(data.puppyPrice) || 0;
    const depositPaid = parseFloat(data.depositPaid) || 0;
    const balanceDue  = parseFloat(data.balanceDue) || (puppyPrice - depositPaid);

    const inv = await Invoice.create({
      invoiceNumber,
      puppy:         data.puppyId || null,
      puppyName:     data.puppyName,
      puppyGender:   data.puppyGender,
      puppyColor:    data.puppyColor,
      puppyDOB:      data.puppyDOB || null,
      puppyPrice,
      depositPaid,
      balanceDue,
      clientName:    data.clientName,
      clientEmail:   data.clientEmail,
      clientPhone:   data.clientPhone,
      clientAddress: data.clientAddress,
      deliveryMethod: data.deliveryMethod,
      notes:         data.notes,
      signatureData: data.signatureData,
      status:        'Draft'
    });

    // Generate PDF and send email — errors here don't block invoice saving
    try {
      const pdfBuf = await generateInvoicePDF(inv);
      await sendInvoiceEmail(inv, pdfBuf);
      await Invoice.findByIdAndUpdate(inv._id, { status: 'Sent', sentAt: new Date() });
    } catch (emailErr) {
      console.error('Invoice PDF/email error:', emailErr.message);
      // Invoice is saved — admin can resend from the list
    }

    res.redirect('/admin/invoices');
  } catch (err) {
    adminError(res, 'CREATE INVOICE ERROR:', err);
  }
});

// Download PDF
app.get('/admin/invoices/:id/pdf', requireLogin, async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return res.status(404).send('Invoice not found');
    const pdfBuf = await generateInvoicePDF(inv);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${inv.invoiceNumber}.pdf"` });
    res.send(pdfBuf);
  } catch (err) { adminError(res, 'PDF ERROR:', err); }
});

// Resend email
app.get('/admin/invoices/:id/send', requireLogin, async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return res.status(404).send('Invoice not found');
    const pdfBuf = await generateInvoicePDF(inv);
    await sendInvoiceEmail(inv, pdfBuf);
    await Invoice.findByIdAndUpdate(inv._id, { status: 'Sent', sentAt: new Date() });
    res.redirect('/admin/invoices');
  } catch (err) { adminError(res, 'RESEND ERROR:', err); }
});

// Mark as paid
app.get('/admin/invoices/:id/mark-paid', requireLogin, async (req, res) => {
  await Invoice.findByIdAndUpdate(req.params.id, { status: 'Paid' });
  res.redirect('/admin/invoices');
});

// Delete
app.get('/admin/invoices/:id/delete', requireLogin, async (req, res) => {
  await Invoice.findByIdAndDelete(req.params.id);
  res.redirect('/admin/invoices');
});

// Send invoice email helper
async function sendInvoiceEmail(inv, pdfBuf) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[invoice email] RESEND_API_KEY not set — skipped');
    return;
  }
  try {
    const pdfBase64 = pdfBuf.toString('base64');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: '"Shanti and Bryan Pinscher Kennel" <info@shantibryankennel.com>',
        to: [inv.clientEmail],
        replyTo: NOTIFY_EMAIL,
        subject: `Invoice ${inv.invoiceNumber} — ${inv.puppyName} | Shanti and Bryan Pinscher Kennel`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;">
            <div style="background:#7a1e1e;padding:28px 32px;border-radius:8px 8px 0 0;">
              <h1 style="color:#fff;margin:0;font-size:20px;">Shanti and Bryan Pinscher Kennel</h1>
              <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:13px;">Your Puppy Invoice</p>
            </div>
            <div style="background:#fff;padding:28px 32px;border:1px solid #e6ddc8;">
              <p style="color:#1e293b;font-size:15px;">Dear <strong>${inv.clientName}</strong>,</p>
              <p style="color:#4a5568;font-size:14px;line-height:1.6;">Thank you for choosing Shanti and Bryan Pinscher Kennel! We're so excited to place <strong>${inv.puppyName}</strong> with your family.</p>
              <p style="color:#4a5568;font-size:14px;line-height:1.6;">Please find your invoice attached to this email (Invoice <strong>${inv.invoiceNumber}</strong>).</p>
              <div style="background:#f9f7f4;border:1px solid #ece5d8;border-radius:8px;padding:18px;margin:20px 0;">
                <table style="width:100%;border-collapse:collapse;">
                  <tr><td style="padding:5px 0;color:#6b7585;font-size:13px;">Puppy</td><td style="padding:5px 0;font-weight:700;color:#1e293b;font-size:13px;text-align:right;">${inv.puppyName}</td></tr>
                  <tr><td style="padding:5px 0;color:#6b7585;font-size:13px;">Total Price</td><td style="padding:5px 0;font-weight:700;color:#1e293b;font-size:13px;text-align:right;">$${inv.puppyPrice.toLocaleString()}</td></tr>
                  <tr><td style="padding:5px 0;color:#6b7585;font-size:13px;">Deposit Paid</td><td style="padding:5px 0;font-weight:700;color:#2e9e4f;font-size:13px;text-align:right;">- $${inv.depositPaid.toLocaleString()}</td></tr>
                  <tr style="border-top:2px solid #7a1e1e;"><td style="padding:10px 0 5px;color:#7a1e1e;font-weight:700;font-size:14px;">Balance Due</td><td style="padding:10px 0 5px;font-weight:700;color:#7a1e1e;font-size:14px;text-align:right;">$${inv.balanceDue.toLocaleString()}</td></tr>
                </table>
              </div>
              <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:14px;margin:16px 0;">
                <p style="margin:0;color:#92400e;font-size:13px;font-weight:700;">⚠️ Important: Balance must be paid in full before ${inv.deliveryMethod.toLowerCase()}.</p>
              </div>

              <div style="background:#fff8f0;border:2px solid #7a1e1e;border-radius:8px;padding:18px 20px;margin:20px 0;">
                <p style="margin:0 0 8px;color:#7a1e1e;font-size:14px;font-weight:700;">✍️ Action Required — Please Sign & Return</p>
                <p style="margin:0 0 10px;color:#4a5568;font-size:13px;line-height:1.6;">To confirm your agreement to the terms and conditions in this invoice, please:</p>
                <ol style="margin:0 0 10px;padding-left:18px;color:#4a5568;font-size:13px;line-height:1.8;">
                  <li>Print the attached PDF invoice</li>
                  <li>Sign on the <strong>"Client Acknowledgment / Signature"</strong> line</li>
                  <li>Take a clear photo or scan of the signed page</li>
                  <li>Email the signed copy back to us at <a href="mailto:info@shantibryankennel.com" style="color:#7a1e1e;font-weight:700;">info@shantibryankennel.com</a></li>
                </ol>
                <p style="margin:0;color:#7a5a00;font-size:12px;background:#fff3cd;padding:8px 10px;border-radius:4px;">By signing and returning this invoice, you confirm that you have read, understood, and agreed to all terms and conditions stated herein. Your puppy will not be shipped or made available for pickup until a signed copy is received and the balance has been paid in full.</p>
              </div>

              <p style="color:#4a5568;font-size:13px;">If you have any questions, please don't hesitate to reach out:</p>
              <p style="color:#4a5568;font-size:13px;">📧 <a href="mailto:info@shantibryankennel.com" style="color:#7a1e1e;">info@shantibryankennel.com</a></p>
              <p style="color:#4a5568;font-size:14px;margin-top:20px;">With love,<br><strong>Shanti and Bryan Pinscher Kennel</strong></p>
            </div>
            <div style="background:#f0ece3;padding:14px 32px;text-align:center;border-radius:0 0 8px 8px;">
              <p style="margin:0;color:#9ca3af;font-size:11px;">shantibryankennel.com | info@shantibryankennel.com</p>
            </div>
          </div>`,
        attachments: [{ filename: `${inv.invoiceNumber}.pdf`, content: pdfBase64 }]
      })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || JSON.stringify(d));
    console.log('[invoice email] Sent to', inv.clientEmail, 'id:', d.id);
  } catch (err) {
    console.error('[invoice email] Failed:', err.message);
  }
}

// ===== CERTIFICATES OF OWNERSHIP =====
app.get('/admin/certificates', requireLogin, async (req, res) => {
  const certificates = await Certificate.find().sort({ createdAt: -1 });
  res.render('admin-certificates-list', { certificates });
});

app.get('/admin/certificates/new', requireLogin, async (req, res) => {
  let invoice = null;
  if (req.query.invoice) {
    invoice = await Invoice.findById(req.query.invoice).catch(() => null);
  }
  res.render('admin-certificate-form', { invoice });
});

app.post('/admin/certificates/new', requireLogin, async (req, res) => {
  try {
    const data = req.body;
    const year = new Date().getFullYear();
    const count = await Certificate.countDocuments();
    const certificateNumber = `SBK-COT-${year}-${String(count + 1).padStart(4, '0')}`;

    const cert = await Certificate.create({
      certificateNumber,
      invoice:      data.invoiceId || null,
      puppyName:    data.puppyName,
      puppyBreed:   data.puppyBreed || 'Miniature Pinscher',
      puppyGender:  data.puppyGender,
      puppyColor:   data.puppyColor,
      puppyDOB:     data.puppyDOB || null,
      microchip:    data.microchip,
      buyerName:    data.buyerName,
      buyerEmail:   data.buyerEmail,
      buyerPhone:   data.buyerPhone,
      buyerAddress: data.buyerAddress,
      transferDate: data.transferDate || new Date(),
      salePrice:    parseFloat(data.salePrice) || null,
      signatureData: data.signatureData,
      status: 'Draft'
    });

    try {
      const pdfBuf = await generateCertificatePDF(cert);
      await sendCertificateEmail(cert, pdfBuf);
      await Certificate.findByIdAndUpdate(cert._id, { status: 'Sent' });
    } catch(e) {
      console.error('Certificate PDF/email error:', e.message);
    }

    res.redirect('/admin/certificates');
  } catch(err) {
    adminError(res, 'CREATE CERTIFICATE ERROR:', err);
  }
});

app.get('/admin/certificates/:id/pdf', requireLogin, async (req, res) => {
  try {
    const cert = await Certificate.findById(req.params.id);
    if (!cert) return res.status(404).send('Not found');
    const pdfBuf = await generateCertificatePDF(cert);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${cert.certificateNumber}.pdf"` });
    res.send(pdfBuf);
  } catch(err) { adminError(res, 'CERT PDF ERROR:', err); }
});

app.get('/admin/certificates/:id/send', requireLogin, async (req, res) => {
  try {
    const cert = await Certificate.findById(req.params.id);
    if (!cert) return res.status(404).send('Not found');
    const pdfBuf = await generateCertificatePDF(cert);
    await sendCertificateEmail(cert, pdfBuf);
    await Certificate.findByIdAndUpdate(cert._id, { status: 'Sent' });
    res.redirect('/admin/certificates');
  } catch(err) { adminError(res, 'CERT SEND ERROR:', err); }
});

app.get('/admin/certificates/:id/delete', requireLogin, async (req, res) => {
  await Certificate.findByIdAndDelete(req.params.id);
  res.redirect('/admin/certificates');
});

async function generateCertificatePDF(cert) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const maroon = '#7a1e1e';
    const gold   = '#c9a227';
    const navy   = '#0d1117';
    const gray   = '#6b7585';
    const W = 595, H = 842;

    // ── Outer decorative border ──
    doc.rect(15, 15, W-30, H-30).lineWidth(3).strokeColor(maroon).stroke();
    doc.rect(22, 22, W-44, H-44).lineWidth(1).strokeColor(gold).stroke();
    doc.rect(27, 27, W-54, H-54).lineWidth(0.5).strokeColor(maroon).stroke();

    // Corner ornaments (small squares at each corner)
    [[15,15],[W-30,15],[15,H-30],[W-30,H-30]].forEach(([cx,cy]) => {
      doc.rect(cx-5, cy-5, 20, 20).fillAndStroke(maroon, maroon);
    });

    // ── Header ──
    doc.rect(0, 0, W, 130).fill(maroon);

    // Logo
    const logoPath = require('path').join(__dirname, 'public', 'images', 'images', 'emblem.png');
    const logoPath2 = require('path').join(__dirname, 'public', 'images', 'emblem.png');
    try {
      if (require('fs').existsSync(logoPath)) doc.image(logoPath, 35, 20, { width: 80, height: 80 });
      else if (require('fs').existsSync(logoPath2)) doc.image(logoPath2, 35, 20, { width: 80, height: 80 });
    } catch(e) {}

    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(18)
       .text('SHANTI & BRYAN PINSCHER KENNEL', 130, 32, { width: 420, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.8)')
       .text('Registered Miniature Pinscher Breeder  •  Est. 2011', 130, 58, { width: 420, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(gold)
       .text('info@shantibryankennel.com  |  shantibryankennel.com', 130, 72, { width: 420, align: 'center' });

    // ── Certificate title ──
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(22)
       .text('CERTIFICATE OF TRANSFER OF OWNERSHIP', 40, 148, { width: W-80, align: 'center' });

    // Gold underline
    const titleY = 178;
    doc.moveTo(100, titleY).lineTo(W-100, titleY).lineWidth(2).strokeColor(gold).stroke();
    doc.moveTo(120, titleY+4).lineTo(W-120, titleY+4).lineWidth(0.5).strokeColor(gold).stroke();

    doc.fillColor(gray).font('Helvetica').fontSize(10)
       .text('This document certifies the legal transfer of ownership of the below-described puppy', 60, titleY+14, { width: W-120, align: 'center' })
       .text('from Shanti and Bryan Pinscher Kennel to the new owner named herein.', 60, titleY+28, { width: W-120, align: 'center' });

    // ── Certificate Number & Date ──
    doc.rect(40, 222, W-80, 28).fill('#f9f7f4');
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(9)
       .text(`Certificate No: ${cert.certificateNumber}`, 55, 231, { continued: true })
       .fillColor(gray).font('Helvetica').fontSize(9)
       .text(`          Transfer Date: ${new Date(cert.transferDate).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})}`, { continued: true })
       .text(`          Ref: Shanti and Bryan Pinscher Kennel`, 55);

    let y = 265;

    // ── Two-column info sections ──
    const colL = 45, colR = 315, colW = 240;

    // Puppy Details box
    doc.rect(colL, y, colW, 16).fill(maroon);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9).text('PUPPY DETAILS', colL+8, y+4);

    doc.rect(colR, y, colW, 16).fill(maroon);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9).text('NEW OWNER DETAILS', colR+8, y+4);
    y += 16;

    // Box backgrounds
    doc.rect(colL, y, colW, 115).fill('#faf7f0').stroke();
    doc.rect(colR, y, colW, 115).fill('#faf7f0').stroke();

    // Puppy info
    let py = y + 10;
    const puppyFields = [
      ['Name',   cert.puppyName],
      ['Breed',  cert.puppyBreed],
      ['Gender', cert.puppyGender],
      ['Color',  cert.puppyColor],
      ['DOB',    cert.puppyDOB ? new Date(cert.puppyDOB).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) : '—'],
      ['Microchip', cert.microchip || 'Not applicable'],
    ];
    puppyFields.forEach(([label, val]) => {
      doc.fillColor(gray).font('Helvetica-Bold').fontSize(8).text(label + ':', colL+8, py, { continued: true })
         .fillColor(navy).font('Helvetica').fontSize(8).text('  ' + (val || '—'));
      py += 16;
    });

    // Owner info
    let oy = y + 10;
    const ownerFields = [
      ['Full Name',   cert.buyerName],
      ['Email',       cert.buyerEmail],
      ['Phone',       cert.buyerPhone || '—'],
      ['Address',     cert.buyerAddress || '—'],
    ];
    ownerFields.forEach(([label, val]) => {
      doc.fillColor(gray).font('Helvetica-Bold').fontSize(8).text(label + ':', colR+8, oy, { continued: true })
         .fillColor(navy).font('Helvetica').fontSize(8).text('  ' + (val || '—'));
      oy += 16;
    });

    y += 125;

    // ── Declaration text ──
    y += 10;
    doc.moveTo(45, y).lineTo(W-45, y).lineWidth(0.5).strokeColor(gold).stroke();
    y += 12;

    const transferDate = new Date(cert.transferDate).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    const declaration = `We, Shanti and Bryan Pinscher Kennel, hereby certify that on ${transferDate}, full and complete ownership of the above-described Miniature Pinscher puppy named "${cert.puppyName}" has been legally and irrevocably transferred to ${cert.buyerName}. The puppy has been raised in our home with the highest standards of care, socialization, and veterinary attention. The new owner has been provided with all health records, vaccination certificates, and applicable documentation pertaining to this animal.`;

    doc.fillColor(navy).font('Helvetica').fontSize(9.5)
       .text(declaration, 45, y, { width: W-90, align: 'justify', lineGap: 3 });

    y += 85;

    // ── Health Guarantee box ──
    doc.rect(45, y, W-90, 46).fill('#fff8f0').strokeColor('#e6ddc8').lineWidth(1).stroke();
    doc.fillColor(maroon).font('Helvetica-Bold').fontSize(8.5)
       .text('1-YEAR HEALTH GUARANTEE', 60, y+8);
    doc.fillColor(gray).font('Helvetica').fontSize(8)
       .text('This puppy is guaranteed against hereditary and congenital defects for a period of one (1) year from the date of transfer. The new owner agrees to provide proper veterinary care, nutrition, shelter, and a safe, loving environment for the lifetime of this animal.', 60, y+20, { width: W-120, lineGap: 1 });
    y += 56;

    // ── Conditions ──
    y += 8;
    const conditions = [
      '• The seller warrants that the puppy was healthy at the time of transfer and free from known defects.',
      '• The buyer accepts full legal and financial responsibility for the puppy from the date of transfer.',
      '• This certificate does not guarantee against conditions resulting from neglect, accident, or improper care.',
      '• Any disputes arising from this transfer shall be resolved through good-faith negotiation between both parties.',
    ];
    doc.fillColor(gray).font('Helvetica').fontSize(8);
    conditions.forEach(c => { doc.text(c, 45, y, { width: W-90, lineGap: 1 }); y += 13; });

    y += 12;
    doc.moveTo(45, y).lineTo(W-45, y).lineWidth(0.5).strokeColor(gold).stroke();
    y += 16;

    // ── Signatures ──
    const sig1X = 45, sig2X = 350;

    // Stamp on Bryan's side (left)
    const stampPath = require('path').join(__dirname, 'public', 'stamp.png');
    try {
      if (require('fs').existsSync(stampPath)) {
        doc.image(stampPath, sig1X, y, { width: 90, height: 90 });
      }
    } catch(e) {}

    // Bryan's signature image (over the stamp, slightly offset)
    if (cert.signatureData && cert.signatureData.startsWith('data:image/png;base64,')) {
      try {
        const sigBuf = Buffer.from(cert.signatureData.split(',')[1], 'base64');
        doc.image(sigBuf, sig1X + 10, y + 48, { width: 150, height: 36 });
      } catch(e) {}
    }

    // Signature lines
    y += 90;
    doc.moveTo(sig1X, y).lineTo(sig1X + 220, y).lineWidth(1).strokeColor(maroon).stroke();
    doc.moveTo(sig2X, y).lineTo(sig2X + 200, y).lineWidth(1).strokeColor(maroon).stroke();

    y += 6;
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(8)
       .text('Shanti and Bryan Pinscher Kennel', sig1X, y)
       .text('New Owner Signature & Date', sig2X, y);
    doc.fillColor(gray).font('Helvetica').fontSize(7.5)
       .text('Authorized Breeder Signature', sig1X, y + 11)
       .text('I accept the transfer of ownership', sig2X, y + 11);

    // ── Footer bar ──
    doc.rect(0, H-55, W, 55).fill(maroon);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(10)
       .text('OFFICIAL DOCUMENT — RETAIN FOR YOUR RECORDS', 0, H-44, { width: W, align: 'center' });
    doc.fillColor('rgba(255,255,255,0.75)').font('Helvetica').fontSize(8)
       .text('Shanti and Bryan Pinscher Kennel  •  info@shantibryankennel.com  •  shantibryankennel.com', 0, H-30, { width: W, align: 'center' });

    doc.end();
  });
}

async function sendCertificateEmail(cert, pdfBuf) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const transferDate = new Date(cert.transferDate).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: '"Shanti and Bryan Pinscher Kennel" <info@shantibryankennel.com>',
        to: [cert.buyerEmail],
        replyTo: NOTIFY_EMAIL,
        subject: `Certificate of Ownership — ${cert.puppyName} | Shanti and Bryan Pinscher Kennel`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;">
            <div style="background:#7a1e1e;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">
              <h1 style="color:#fff;margin:0;font-size:20px;">Certificate of Transfer of Ownership</h1>
              <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:13px;">Shanti and Bryan Pinscher Kennel</p>
            </div>
            <div style="background:#fff;padding:28px 32px;border:1px solid #e6ddc8;">
              <p style="color:#1e293b;font-size:15px;">Dear <strong>${cert.buyerName}</strong>,</p>
              <p style="color:#4a5568;font-size:14px;line-height:1.6;">Congratulations! Please find attached your official <strong>Certificate of Transfer of Ownership</strong> for your Miniature Pinscher <strong>${cert.puppyName}</strong>.</p>
              <div style="background:#f9f7f4;border:1px solid #ece5d8;border-radius:8px;padding:18px;margin:20px 0;">
                <table style="width:100%;border-collapse:collapse;">
                  <tr><td style="padding:5px 0;color:#6b7585;font-size:13px;">Certificate No.</td><td style="padding:5px 0;font-weight:700;color:#1e293b;font-size:13px;text-align:right;">${cert.certificateNumber}</td></tr>
                  <tr><td style="padding:5px 0;color:#6b7585;font-size:13px;">Puppy Name</td><td style="padding:5px 0;font-weight:700;color:#1e293b;font-size:13px;text-align:right;">${cert.puppyName}</td></tr>
                  <tr><td style="padding:5px 0;color:#6b7585;font-size:13px;">Breed</td><td style="padding:5px 0;color:#1e293b;font-size:13px;text-align:right;">${cert.puppyBreed}</td></tr>
                  <tr><td style="padding:5px 0;color:#6b7585;font-size:13px;">Transfer Date</td><td style="padding:5px 0;color:#1e293b;font-size:13px;text-align:right;">${transferDate}</td></tr>
                </table>
              </div>
              <div style="background:#fff8f0;border:2px solid #7a1e1e;border-radius:8px;padding:16px;margin:16px 0;">
                <p style="margin:0 0 8px;color:#7a1e1e;font-weight:700;font-size:13px;">✍️ Action Required</p>
                <p style="margin:0;color:#4a5568;font-size:13px;">Please sign the certificate, take a photo of the signed page, and email it back to <a href="mailto:info@shantibryankennel.com" style="color:#7a1e1e;">info@shantibryankennel.com</a> to complete the transfer.</p>
              </div>
              <p style="color:#4a5568;font-size:14px;margin-top:20px;">Welcome to the Shanti & Bryan family! 🐾<br><br>With love,<br><strong>Shanti and Bryan Pinscher Kennel</strong></p>
            </div>
            <div style="background:#f0ece3;padding:14px 32px;text-align:center;border-radius:0 0 8px 8px;">
              <p style="margin:0;color:#9ca3af;font-size:11px;">shantibryankennel.com | info@shantibryankennel.com</p>
            </div>
          </div>`,
        attachments: [{ filename: `${cert.certificateNumber}.pdf`, content: pdfBuf.toString('base64') }]
      })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || JSON.stringify(d));
    console.log('[cert email] Sent to', cert.buyerEmail);
  } catch(err) {
    console.error('[cert email] Failed:', err.message);
  }
}

// Ensures /api/ routes always get JSON back, even on unexpected crashes
// (prevents "Unexpected token '<'" errors in the frontend)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  if (req.path.startsWith('/api/')) {
    return res.status(err.status || 500).json({ ok: false, reply: `Server error: ${err.message}` });
  }
  next(err);
});

// ===== SITEMAP — auto-updates as puppies/litters/posts are added or removed =====
app.get('/sitemap.xml', async (req, res) => {
  try {
    const baseUrl = 'https://shantibryankennel.com';
    const today = new Date().toISOString().split('T')[0];

    // Static pages that always exist
    const staticPages = [
      { url: '/',              priority: '1.0', changefreq: 'weekly'  },
      { url: '/puppies',       priority: '0.9', changefreq: 'daily'   },
      { url: '/apply',         priority: '0.8', changefreq: 'monthly' },
      { url: '/waitlist',      priority: '0.7', changefreq: 'monthly' },
      { url: '/litters',       priority: '0.8', changefreq: 'weekly'  },
      { url: '/our-dogs',      priority: '0.7', changefreq: 'monthly' },
      { url: '/about',         priority: '0.6', changefreq: 'monthly' },
      { url: '/process',       priority: '0.6', changefreq: 'monthly' },
      { url: '/deposit',       priority: '0.5', changefreq: 'monthly' },
      { url: '/faq',           priority: '0.6', changefreq: 'monthly' },
      { url: '/testimonials',  priority: '0.7', changefreq: 'weekly'  },
      { url: '/submit-review', priority: '0.4', changefreq: 'monthly' },
      { url: '/blog',          priority: '0.6', changefreq: 'weekly'  },
      { url: '/contact',       priority: '0.7', changefreq: 'monthly' },
      { url: '/privacy',       priority: '0.3', changefreq: 'yearly'  },
    ];

    // Dynamic pages pulled live from the database
    const [puppies, litters, posts] = await Promise.all([
      Puppy.find().select('_id createdAt').lean(),
      Litter.find().select('_id createdAt').lean(),
      Post.find({ published: true }).select('slug createdAt').lean()
    ]);

    let urls = staticPages.map(p => `
  <url>
    <loc>${baseUrl}${p.url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('');

    puppies.forEach(p => {
      const lastmod = (p.createdAt || new Date()).toISOString().split('T')[0];
      urls += `
  <url>
    <loc>${baseUrl}/puppies/${p._id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
    });

    litters.forEach(l => {
      const lastmod = (l.createdAt || new Date()).toISOString().split('T')[0];
      urls += `
  <url>
    <loc>${baseUrl}/litters/${l._id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`;
    });

    posts.forEach(post => {
      const lastmod = (post.createdAt || new Date()).toISOString().split('T')[0];
      urls += `
  <url>
    <loc>${baseUrl}/blog/${post.slug}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>`;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}
</urlset>`;

    res.set('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err) {
    console.error('Sitemap error:', err.message);
    res.status(500).send('Error generating sitemap');
  }
});

// ===== 404 — must be the last route, catches anything not matched above =====
app.use((req, res) => {
  res.status(404).render('404');
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// ===== KEEP-ALIVE (prevents Render free-tier from spinning down after 15 min idle) =====
// Render automatically sets RENDER_EXTERNAL_URL in production to this service's public URL.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  const PING_INTERVAL = 10 * 60 * 1000; // 10 minutes (under Render's 15-min idle limit)
  setInterval(() => {
    try {
      const u = new URL(`${SELF_URL}/healthz`);
      https.get({ hostname: u.hostname, path: u.pathname, timeout: 10000 }, (res) => {
        console.log(`[keep-alive] ping -> ${res.statusCode}`);
      }).on('error', (err) => {
        console.log(`[keep-alive] ping failed: ${err.message}`);
      });
    } catch (err) {
      console.log(`[keep-alive] ping setup failed: ${err.message}`);
    }
  }, PING_INTERVAL);
  console.log('[keep-alive] self-ping enabled every 10 minutes');
} else {
  console.log('[keep-alive] RENDER_EXTERNAL_URL not set, self-ping disabled (normal for local dev)');
}
