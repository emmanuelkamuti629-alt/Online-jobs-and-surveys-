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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIG ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const PAYHERO_API_URL = 'https://payherokenya.com/sps/portal/app/stk.php';

// Tier definitions
const TIERS = {
  free:    { name: 'Free',    dailyLimit: 0,  price: 0,   label: 'No access' },
  classic: { name: 'Classic', dailyLimit: 10, price: 200, label: '10 tasks / day' },
  premium: { name: 'Premium', dailyLimit: 20, price: 350, label: '20 tasks / day' },
  golden:  { name: 'Golden',  dailyLimit: 50, price: 450, label: '50+ tasks / day' }
};

// ─── MONGODB ───────────────────────────────────────────────────────────────
let db;
let usersCol;

async function connectDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('payhero_jobs');
  usersCol = db.collection('users');
  console.log('✅ MongoDB connected');
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

/** Normalise phone to 254XXXXXXXXX format */
function normalizePhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') && p.length === 9) p = '254' + p;
  return p;
}

/** Check whether a user's subscription is still valid */
function isSubscriptionActive(user) {
  if (user.subscriptionTier === 'free') return false;
  if (!user.subscriptionExpiry) return false;
  return new Date(user.subscriptionExpiry) > new Date();
}

/** Reset daily task counter if the date has changed */
function resetDailyTasks(user) {
  const today = new Date().toISOString().slice(0, 10);
  if (user.lastTaskDate !== today) {
    user.tasksCompletedToday = 0;
    user.lastTaskDate = today;
    return true;
  }
  return false;
}

/** Return the effective daily limit for a user */
function dailyLimit(user) {
  if (!isSubscriptionActive(user)) return 0;
  return TIERS[user.subscriptionTier]?.dailyLimit || 0;
}

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────────────────
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
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

/**
 * POST /api/register
 * Body: { username, email, password, phone }
 * Auto‑login by returning a JWT.
 */
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, phone } = req.body;
    if (!username || !email || !password || !phone) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const existing = await usersCol.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      return res.status(409).json({ error: 'Email or username already taken' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = {
      username,
      email,
      phone: normalizePhone(phone),
      password: hashed,
      subscriptionTier: 'free',
      subscriptionExpiry: null,
      tasksCompletedToday: 0,
      lastTaskDate: new Date().toISOString().slice(0, 10),
      createdAt: new Date()
    };

    const result = await usersCol.insertOne(user);
    const token = jwt.sign({ userId: result.insertedId }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      token,
      user: {
        id: result.insertedId,
        username,
        email,
        subscriptionTier: 'free',
        dailyLimit: 0
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/login
 * Body: { email, password }
 */
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await usersCol.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // Reset daily counter if needed
    if (resetDailyTasks(user)) {
      await usersCol.updateOne(
        { _id: user._id },
        { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } }
      );
    }

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    const active = isSubscriptionActive(user);

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        subscriptionTier: active ? user.subscriptionTier : 'free',
        subscriptionExpiry: user.subscriptionExpiry,
        dailyLimit: dailyLimit(user),
        tasksCompletedToday: user.tasksCompletedToday || 0
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/me
 * Returns the current user's profile, subscription status, and task usage.
 */
app.get('/api/me', auth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (resetDailyTasks(user)) {
      await usersCol.updateOne(
        { _id: user._id },
        { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } }
      );
    }

    const active = isSubscriptionActive(user);
    res.json({
      id: user._id,
      username: user.username,
      email: user.email,
      phone: user.phone,
      subscriptionTier: active ? user.subscriptionTier : 'free',
      subscriptionExpiry: user.subscriptionExpiry,
      dailyLimit: dailyLimit(user),
      tasksCompletedToday: user.tasksCompletedToday || 0,
      tasksRemaining: Math.max(0, dailyLimit(user) - (user.tasksCompletedToday || 0))
    });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/subscribe
 * Body: { tier }
 * Initiates a PayHero STK push. The callback will activate the subscription.
 */
app.post('/api/subscribe', auth, async (req, res) => {
  try {
    const { tier } = req.body;
    if (!TIERS[tier] || tier === 'free') {
      return res.status(400).json({ error: 'Invalid tier' });
    }

    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const amount = TIERS[tier].price;
    const phone = user.phone;
    const reference = `sub_${user._id}_${tier}_${Date.now()}`;

    // Call PayHero STK push
    const payload = {
      api_key: process.env.PAYHERO_API_KEY,
      username: process.env.PAYHERO_USERNAME,
      amount: amount,
      phone: phone,
      user_reference: reference
    };

    console.log('📤 PayHero request:', payload);

    const { data } = await axios.post(PAYHERO_API_URL, payload, {
      headers: { 'Content-Type': 'application/json' }
    });

    console.log('📥 PayHero response:', data);

    // Save pending transaction
    await db.collection('transactions').insertOne({
      userId: user._id,
      tier,
      amount,
      reference,
      phone,
      status: 'pending',
      payheroResponse: data,
      createdAt: new Date()
    });

    res.json({
      message: 'STK push sent. Check your phone to complete payment.',
      reference,
      amount,
      tier
    });
  } catch (err) {
    console.error('Subscribe error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment initiation failed' });
  }
});

/**
 * POST /api/payhero/callback
 * PayHero sends the payment confirmation here.
 * Body example: { status, response: { Transaction_Type, Source, Amount, MPESA_Reference, Account, User_Reference, Transaction_Date } }
 */
app.post('/api/payhero/callback', async (req, res) => {
  try {
    console.log('🔔 PayHero callback:', JSON.stringify(req.body, null, 2));

    const body = req.body;
    if (!body || !body.response) {
      return res.status(400).json({ error: 'Invalid callback' });
    }

    const { User_Reference, Amount, MPESA_Reference } = body.response;

    if (!User_Reference) {
      return res.status(400).json({ error: 'Missing User_Reference' });
    }

    // Parse reference: sub_<userId>_<tier>_<timestamp>
    const parts = User_Reference.split('_');
    if (parts.length < 4) {
      return res.status(400).json({ error: 'Invalid reference format' });
    }

    const userId = parts[1];
    const tier = parts[2];

    if (!TIERS[tier] || tier === 'free') {
      return res.status(400).json({ error: 'Invalid tier in reference' });
    }

    // Find the pending transaction
    const txn = await db.collection('transactions').findOne({ reference: User_Reference });
    if (!txn) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (txn.status === 'completed') {
      return res.json({ message: 'Already processed' });
    }

    // Verify amount (optional but recommended)
    if (Number(Amount) < TIERS[tier].price) {
      await db.collection('transactions').updateOne(
        { _id: txn._id },
        { $set: { status: 'failed', reason: 'Amount mismatch', callback: body } }
      );
      return res.status(400).json({ error: 'Amount mismatch' });
    }

    // Activate subscription: valid for 7 days
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 7);

    await usersCol.updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          subscriptionTier: tier,
          subscriptionExpiry: expiry,
          tasksCompletedToday: 0,
          lastTaskDate: new Date().toISOString().slice(0, 10)
        }
      }
    );

    await db.collection('transactions').updateOne(
      { _id: txn._id },
      { $set: { status: 'completed', mpesaRef: MPESA_Reference, callback: body, completedAt: new Date() } }
    );

    res.json({ message: 'Subscription activated' });
  } catch (err) {
    console.error('Callback error:', err);
    res.status(500).json({ error: 'Callback processing failed' });
  }
});

/**
 * GET /api/tasks
 * Returns a list of available tasks for the user, respecting daily limits.
 */
app.get('/api/tasks', auth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (resetDailyTasks(user)) {
      await usersCol.updateOne(
        { _id: user._id },
        { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } }
      );
    }

    const active = isSubscriptionActive(user);
    const limit = dailyLimit(user);
    const done = user.tasksCompletedToday || 0;
    const remaining = Math.max(0, limit - done);

    // Sample tasks — in a real app these would come from a collection
    const allTasks = [
      { id: 1,  type: 'survey', title: 'Consumer Habits Survey',          reward: 15, time: '3 min' },
      { id: 2,  type: 'survey', title: 'Mobile Banking Feedback',          reward: 20, time: '5 min' },
      { id: 3,  type: 'task',   title: 'Verify Product Reviews',           reward: 10, time: '2 min' },
      { id: 4,  type: 'survey', title: 'Online Shopping Preferences',      reward: 18, time: '4 min' },
      { id: 5,  type: 'task',   title: 'Data Entry – Contact List',        reward: 25, time: '6 min' },
      { id: 6,  type: 'survey', title: 'Health & Wellness Survey',         reward: 22, time: '5 min' },
      { id: 7,  type: 'task',   title: 'Image Categorisation',             reward: 12, time: '3 min' },
      { id: 8,  type: 'survey', title: 'Travel Habits 2026',               reward: 30, time: '7 min' },
      { id: 9,  type: 'task',   title: 'Transcribe Short Audio',           reward: 35, time: '8 min' },
      { id: 10, type: 'survey', title: 'Social Media Usage',               reward: 16, time: '4 min' },
      { id: 11, type: 'task',   title: 'Proofread Blog Post',              reward: 28, time: '6 min' },
      { id: 12, type: 'survey', title: 'Food Delivery Preferences',        reward: 19, time: '4 min' },
      { id: 13, type: 'task',   title: 'Rate Product Images',              reward: 11, time: '2 min' },
      { id: 14, type: 'survey', title: 'Smartphone Brand Loyalty',         reward: 24, time: '5 min' },
      { id: 15, type: 'task',   title: 'Check Website Links',              reward: 14, time: '3 min' }
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

/**
 * POST /api/tasks/complete
 * Body: { taskId }
 * Marks a task as completed and increments the daily counter.
 */
app.post('/api/tasks/complete', auth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (resetDailyTasks(user)) {
      await usersCol.updateOne(
        { _id: user._id },
        { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } }
      );
    }

    if (!isSubscriptionActive(user)) {
      return res.status(403).json({ error: 'No active subscription' });
    }

    const limit = dailyLimit(user);
    const done = user.tasksCompletedToday || 0;

    if (done >= limit) {
      return res.status(429).json({ error: 'Daily limit reached' });
    }

    await usersCol.updateOne(
      { _id: user._id },
      { $inc: { tasksCompletedToday: 1 } }
    );

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

/**
 * GET /api/tiers
 * Public endpoint returning tier definitions.
 */
app.get('/api/tiers', (req, res) => {
  const out = {};
  for (const [key, val] of Object.entries(TIERS)) {
    out[key] = {
      name: val.name,
      price: val.price,
      dailyLimit: val.dailyLimit,
      label: val.label
    };
  }
  res.json(out);
});

// ─── FALLBACK ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ─────────────────────────────────────────────────────────────────
connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ Failed to start:', err);
    process.exit(1);
  });
