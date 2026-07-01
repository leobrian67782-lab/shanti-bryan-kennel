require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const https = require('https');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const Puppy = require('./models/Puppy');
const Litter = require('./models/Litter');
const Contact = require('./models/Contact');
const Testimonial = require('./models/Testimonial');
const Faq = require('./models/Faq');
const Settings = require('./models/Settings');
const Post = require('./models/Post');
const Dog = require('./models/Dog');

const app = express();

// ===== EMAIL NOTIFICATIONS =====
// Uses Gmail SMTP. In Render, set EMAIL_PASS to a Gmail App Password
// (Google Account → Security → 2-Step Verification → App passwords).
// EMAIL_USER defaults to your kennel address; override with EMAIL_USER env var if needed.
const NOTIFY_EMAIL = 'shantibryan644@gmail.com';
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || NOTIFY_EMAIL,
    pass: process.env.EMAIL_PASS || ''
  }
});

async function sendNotification(subject, html) {
  if (!process.env.EMAIL_PASS) {
    console.log('[email] EMAIL_PASS not set, notification skipped:', subject);
    return;
  }
  try {
    await emailTransporter.sendMail({
      from: `"Shanti & Bryan Pinscher Kennel" <${process.env.EMAIL_USER || NOTIFY_EMAIL}>`,
      to: NOTIFY_EMAIL,
      subject,
      html
    });
    console.log('[email] Sent:', subject);
  } catch (err) {
    console.error('[email] Failed to send:', err.message);
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
app.use(express.json());

// Lightweight health-check (used by the keep-alive self-ping below, and can
// also be pointed to by an external uptime monitor like UptimeRobot or cron-job.org)
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// Sessions
if (!process.env.SESSION_SECRET) {
  console.warn('[security] SESSION_SECRET is not set in your environment variables. Using a random secret generated for this run instead — this means everyone will be logged out every time the server restarts or redeploys. Set SESSION_SECRET in Render for persistent, secure sessions.');
}
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false
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
    res.render('puppy-detail', { puppy, description: `Meet ${puppy.name} — a ${puppy.color} ${puppy.gender} Miniature Pinscher available from Shanti & Bryan Pinscher Kennel. ${puppy.description ? puppy.description.substring(0, 100) : ''}`, ogImg: puppy.photos && puppy.photos.length > 0 ? puppy.photos[0] : '' });
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

app.post('/submit-review', upload.single('photo'), async (req, res) => {
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
        <p style="margin-top:20px;"><a href="https://${process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL.replace('https://','') : 'yoursite.onrender.com'}/admin/testimonials" style="background:#c9a227;color:#0d1117;padding:10px 20px;text-decoration:none;border-radius:6px;font-weight:bold;">Approve or Reject in Admin</a></p>
      </div>`
    );

    res.render('submit-review', { sent: true, error: '' });
  } catch (err) {
    console.error('SUBMIT REVIEW ERROR:', err);
    res.render('submit-review', { sent: false, error: 'Something went wrong. Please try again.' });
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

app.post('/contact', async (req, res) => {
  try {
    const { name, email, phone, location, subject, message } = req.body;
    if (!name || !email || !subject || !message) {
      return res.render('contact', { message: 'All fields are required.', success: false });
    }

    // Try to auto-detect location from the visitor's IP (best-effort, never blocks the message)
    let detectedLocation = '';
    try {
      let ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
      ip = ip.replace('::ffff:', '');
      if (ip && ip !== '127.0.0.1' && ip !== '::1' && !ip.startsWith('192.168.') && !ip.startsWith('10.')) {
        const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city`);
        const geo = await geoRes.json();
        if (geo && geo.status === 'success') {
          detectedLocation = [geo.city, geo.regionName, geo.country].filter(Boolean).join(', ');
        }
      }
    } catch (geoErr) {
      console.log('Geo lookup skipped:', geoErr.message);
    }

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
        <p style="margin-top:20px;"><a href="https://${process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL.replace('https://','') : 'yoursite.onrender.com'}/admin/inquiries" style="background:#7a1e1e;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">View in Admin</a></p>
      </div>`
    );

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
  res.render('admin-dashboard', { puppies, litters, testimonials, pendingReviews, faqs, posts, inquiries, dogs });
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
