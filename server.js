require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIG ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PAYHERO_API_URL =
  process.env.PAYHERO_API_URL ||
  'https://payherokenya.com/sps/portal/app/stk.php';
const PAYHERO_CALLBACK_URL = process.env.PAYHERO_CALLBACK_URL || '';

if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET not set – using insecure default.');
}
if (!PAYHERO_CALLBACK_URL) {
  console.warn('⚠️  PAYHERO_CALLBACK_URL not set – PayHero callback will fail.');
}

const TIERS = {
  free:    { name: 'Free',    dailyLimit: 0,  price: 0,   label: 'No access' },
  classic: { name: 'Classic', dailyLimit: 10, price: 200, label: '10 tasks / day' },
  premium: { name: 'Premium', dailyLimit: 20, price: 350, label: '20 tasks / day' },
  golden:  { name: 'Golden',  dailyLimit: 50, price: 450, label: '50+ tasks / day' }
};
const SUBSCRIPTION_DAYS = 7;

// ─── MONGODB ───────────────────────────────────────────────────────────────
let db, usersCol, txnsCol;

async function connectDB() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000
  });
  await client.connect();
  db = client.db('payhero_jobs');
  usersCol = db.collection('users');
  txnsCol = db.collection('transactions');

  await usersCol.createIndex({ email: 1 }, { unique: true });
  await usersCol.createIndex({ username: 1 }, { unique: true });
  await txnsCol.createIndex({ reference: 1 }, { unique: true });
  await txnsCol.createIndex({ userId: 1, createdAt: -1 });

  console.log('✅ MongoDB connected');
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function normalizePhone(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (p.startsWith('7') && p.length === 9) p = '254' + p;
  else if (p.startsWith('1') && p.length === 9) p = '254' + p;
  return p;
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}
function isValidKenyanPhone(phone) {
  return /^254(7|1)\d{8}$/.test(phone);
}
function isSubscriptionActive(user) {
  if (!user || user.subscriptionTier === 'free') return false;
  if (!user.subscriptionExpiry) return false;
  return new Date(user.subscriptionExpiry) > new Date();
}
function resetDailyTasks(user) {
  const today = new Date().toISOString().slice(0, 10);
  if (user.lastTaskDate !== today) {
    user.tasksCompletedToday = 0;
    user.lastTaskDate = today;
    return true;
  }
  return false;
}
function dailyLimit(user) {
  if (!isSubscriptionActive(user)) return 0;
  return TIERS[user.subscriptionTier]?.dailyLimit || 0;
}
function publicUser(user) {
  const active = isSubscriptionActive(user);
  const limit = dailyLimit(user);
  const done = user.tasksCompletedToday || 0;
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    phone: user.phone,
    subscriptionTier: active ? user.subscriptionTier : 'free',
    subscriptionExpiry: active ? user.subscriptionExpiry : null,
    dailyLimit: limit,
    tasksCompletedToday: done,
    tasksRemaining: Math.max(0, limit - done)
  };
}

// ─── AUTH ──────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const payload = jwt.verify(header.split(' ')[1], JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── ROUTES ────────────────────────────────────────────────────────────────
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, phone } = req.body || {};
    if (!username || !email || !password || !phone) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (String(username).length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const normalizedPhone = normalizePhone(phone);
    if (!isValidKenyanPhone(normalizedPhone)) {
      return res.status(400).json({ error: 'Enter a valid Kenyan M‑Pesa number' });
    }

    const cleanUsername = String(username).trim();
    const cleanEmail = String(email).trim().toLowerCase();

    const existing = await usersCol.findOne({
      $or: [{ email: cleanEmail }, { username: cleanUsername }]
    });
    if (existing) return res.status(409).json({ error: 'Email or username already taken' });

    const hashed = await bcrypt.hash(password, 10);
    const today = new Date().toISOString().slice(0, 10);

    const user = {
      username: cleanUsername,
      email: cleanEmail,
      phone: normalizedPhone,
      password: hashed,
      subscriptionTier: 'free',
      subscriptionExpiry: null,
      tasksCompletedToday: 0,
      lastTaskDate: today,
      totalEarnings: 0,
      createdAt: new Date()
    };
    const result = await usersCol.insertOne(user);
    const token = jwt.sign({ userId: String(result.insertedId) }, JWT_SECRET, { expiresIn: '7d' });
    user._id = result.insertedId;
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = await usersCol.findOne({ email: String(email).trim().toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    if (resetDailyTasks(user)) {
      await usersCol.updateOne({ _id: user._id },
        { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } });
    }
    const token = jwt.sign({ userId: String(user._id) }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (resetDailyTasks(user)) {
      await usersCol.updateOne({ _id: user._id },
        { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } });
    }
    res.json(publicUser(user));
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/subscribe', auth, async (req, res) => {
  try {
    const { tier } = req.body || {};
    if (!TIERS[tier] || tier === 'free') {
      return res.status(400).json({ error: 'Invalid tier' });
    }
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.phone) return res.status(400).json({ error: 'No phone number on file' });

    const amount = TIERS[tier].price;
    const reference = `sub_${user._id}_${tier}_${Date.now()}`;

    if (isSubscriptionActive(user) && user.subscriptionTier === tier) {
      const daysLeft = Math.ceil((new Date(user.subscriptionExpiry) - new Date()) / 86400000);
      if (daysLeft > 2) {
        return res.status(409).json({
          error: `You already have an active ${tier} plan (${daysLeft} days left)`
        });
      }
    }

    await txnsCol.insertOne({
      userId: user._id, tier, amount, reference,
      phone: user.phone, status: 'pending', createdAt: new Date()
    });

    const payload = {
      api_key: process.env.PAYHERO_API_KEY,
      username: process.env.PAYHERO_USERNAME,
      amount, phone: user.phone,
      user_reference: reference,
      callback_url: PAYHERO_CALLBACK_URL
    };

    console.log('📤 PayHero request:', { ...payload, api_key: '***' });
    const { data } = await axios.post(PAYHERO_API_URL, payload, {
      headers: { 'Content-Type': 'application/json' }, timeout: 20000
    });
    console.log('📥 PayHero response:', data);

    const payheroOk =
      data?.success === true ||
      data?.status === 'success' ||
      data?.ResponseCode === '0' ||
      (typeof data === 'string' && /success/i.test(data));

    if (!payheroOk && data?.error) {
      await txnsCol.updateOne({ reference },
        { $set: { status: 'failed', payheroResponse: data } });
      return res.status(502).json({ error: data.error || 'Payment initiation failed' });
    }
    await txnsCol.updateOne({ reference }, { $set: { payheroResponse: data } });
    res.json({
      message: 'STK push sent. Check your phone to complete payment.',
      reference, amount, tier
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Subscribe error:', detail);
    res.status(500).json({ error: 'Payment initiation failed' });
  }
});

app.post('/api/payhero/callback', async (req, res) => {
  try {
    console.log('🔔 PayHero callback:', JSON.stringify(req.body, null, 2));
    const body = req.body || {};
    const resp = body.response || body;

    const userRef =
      resp.User_Reference || resp.user_reference || resp.reference ||
      body.User_Reference || body.reference;

    const amountRaw = resp.Amount ?? resp.amount ?? body.Amount ?? body.amount ?? 0;
    const mpesaRef =
      resp.MPESA_Reference || resp.mpesa_reference ||
      resp.MpesaReceiptNumber || null;

    if (!userRef) return res.status(400).json({ error: 'Missing User_Reference' });

    const parts = String(userRef).split('_');
    if (parts.length < 4 || parts[0] !== 'sub') {
      return res.status(400).json({ error: 'Invalid reference format' });
    }
    const userId = parts[1];
    const tier = parts[2];
    if (!TIERS[tier] || tier === 'free') {
      return res.status(400).json({ error: 'Invalid tier in reference' });
    }

    const txn = await txnsCol.findOne({ reference: userRef });
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    if (txn.status === 'completed') return res.json({ message: 'Already processed' });

    const amountNum = Number(amountRaw) || 0;
    if (amountNum && amountNum < TIERS[tier].price) {
      await txnsCol.updateOne({ _id: txn._id },
        { $set: { status: 'failed', reason: 'Amount mismatch', callback: body } });
      return res.status(400).json({ error: 'Amount mismatch' });
    }

    const user = await usersCol.findOne({ _id: new ObjectId(userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const baseDate =
      isSubscriptionActive(user) && user.subscriptionTier === tier
        ? new Date(user.subscriptionExpiry) : new Date();
    const expiry = new Date(baseDate);
    expiry.setDate(expiry.getDate() + SUBSCRIPTION_DAYS);

    await usersCol.updateOne({ _id: user._id }, {
      $set: {
        subscriptionTier: tier,
        subscriptionExpiry: expiry,
        tasksCompletedToday: 0,
        lastTaskDate: new Date().toISOString().slice(0, 10)
      }
    });

    await txnsCol.updateOne({ _id: txn._id }, {
      $set: { status: 'completed', mpesaRef, callback: body, completedAt: new Date() }
    });

    console.log(`✅ Subscription activated: ${tier} for user ${userId}`);
    res.json({ message: 'Subscription activated' });
  } catch (err) {
    console.error('Callback error:', err);
    res.status(200).json({ message: 'Received' });
  }
});

app.get('/api/tasks', auth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (resetDailyTasks(user)) {
      await usersCol.updateOne({ _id: user._id },
        { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } });
    }

    const active = isSubscriptionActive(user);
    const limit = dailyLimit(user);
    const done = user.tasksCompletedToday || 0;
    const remaining = Math.max(0, limit - done);

    const allTasks = [
      { id: 1,  type: 'survey', title: 'Consumer Habits Survey',      reward: 15, time: '3 min' },
      { id: 2,  type: 'survey', title: 'Mobile Banking Feedback',     reward: 20, time: '5 min' },
      { id: 3,  type: 'task',   title: 'Verify Product Reviews',      reward: 10, time: '2 min' },
      { id: 4,  type: 'survey', title: 'Online Shopping Preferences', reward: 18, time: '4 min' },
      { id: 5,  type: 'task',   title: 'Data Entry – Contact List',   reward: 25, time: '6 min' },
      { id: 6,  type: 'survey', title: 'Health & Wellness Survey',    reward: 22, time: '5 min' },
      { id: 7,  type: 'task',   title: 'Image Categorisation',        reward: 12, time: '3 min' },
      { id: 8,  type: 'survey', title: 'Travel Habits 2026',          reward: 30, time: '7 min' },
      { id: 9,  type: 'task',   title: 'Transcribe Short Audio',      reward: 35, time: '8 min' },
      { id: 10, type: 'survey', title: 'Social Media Usage',          reward: 16, time: '4 min' },
      { id: 11, type: 'task',   title: 'Proofread Blog Post',         reward: 28, time: '6 min' },
      { id: 12, type: 'survey', title: 'Food Delivery Preferences',   reward: 19, time: '4 min' },
      { id: 13, type: 'task',   title: 'Rate Product Images',         reward: 11, time: '2 min' },
      { id: 14, type: 'survey', title: 'Smartphone Brand Loyalty',    reward: 24, time: '5 min' },
      { id: 15, type: 'task',   title: 'Check Website Links',         reward: 14, time: '3 min' },
      { id: 16, type: 'survey', title: 'Fitness App Feedback',        reward: 21, time: '5 min' },
      { id: 17, type: 'task',   title: 'Translate Short Phrases',     reward: 27, time: '6 min' },
      { id: 18, type: 'survey', title: 'Streaming Service Review',    reward: 23, time: '5 min' },
      { id: 19, type: 'task',   title: 'Tag Images by Category',      reward: 13, time: '3 min' },
      { id: 20, type: 'survey', title: 'Gaming Habits Survey',        reward: 26, time: '6 min' },
      { id: 21, type: 'task',   title: 'Verify Business Listings',    reward: 17, time: '4 min' },
      { id: 22, type: 'survey', title: 'Electric Vehicle Interest',   reward: 32, time: '7 min' },
      { id: 23, type: 'task',   title: 'Classify Customer Reviews',   reward: 15, time: '3 min' },
      { id: 24, type: 'survey', title: 'Remote Work Preferences',     reward: 29, time: '6 min' },
      { id: 25, type: 'task',   title: 'Short Video Transcription',   reward: 33, time: '8 min' }
    ];

    const available = active ? allTasks.slice(0, remaining) : [];

    res.json({
      subscriptionActive: active,
      tier: active ? user.subscriptionTier : 'free',
      dailyLimit: limit,
      tasksCompletedToday: done,
      tasksRemaining: remaining,
      tasks: available,
      totalTasks: allTasks.length
    });
  } catch (err) {
    console.error('Tasks error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/tasks/complete', auth, async (req, res) => {
  try {
    const { taskId } = req.body || {};
    if (!taskId) return res.status(400).json({ error: 'taskId is required' });

    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (resetDailyTasks(user)) {
      await usersCol.updateOne({ _id: user._id },
        { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } });
    }
    if (!isSubscriptionActive(user)) {
      return res.status(403).json({ error: 'No active subscription' });
    }

    const limit = dailyLimit(user);
    const done = user.tasksCompletedToday || 0;
    if (done >= limit) return res.status(429).json({ error: 'Daily limit reached' });

    await usersCol.updateOne({ _id: user._id },
      { $inc: { tasksCompletedToday: 1 } });

    res.json({
      message: 'Task completed',
      tasksCompletedToday: done + 1,
      tasksRemaining: Math.max(0, limit - (done + 1))
    });
  } catch (err) {
    console.error('Complete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/tiers', (req, res) => {
  const out = {};
  for (const [key, val] of Object.entries(TIERS)) {
    out[key] = {
      name: val.name, price: val.price,
      dailyLimit: val.dailyLimit, label: val.label, days: SUBSCRIPTION_DAYS
    };
  }
  res.json(out);
});

// ─── FALLBACK ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`   Callback URL: ${PAYHERO_CALLBACK_URL || '(not set)'}`);
    });
  } catch (err) {
    console.error('❌ Failed to start:', err);
    process.exit(1);
  }
})();
