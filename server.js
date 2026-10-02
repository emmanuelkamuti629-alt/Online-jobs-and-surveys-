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

const TIERS = {
  free:    { name: 'Free',    dailyLimit: 2,  price: 0,   label: '2 free tasks / day' },
  classic: { name: 'Classic', dailyLimit: 10, price: 200, label: '10 tasks / day' },
  premium: { name: 'Premium', dailyLimit: 20, price: 350, label: '20 tasks / day' },
  golden:  { name: 'Golden',  dailyLimit: 50, price: 450, label: '50+ tasks / day' }
};
const SUBSCRIPTION_DAYS = 7;

// Free‑tier reward is fixed
const FREE_TASK_REWARD = 21;

// Wallet limits
const MIN_DEPOSIT    = 50;
const MIN_WITHDRAWAL = 200;

// ─── MONGODB ───────────────────────────────────────────────────────────────
let db, usersCol, txnsCol, tasksCol, walletCol;

async function connectDB() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000
  });
  await client.connect();
  db = client.db('payhero_jobs');
  usersCol  = db.collection('users');
  txnsCol   = db.collection('transactions');
  tasksCol  = db.collection('tasks');
  walletCol = db.collection('wallet_transactions');

  await usersCol.createIndex({ email: 1 }, { unique: true });
  await usersCol.createIndex({ username: 1 }, { unique: true });
  await txnsCol.createIndex({ reference: 1 }, { unique: true });
  await walletCol.createIndex({ userId: 1, createdAt: -1 });

  await seedTasks();

  console.log('✅ MongoDB connected');
}

// ─── SEED THOUSANDS OF TASKS ───────────────────────────────────────────────
async function seedTasks() {
  const existing = await tasksCol.estimatedDocumentCount();
  if (existing > 100) {
    console.log(`ℹ️  Tasks already seeded (${existing}). Skipping.`);
    return;
  }

  const surveyTopics = [
    'Consumer Habits', 'Mobile Banking', 'Online Shopping', 'Health & Wellness',
    'Travel Preferences', 'Social Media', 'Food Delivery', 'Streaming Services',
    'Smartphone Usage', 'Fitness Apps', 'Gaming Habits', 'Remote Work',
    'Electric Vehicles', 'Crypto Adoption', 'Insurance Products', 'Retail Brands',
    'Coffee Culture', 'Fashion Trends', 'Real Estate', 'Education Tech',
    'Pet Ownership', 'Music Streaming', 'Fitness Wearables', 'Home Security',
    'Productivity Tools', 'Personal Finance', 'Digital Wallets', 'Beauty Products',
    'Home Cooking', 'Public Transport', 'Airlines & Travel', 'Online Learning',
    'Subscription Services', 'Cloud Storage', 'Smart Home Devices', 'Wearables'
  ];
  const taskTitles = [
    'Verify Product Reviews', 'Data Entry – Contact List', 'Image Categorisation',
    'Transcribe Short Audio', 'Proofread Blog Post', 'Rate Product Images',
    'Check Website Links', 'Translate Short Phrases', 'Tag Images by Category',
    'Verify Business Listings', 'Classify Customer Reviews', 'Short Video Transcription',
    'Fill Spreadsheet Data', 'Compare Prices Online', 'Rate Website UX',
    'Moderate Comments', 'Label Sentences for AI', 'Record Voice Sample',
    'Photograph Receipt', 'Answer Quick Poll', 'Map Local Business',
    'Correct OCR Text', 'Verify News Article', 'Collect Email Signups'
  ];
  const countries = ['Kenya', 'Uganda', 'Tanzania', 'Nigeria', 'Ghana', 'South Africa'];

  const tasks = [];
  let id = 1;

  // ~1200 surveys
  for (let i = 0; i < 1200; i++) {
    const topic = surveyTopics[i % surveyTopics.length];
    const country = countries[i % countries.length];
    tasks.push({
      id: id++,
      type: 'survey',
      title: `${topic} Survey – ${country} #${i + 1}`,
      reward: 21 + ((i * 7) % 40), // 21–60
      time: `${3 + (i % 5)} min`,
      questions: 6 + (i % 8),
      category: topic,
      country,
      difficulty: i % 3 === 0 ? 'easy' : i % 3 === 1 ? 'medium' : 'hard',
      createdAt: new Date()
    });
  }

  // ~1000 micro‑tasks
  for (let i = 0; i < 1000; i++) {
    const title = taskTitles[i % taskTitles.length];
    tasks.push({
      id: id++,
      type: 'task',
      title: `${title} #${i + 1}`,
      reward: 21 + ((i * 5) % 35), // 21–55
      time: `${2 + (i % 6)} min`,
      category: 'Micro‑task',
      difficulty: i % 3 === 0 ? 'easy' : i % 3 === 1 ? 'medium' : 'hard',
      createdAt: new Date()
    });
  }

  await tasksCol.insertMany(tasks);
  console.log(`✅ Seeded ${tasks.length} tasks (surveys + micro‑tasks)`);
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
function isStrongPassword(pw) {
  return typeof pw === 'string'
    && pw.length >= 8
    && /[A-Z]/.test(pw)
    && /[a-z]/.test(pw)
    && /[0-9]/.test(pw);
}
function isSubscriptionActive(user) {
  if (!user) return false;
  if (user.subscriptionTier === 'free') return true; // free is always "active" for its daily limit
  if (!user.subscriptionExpiry) return false;
  return new Date(user.subscriptionExpiry) > new Date();
}
function dailyLimit(user) {
  if (user.subscriptionTier === 'free') return TIERS.free.dailyLimit;
  if (!isSubscriptionActive(user)) return 0;
  return TIERS[user.subscriptionTier]?.dailyLimit || 0;
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
function publicUser(user) {
  const active = isSubscriptionActive(user);
  const limit = dailyLimit(user);
  const done = user.tasksCompletedToday || 0;
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    phone: user.phone,
    subscriptionTier: user.subscriptionTier,
    subscriptionActive: active,
    subscriptionExpiry: user.subscriptionExpiry,
    dailyLimit: limit,
    tasksCompletedToday: done,
    tasksRemaining: Math.max(0, limit - done),
    balance: user.balance || 0,
    totalEarnings: user.totalEarnings || 0
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
    const { username, email, password, confirmPassword, phone } = req.body || {};

    if (!username || !email || !password || !phone) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({
        error: 'Password must be 8+ characters with uppercase, lowercase, and a number'
      });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
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
      balance: 0,
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

// ─── SUBSCRIBE ─────────────────────────────────────────────────────────────
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
      phone: user.phone, status: 'pending', kind: 'subscription',
      createdAt: new Date()
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

// ─── WALLET: DEPOSIT ───────────────────────────────────────────────────────
app.post('/api/wallet/deposit', auth, async (req, res) => {
  try {
    const amount = Number(req.body?.amount) || 0;
    if (amount < MIN_DEPOSIT) {
      return res.status(400).json({ error: `Minimum deposit is KES ${MIN_DEPOSIT}` });
    }
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const reference = `dep_${user._id}_${Date.now()}`;
    await txnsCol.insertOne({
      userId: user._id, amount, reference,
      phone: user.phone, status: 'pending', kind: 'deposit',
      createdAt: new Date()
    });

    const payload = {
      api_key: process.env.PAYHERO_API_KEY,
      username: process.env.PAYHERO_USERNAME,
      amount, phone: user.phone,
      user_reference: reference,
      callback_url: PAYHERO_CALLBACK_URL
    };
    console.log('📤 PayHero deposit:', { ...payload, api_key: '***' });
    const { data } = await axios.post(PAYHERO_API_URL, payload, {
      headers: { 'Content-Type': 'application/json' }, timeout: 20000
    });
    console.log('📥 PayHero deposit response:', data);

    await txnsCol.updateOne({ reference }, { $set: { payheroResponse: data } });

    res.json({
      message: `STK push sent. Approve KES ${amount} on your phone.`,
      reference, amount
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Deposit error:', detail);
    res.status(500).json({ error: 'Deposit initiation failed' });
  }
});

// ─── WALLET: WITHDRAW ──────────────────────────────────────────────────────
app.post('/api/wallet/withdraw', auth, async (req, res) => {
  try {
    const amount = Number(req.body?.amount) || 0;
    if (amount < MIN_WITHDRAWAL) {
      return res.status(400).json({ error: `Minimum withdrawal is KES ${MIN_WITHDRAWAL}` });
    }
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if ((user.balance || 0) < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Deduct immediately (simulated payout)
    const result = await usersCol.updateOne(
      { _id: user._id, balance: { $gte: amount } },
      { $inc: { balance: -amount } }
    );
    if (result.modifiedCount === 0) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    await walletCol.insertOne({
      userId: user._id,
      type: 'withdrawal',
      amount: -amount,
      phone: user.phone,
      status: 'processing',
      reference: `wd_${user._id}_${Date.now()}`,
      createdAt: new Date()
    });

    res.json({
      message: `Withdrawal of KES ${amount} requested. You'll receive it on ${user.phone} within 24 hours.`,
      amount, phone: user.phone
    });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

// ─── WALLET: HISTORY ───────────────────────────────────────────────────────
app.get('/api/wallet/history', auth, async (req, res) => {
  try {
    const items = await walletCol
      .find({ userId: new ObjectId(req.userId) })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    res.json(items);
  } catch (err) {
    console.error('Wallet history error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PAYHERO CALLBACK ─────────────────────────────────────────────────────
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
    const prefix = parts[0];

    const txn = await txnsCol.findOne({ reference: userRef });
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    if (txn.status === 'completed') return res.json({ message: 'Already processed' });

    const amountNum = Number(amountRaw) || 0;
    const userId = String(txn.userId);

    // ── Subscription payment ──
    if (prefix === 'sub') {
      const tier = parts[2];
      if (!TIERS[tier] || tier === 'free') {
        return res.status(400).json({ error: 'Invalid tier in reference' });
      }
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
    }

    // ── Deposit payment ──
    if (prefix === 'dep') {
      if (amountNum && amountNum < MIN_DEPOSIT) {
        await txnsCol.updateOne({ _id: txn._id },
          { $set: { status: 'failed', reason: 'Below minimum', callback: body } });
        return res.status(400).json({ error: 'Below minimum deposit' });
      }
      await usersCol.updateOne(
        { _id: new ObjectId(userId) },
        { $inc: { balance: amountNum } }
      );
      await walletCol.insertOne({
        userId: new ObjectId(userId),
        type: 'deposit',
        amount: amountNum,
        phone: txn.phone,
        status: 'completed',
        reference: userRef,
        mpesaRef,
        createdAt: new Date()
      });
      console.log(`💰 Deposit credited: KES ${amountNum} to user ${userId}`);
    }

    await txnsCol.updateOne({ _id: txn._id }, {
      $set: { status: 'completed', mpesaRef, callback: body, completedAt: new Date() }
    });
    res.json({ message: 'Processed' });
  } catch (err) {
    console.error('Callback error:', err);
    res.status(200).json({ message: 'Received' });
  }
});

// ─── TASKS ────────────────────────────────────────────────────────────────
app.get('/api/tasks', auth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (resetDailyTasks(user)) {
      await usersCol.updateOne({ _id: user._id },
        { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } });
    }

    const tier = user.subscriptionTier;
    const active = isSubscriptionActive(user);
    const limit = dailyLimit(user);
    const done = user.tasksCompletedToday || 0;
    const remaining = Math.max(0, limit - done);

    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const size  = Math.min(100, parseInt(req.query.size) || 30);
    const type  = req.query.type; // 'survey' | 'task' | undefined
    const skip  = (page - 1) * size;

    const filter = {};
    if (type === 'survey' || type === 'task') filter.type = type;

    const totalCount = await tasksCol.countDocuments(filter);
    const tasks = await tasksCol
      .find(filter).sort({ id: 1 }).skip(skip).limit(size).toArray();

    // Which tasks are within today's allowance?
    const availableTasks = active
      ? tasks.slice(0, Math.max(0, remaining))
      : [];

    // For free tier, force reward to KES 21
    const shaped = availableTasks.map(t => ({
      ...t,
      reward: tier === 'free' ? FREE_TASK_REWARD : t.reward
    }));

    res.json({
      subscriptionActive: active,
      tier,
      dailyLimit: limit,
      tasksCompletedToday: done,
      tasksRemaining: remaining,
      tasks: shaped,
      page,
      size,
      totalCount,
      totalTasks: totalCount
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

    const limit = dailyLimit(user);
    const done = user.tasksCompletedToday || 0;
    if (done >= limit) return res.status(429).json({ error: 'Daily limit reached' });

    const task = await tasksCol.findOne({ id: Number(taskId) });
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const reward = user.subscriptionTier === 'free' ? FREE_TASK_REWARD : task.reward;

    await usersCol.updateOne(
      { _id: user._id },
      {
        $inc: {
          tasksCompletedToday: 1,
          balance: reward,
          totalEarnings: reward
        }
      }
    );
    await walletCol.insertOne({
      userId: user._id,
      type: 'task_reward',
      amount: reward,
      status: 'completed',
      reference: `task_${taskId}_${Date.now()}`,
      taskTitle: task.title,
      createdAt: new Date()
    });

    res.json({
      message: `Task completed! You earned KES ${reward}`,
      reward,
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

app.get('/api/tasks/stats', async (req, res) => {
  const surveys = await tasksCol.countDocuments({ type: 'survey' });
  const micro   = await tasksCol.countDocuments({ type: 'task' });
  res.json({ surveys, tasks: micro, total: surveys + micro });
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
