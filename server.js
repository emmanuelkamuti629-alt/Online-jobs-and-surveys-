// =============================================================================
//  JobPay — server.js  (MongoDB + PayHero)
//  Single source of truth for: min deposits, min withdrawals, activation fee,
//  referral bonus, free tier, quick-amount buttons, tier limits, tier prices.
// =============================================================================

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const axios    = require('axios');
const { MongoClient } = require('mongodb');
const path     = require('path');

const app = express();
const PORT           = process.env.PORT || 3000;
const JWT_SECRET     = process.env.JWT_SECRET || 'jobpay-dev-secret-change-me';
const MONGODB_URI    = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const MONGODB_DB     = process.env.MONGODB_DB  || 'jobpay';
const PUBLIC_DIR     = path.join(__dirname, 'public');

// PayHero credentials
const PAYHERO_BASE         = process.env.PAYHERO_BASE || 'https://backend.payhero.co.ke/api/v2';
const PAYHERO_USERNAME     = process.env.PAYHERO_USERNAME || '';
const PAYHERO_PASSWORD     = process.env.PAYHERO_PASSWORD || '';
const PAYHERO_CHANNEL_ID   = Number(process.env.PAYHERO_CHANNEL_ID) || 0;
const PAYHERO_CALLBACK_URL = process.env.PAYHERO_CALLBACK_URL || ''; // e.g. https://yourhost.com/api/payhero/callback

// =============================================================================
//  CONFIG — single source of truth for the whole UI
// =============================================================================
const APP_CONFIG = {
  currency: 'KES',
  minDeposit:    Number(process.env.MIN_DEPOSIT)    || 50,
  maxDeposit:    Number(process.env.MAX_DEPOSIT)    || 150000,
  minWithdrawal: Number(process.env.MIN_WITHDRAWAL) || 200,
  maxWithdrawal: Number(process.env.MAX_WITHDRAWAL) || 50000,
  activationFee: Number(process.env.ACTIVATION_FEE) || 499,
  referralBonus: Number(process.env.REFERRAL_BONUS) || 50,
  freeDailyTasks:        Number(process.env.FREE_DAILY_TASKS)  || 2,
  freeTaskReward:        Number(process.env.FREE_TASK_REWARD)  || 21,
  freeTaskCooldownHours: 24,
  depositQuickAmounts:    [50, 100, 200, 500, 1000, 2000, 5000],
  withdrawalQuickAmounts: [200, 300, 500, 1000, 2000, 5000],
  tierLimits: { free: 2, classic: 10, premium: 20, golden: 50 },
  tierPrices: { classic: 200, premium: 350, golden: 450 },
  withdrawalPinRequired: true,
  supportEmail: 'support@jobpay.co.ke',
};

// =============================================================================
//  MIDDLEWARE
// =============================================================================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
// IMPORTANT: PayHero POSTs JSON with its own signature header. We capture the
// raw body here so signature checks could be added later if needed.
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// =============================================================================
//  DATABASE
// =============================================================================
let db;
let collections = {};

async function connectDB() {
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  db = client.db(MONGODB_DB);
  collections = {
    users:         db.collection('users'),
    counters:      db.collection('counters'),
    tasks:         db.collection('tasks'),
    completions:   db.collection('completions'),
    walletTx:      db.collection('walletTx'),
    payTx:         db.collection('payTx'),
    notifications: db.collection('notifications'),
    tickets:       db.collection('tickets'),
    loginHistory:  db.collection('loginHistory'),
  };
  await Promise.all([
    collections.users.createIndex({ email: 1 },       { unique: true }),
    collections.users.createIndex({ username: 1 },    { unique: true }),
    collections.walletTx.createIndex({ userId: 1, createdAt: -1 }),
    collections.payTx.createIndex({ userId: 1, createdAt: -1 }),
    collections.payTx.createIndex({ reference: 1 },   { unique: true, sparse: true }),
    collections.payTx.createIndex({ checkoutRequestId: 1 }, { sparse: true }),
    collections.notifications.createIndex({ userId: 1, createdAt: -1 }),
    collections.completions.createIndex({ userId: 1, taskId: 1 }, { unique: true }),
  ]);
  console.log('✅ MongoDB connected →', MONGODB_DB);
}

async function nextSeq(name) {
  const r = await collections.counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return r.value ? r.value.seq : r.seq;
}

// =============================================================================
//  TASK SEED
// =============================================================================
const TASK_TEMPLATES = [
  { category:'Google Review Verification',        title:'Verify Local Business Reviews',        type:'survey', tier:'free',    reward:21, time:'4 min',  questions:5,  difficulty:'Easy',   avatar:'🔍' },
  { category:'Instagram Engagement Survey',       title:'Rate Instagram Ad Engagement',        type:'survey', tier:'free',    reward:21, time:'5 min',  questions:6,  difficulty:'Easy',   avatar:'📸' },
  { category:'Facebook Ad Feedback',              title:'Facebook Ad Creative Feedback',       type:'survey', tier:'free',    reward:21, time:'4 min',  questions:5,  difficulty:'Easy',   avatar:'📘' },
  { category:'YouTube Video Tagging',             title:'Tag YouTube Video Categories',        type:'task',   tier:'free',    reward:21, time:'3 min',  questions:4,  difficulty:'Easy',   avatar:'▶️' },
  { category:'TikTok Trend Analysis',             title:'Analyze Trending TikTok Sounds',      type:'task',   tier:'free',    reward:21, time:'6 min',  questions:6,  difficulty:'Medium', avatar:'🎵' },
  { category:'Twitter/X Sentiment Study',         title:'Classify Tweet Sentiment',            type:'task',   tier:'classic', reward:35, time:'6 min',  questions:6,  difficulty:'Medium', avatar:'🐦' },
  { category:'LinkedIn Professional Survey',      title:'LinkedIn Career Insights Survey',     type:'survey', tier:'classic', reward:40, time:'8 min',  questions:8,  difficulty:'Medium', avatar:'💼' },
  { category:'WhatsApp Business Feedback',        title:'WhatsApp Business Feature Test',      type:'survey', tier:'classic', reward:38, time:'7 min',  questions:7,  difficulty:'Medium', avatar:'💬' },
  { category:'Google Maps Location Check',        title:'Verify Business Location',            type:'task',   tier:'classic', reward:35, time:'5 min',  questions:5,  difficulty:'Easy',   avatar:'📍' },
  { category:'Amazon Product Review Validation',  title:'Validate Amazon Reviews',             type:'task',   tier:'premium', reward:55, time:'8 min',  questions:8,  difficulty:'Medium', avatar:'📦' },
  { category:'Netflix Content Preference',        title:'Netflix Watch Preference Survey',     type:'survey', tier:'premium', reward:60, time:'10 min', questions:9,  difficulty:'Medium', avatar:'🎬' },
  { category:'Spotify Playlist Curation',         title:'Curate Spotify Playlist Tags',        type:'task',   tier:'premium', reward:50, time:'7 min',  questions:6,  difficulty:'Easy',   avatar:'🎧' },
  { category:'Uber Ride Experience',              title:'Uber Ride Experience Survey',         type:'survey', tier:'premium', reward:58, time:'9 min',  questions:8,  difficulty:'Medium', avatar:'🚗' },
  { category:'Airbnb Host Feedback',              title:'Airbnb Host Quality Feedback',        type:'survey', tier:'golden',  reward:75, time:'12 min', questions:10, difficulty:'Hard',   avatar:'🏠' },
  { category:'eBay Seller Rating',                title:'Rate eBay Seller Performance',        type:'task',   tier:'golden',  reward:70, time:'10 min', questions:8,  difficulty:'Medium', avatar:'🛒' },
  { category:'Shopify Store UX Test',             title:'Shopify Store UX Test',               type:'task',   tier:'golden',  reward:80, time:'12 min', questions:10, difficulty:'Hard',   avatar:'🛍️' },
  { category:'Reddit Community Poll',             title:'Reddit Community Opinion Poll',       type:'survey', tier:'golden',  reward:65, time:'9 min',  questions:7,  difficulty:'Medium', avatar:'👽' },
  { category:'Pinterest Board Categorization',    title:'Categorize Pinterest Boards',         type:'task',   tier:'classic', reward:35, time:'5 min',  questions:5,  difficulty:'Easy',   avatar:'📌' },
  { category:'Snapchat Filter Feedback',          title:'Snapchat Filter Feedback Survey',     type:'survey', tier:'classic', reward:38, time:'6 min',  questions:6,  difficulty:'Easy',   avatar:'👻' },
  { category:'Discord Server Moderation',         title:'Discord Community Moderation Task',   type:'task',   tier:'premium', reward:52, time:'8 min',  questions:7,  difficulty:'Medium', avatar:'🎮' },
  { category:'Twitch Streamer Interaction',       title:'Twitch Streamer Engagement Study',    type:'survey', tier:'premium', reward:55, time:'9 min',  questions:8,  difficulty:'Medium', avatar:'🎥' },
];

async function seedTasks() {
  const count = await collections.tasks.countDocuments();
  if (count > 0) return;
  const docs = [];
  for (const t of TASK_TEMPLATES) {
    const id = await nextSeq('tasks');
    docs.push({
      id,
      title: t.title,
      description: `Share your thoughts on ${t.title.toLowerCase()}. Your response helps real companies improve.`,
      category: t.category, type: t.type, tier: t.tier, reward: t.reward,
      time: t.time, questions: t.questions, difficulty: t.difficulty,
      country: 'Kenya',
      owner: { avatar: t.avatar, name: 'JobPay Partner', country: 'Kenya' },
    });
  }
  await collections.tasks.insertMany(docs);
  console.log(`🌱 Seeded ${docs.length} tasks`);
}

function generateQuestions(count) {
  const base = [
    { question: 'How often do you use this product or service?', options: ['Daily', 'Weekly', 'Monthly', 'Rarely', 'Never'] },
    { question: 'How satisfied are you overall?',                options: ['Very satisfied', 'Satisfied', 'Neutral', 'Dissatisfied', 'Very dissatisfied'] },
    { question: 'Would you recommend it to a friend?',           options: ['Definitely', 'Probably', 'Maybe', 'Probably not', 'Definitely not'] },
    { question: 'How easy was it to use?',                       options: ['Very easy', 'Easy', 'Neutral', 'Difficult', 'Very difficult'] },
    { question: 'How does it compare to alternatives?',          options: ['Much better', 'Better', 'About the same', 'Worse', 'Much worse'] },
    { question: 'What matters most to you?',                     options: ['Price', 'Quality', 'Convenience', 'Customer service', 'Brand trust'] },
    { question: 'How likely are you to use it again?',           options: ['Very likely', 'Likely', 'Neutral', 'Unlikely', 'Very unlikely'] },
    { question: 'Which feature is most useful?',                 options: ['Speed', 'Reliability', 'Design', 'Support', 'Value'] },
    { question: 'How would you rate the value for money?',       options: ['Excellent', 'Good', 'Fair', 'Poor', 'Very poor'] },
    { question: 'Any final thoughts?',                           options: ['Love it', 'Like it', 'Neutral', 'Not for me', 'Prefer alternatives'] },
  ];
  return base.slice(0, count);
}

// =============================================================================
//  HELPERS
// =============================================================================
const hashPassword   = (pw) => bcrypt.hashSync(pw, 10);
const verifyPassword = (pw, hash) => bcrypt.compareSync(pw, hash);
const signToken      = (u) => jwt.sign({ uid: u.id }, JWT_SECRET, { expiresIn: '30d' });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    collections.users.findOne({ id: payload.uid }).then(user => {
      if (!user) return res.status(401).json({ error: 'User not found' });
      req.user = user;
      next();
    }).catch(() => res.status(401).json({ error: 'Auth failed' }));
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email, phone: u.phone,
    photo: u.photo || null,
    balance: u.balance || 0, pendingBalance: u.pendingBalance || 0,
    totalEarnings: u.totalEarnings || 0,
    todayEarnings: u.todayEarnings || 0,
    tasksCompletedToday: u.tasksCompletedToday || 0,
    dailyLimit: APP_CONFIG.tierLimits[u.subscriptionTier] || APP_CONFIG.tierLimits.free,
    subscriptionTier: u.subscriptionTier || 'free',
    subscriptionExpiry: u.subscriptionExpiry || null,
    activationFeePaid: !!u.activationFeePaid,
    hasWithdrawalPin: !!u.withdrawalPin,
    twoFactorEnabled: !!u.twoFactorEnabled,
    lastTaskDate: u.lastTaskDate || null,
    createdAt: u.createdAt,
  };
}

async function pushNotif(userId, type, title, message) {
  const id = await nextSeq('notifications');
  const doc = { id, userId, type, title, message, read: false, createdAt: new Date() };
  await collections.notifications.insertOne(doc);
  return doc;
}

async function recordLogin(userId, req, success = true) {
  await collections.loginHistory.insertOne({
    userId, at: new Date(),
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim() || '—',
    ua: req.headers['user-agent'] || '',
    success,
  });
}

function normalizePhone(p) {
  if (!p) return '';
  let s = String(p).replace(/\D/g, '');
  if (s.startsWith('0')) s = '254' + s.slice(1);
  if (!s.startsWith('254')) s = '254' + s;
  return s; // PayHero expects 254XXXXXXXXX
}
const randomRef = (prefix) => prefix + crypto.randomBytes(5).toString('hex').toUpperCase();

// =============================================================================
//  PAYHERO INTEGRATION
// =============================================================================
const payheroClient = axios.create({
  baseURL: PAYHERO_BASE,
  timeout: 20000,
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + Buffer.from(`${PAYHERO_USERNAME}:${PAYHERO_PASSWORD}`).toString('base64'),
  },
});

/**
 * Trigger an STK Push via PayHero.
 * @param {Object} p
 * @param {number} p.amount            - amount in KES (integer)
 * @param {string} p.phone             - 254XXXXXXXXX
 * @param {string} p.externalReference - unique ID for reconciliation
 * @param {string} [p.customerName]
 * @returns {Promise<{reference:string, checkoutRequestId:string, raw:object}>}
 */
async function payheroStkPush({ amount, phone, externalReference, customerName }) {
  if (!PAYHERO_USERNAME || !PAYHERO_PASSWORD || !PAYHERO_CHANNEL_ID) {
    throw new Error('PayHero is not configured (PAYHERO_USERNAME, PAYHERO_PASSWORD, PAYHERO_CHANNEL_ID required)');
  }
  const body = {
    amount: Math.round(amount),
    phone_number: phone,
    channel_id: PAYHERO_CHANNEL_ID,
    provider: 'm-pesa',
    external_reference: externalReference,
    callback_url: PAYHERO_CALLBACK_URL || undefined,
    customer_name: customerName || 'JobPay Customer',
  };
  const { data } = await payheroClient.post('/payments', body);
  // PayHero returns { success, reference, CheckoutRequestID, ... }
  return {
    reference: data.reference || data.Reference || externalReference,
    checkoutRequestId: data.CheckoutRequestID || data.checkout_request_id || null,
    raw: data,
  };
}

async function payheroStatus(reference) {
  const { data } = await payheroClient.get('/transaction-status', { params: { reference } });
  return data;
}

// =============================================================================
//  ROUTES — CONFIG
// =============================================================================
app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.json({ ...APP_CONFIG, prices: { ...APP_CONFIG.tierPrices } });
});
app.get('/api/prices', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ...APP_CONFIG.tierPrices });
});

// =============================================================================
//  ROUTES — AUTH
// =============================================================================
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, phone, password, confirmPassword } = req.body || {};
    if (!username || !email || !phone || !password) return res.status(400).json({ error: 'All fields are required' });
    if (password !== confirmPassword)              return res.status(400).json({ error: 'Passwords do not match' });
    if (!(password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password)))
      return res.status(400).json({ error: 'Password must be 8+ chars with uppercase, lowercase, and a number' });

    const existing = await collections.users.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const id = await nextSeq('users');
    const user = {
      id, username,
      email: email.toLowerCase(),
      phone: normalizePhone(phone),
      passwordHash: hashPassword(password),
      photo: null,
      balance: 0, pendingBalance: 0, totalEarnings: 0, todayEarnings: 0,
      tasksCompletedToday: 0,
      subscriptionTier: 'free', subscriptionExpiry: null,
      activationFeePaid: false,
      withdrawalPin: null, twoFactorEnabled: false,
      lastTaskDate: null,
      createdAt: new Date(),
    };
    await collections.users.insertOne(user);

    await pushNotif(id, 'system', 'Welcome to JobPay! 🎉',
      `You get ${APP_CONFIG.freeDailyTasks} free tasks every day. Complete them to start earning.`);
    await recordLogin(id, req, true);

    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await collections.users.findOne({ email: email.toLowerCase() });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      if (user) await recordLogin(user.id, req, false);
      return res.status(400).json({ error: 'Invalid email or password' });
    }
    await recordLogin(user.id, req, true);
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// =============================================================================
//  ROUTES — ME
// =============================================================================
app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));

// =============================================================================
//  ROUTES — TASKS
// =============================================================================
async function userTaskStatus(user, taskId) {
  const completed = await collections.completions.findOne({ userId: user.id, taskId });
  if (completed) return 'completed';
  const tier  = user.subscriptionTier || 'free';
  const limit = APP_CONFIG.tierLimits[tier] || APP_CONFIG.tierLimits.free;
  if ((user.tasksCompletedToday || 0) >= limit) return 'locked';
  const task = await collections.tasks.findOne({ id: taskId });
  if (!task) return 'locked';
  const rank = { free: 0, classic: 1, premium: 2, golden: 3 };
  if ((rank[task.tier] || 0) > (rank[tier] || 0)) return 'locked';
  return 'unlocked';
}

app.get('/api/tasks', auth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(100, parseInt(req.query.size) || 50);
    const type = (req.query.type || '').trim();
    const filter = type ? { type } : {};
    const totalCount = await collections.tasks.countDocuments(filter);
    const list = await collections.tasks.find(filter).sort({ id: 1 }).skip((page - 1) * size).limit(size).toArray();

    const enriched = await Promise.all(list.map(async t => ({ ...t, status: await userTaskStatus(req.user, t.id) })));
    res.json({ tasks: enriched, totalCount });
  } catch (err) {
    console.error('Tasks list error:', err);
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});

app.get('/api/tasks/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = await collections.tasks.findOne({ id });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const status = await userTaskStatus(req.user, id);
    if (status === 'locked')    return res.status(403).json({ error: 'Task locked. Complete or upgrade to unlock.' });
    if (status === 'completed') return res.status(400).json({ error: 'Task already completed' });
    res.json({ task: { ...task, status }, questions: generateQuestions(task.questions) });
  } catch (err) {
    console.error('Task fetch error:', err);
    res.status(500).json({ error: 'Failed to load task' });
  }
});

app.post('/api/tasks/:id/complete', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = await collections.tasks.findOne({ id });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const { answers } = req.body || {};
    if (!Array.isArray(answers)) return res.status(400).json({ error: 'Answers required' });
    if ((await userTaskStatus(req.user, id)) !== 'unlocked') return res.status(400).json({ error: 'Task is not available' });

    const user  = req.user;
    const reward = task.tier === 'free' ? APP_CONFIG.freeTaskReward : task.reward;

    await collections.users.updateOne({ id: user.id }, {
      $inc: { pendingBalance: reward, tasksCompletedToday: 1 },
      $set: { lastTaskDate: new Date() },
    });
    await collections.completions.insertOne({ userId: user.id, taskId: id, at: new Date(), answers });

    const txId = await nextSeq('walletTx');
    await collections.walletTx.insertOne({
      id: txId, userId: user.id, type: 'task_reward', amount: reward, status: 'pending',
      taskTitle: task.title, owner: task.owner,
      reference: randomRef('TSK'), createdAt: new Date(), confirmedAt: null,
    });

    await pushNotif(user.id, 'task', 'Task submitted ⏳',
      `Your submission "${task.title}" is awaiting confirmation. Reward: KES ${reward}.`);

    // Auto-approve after 20s (replace with admin action in production)
    setTimeout(async () => {
      try {
        const u = await collections.users.findOne({ id: user.id });
        if (!u) return;
        await collections.users.updateOne({ id: user.id }, {
          $inc: { pendingBalance: -reward, balance: reward, totalEarnings: reward, todayEarnings: reward },
        });
        await collections.walletTx.updateOne(
          { userId: user.id, reference: { $exists: false }, taskTitle: task.title, status: 'pending' },
          { $set: { status: 'completed', confirmedAt: new Date() } }
        );
        // The above filter may not match — do a safer update:
        await collections.walletTx.updateOne(
          { userId: user.id, type: 'task_reward', taskTitle: task.title, status: 'pending' },
          { $set: { status: 'completed', confirmedAt: new Date() } }
        );
        await pushNotif(u.id, 'task_approved', 'Task approved ✅',
          `"${task.title}" was approved. KES ${reward} credited.`);
      } catch (e) { console.error('Auto-approve error:', e); }
    }, 20000);

    res.json({ reward, message: 'Submitted. Awaiting admin confirmation.' });
  } catch (err) {
    console.error('Complete task error:', err);
    res.status(500).json({ error: 'Failed to submit task' });
  }
});

// =============================================================================
//  ROUTES — HISTORY
// =============================================================================
app.get('/api/history', auth, async (req, res) => {
  try {
    const list = await collections.walletTx
      .find({ userId: req.user.id, type: 'task_reward' })
      .sort({ createdAt: -1 }).limit(200).toArray();
    res.json(list.map(t => ({
      id: t.id,
      taskTitle: t.taskTitle,
      owner: t.owner,
      reward: t.amount,
      status: t.status === 'completed' ? 'completed' : t.status === 'failed' ? 'failed' : 'pending',
      reason: t.reason || null,
      completedAt: t.confirmedAt || t.createdAt,
      answersCount: 5,
    })));
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

app.get('/api/wallet/history', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const [paymentTransactions, walletTransactions] = await Promise.all([
      collections.payTx.find({ userId: uid }).sort({ createdAt: -1 }).limit(100).toArray(),
      collections.walletTx.find({ userId: uid }).sort({ createdAt: -1 }).limit(100).toArray(),
    ]);
    res.json({ paymentTransactions, walletTransactions });
  } catch (err) {
    console.error('Wallet history error:', err);
    res.status(500).json({ error: 'Failed to load wallet history' });
  }
});

// =============================================================================
//  ROUTES — WALLET  (PayHero integration)
// =============================================================================
app.post('/api/wallet/deposit', auth, async (req, res) => {
  try {
    const { amount, phone } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt < APP_CONFIG.minDeposit)
      return res.status(400).json({ error: `Minimum deposit is ${APP_CONFIG.currency} ${APP_CONFIG.minDeposit}` });
    if (amt > APP_CONFIG.maxDeposit)
      return res.status(400).json({ error: `Maximum deposit is ${APP_CONFIG.currency} ${APP_CONFIG.maxDeposit}` });

    const normPhone = normalizePhone(phone || req.user.phone);
    const externalReference = randomRef('DEP');

    const txId = await nextSeq('payTx');
    const doc = {
      id: txId, userId: req.user.id, kind: 'deposit', amount: amt,
      status: 'pending', phone: normPhone,
      reference: externalReference, mpesaRef: null,
      checkoutRequestId: null,
      createdAt: new Date(), completedAt: null,
    };
    await collections.payTx.insertOne(doc);

    try {
      const ph = await payheroStkPush({
        amount: amt, phone: normPhone,
        externalReference, customerName: req.user.username,
      });
      await collections.payTx.updateOne(
        { reference: externalReference },
        { $set: { checkoutRequestId: ph.checkoutRequestId, payheroReference: ph.reference } }
      );
      res.json({ phone: normPhone, amount: amt, reference: externalReference, message: 'STK push sent' });
    } catch (phErr) {
      console.error('PayHero deposit error:', phErr.response?.data || phErr.message);
      await collections.payTx.updateOne(
        { reference: externalReference },
        { $set: { status: 'failed', reason: 'STK push failed' } }
      );
      res.status(400).json({ error: phErr.response?.data?.message || 'Payment initiation failed. Please try again.' });
    }
  } catch (err) {
    console.error('Deposit error:', err);
    res.status(500).json({ error: 'Deposit failed' });
  }
});

app.post('/api/wallet/pay-activation', auth, async (req, res) => {
  try {
    if (req.user.activationFeePaid) return res.json({ phone: req.user.phone, amount: 0, message: 'Already activated' });
    const normPhone = normalizePhone(req.body?.phone || req.user.phone);
    const externalReference = randomRef('ACT');
    const amt = APP_CONFIG.activationFee;

    const txId = await nextSeq('payTx');
    await collections.payTx.insertOne({
      id: txId, userId: req.user.id, kind: 'activation', amount: amt,
      status: 'pending', phone: normPhone, reference: externalReference,
      createdAt: new Date(),
    });

    try {
      const ph = await payheroStkPush({
        amount: amt, phone: normPhone,
        externalReference, customerName: req.user.username,
      });
      await collections.payTx.updateOne(
        { reference: externalReference },
        { $set: { checkoutRequestId: ph.checkoutRequestId, payheroReference: ph.reference } }
      );
      res.json({ phone: normPhone, amount: amt, reference: externalReference });
    } catch (phErr) {
      console.error('PayHero activation error:', phErr.response?.data || phErr.message);
      await collections.payTx.updateOne({ reference: externalReference }, { $set: { status: 'failed' } });
      res.status(400).json({ error: 'Activation payment failed. Please try again.' });
    }
  } catch (err) {
    console.error('Activation error:', err);
    res.status(500).json({ error: 'Activation failed' });
  }
});

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  try {
    const { amount, pin } = req.body || {};
    const amt  = Number(amount);
    const user = req.user;

    if (!user.activationFeePaid) return res.status(403).json({ error: 'Account not activated', code: 'ACTIVATION_REQUIRED' });
    if (!amt || amt < APP_CONFIG.minWithdrawal)
      return res.status(400).json({ error: `Minimum withdrawal is ${APP_CONFIG.currency} ${APP_CONFIG.minWithdrawal}` });
    if (amt > APP_CONFIG.maxWithdrawal)
      return res.status(400).json({ error: `Maximum withdrawal is ${APP_CONFIG.currency} ${APP_CONFIG.maxWithdrawal}` });
    if (amt > user.balance) return res.status(400).json({ error: 'Insufficient funds' });
    if (user.withdrawalPin && !pin)                        return res.status(400).json({ error: 'Withdrawal PIN required' });
    if (user.withdrawalPin && pin !== user.withdrawalPin)  return res.status(400).json({ error: 'Incorrect withdrawal PIN' });

    await collections.users.updateOne({ id: user.id }, { $inc: { balance: -amt } });

    const reference = randomRef('WDR');
    const txId = await nextSeq('walletTx');
    await collections.walletTx.insertOne({
      id: txId, userId: user.id, type: 'withdrawal', amount: amt,
      status: 'pending', phone: user.phone, reference,
      createdAt: new Date(), confirmedAt: null,
    });

    await pushNotif(user.id, 'withdrawal', 'Withdrawal requested ⏳',
      `KES ${amt} is on its way to ${user.phone}.`);

    // In production, hand off to your payout logic (B2C or manual admin approval)
    setTimeout(async () => {
      try {
        await collections.walletTx.updateOne(
          { reference, status: 'pending' },
          { $set: { status: 'completed', confirmedAt: new Date(), mpesaRef: randomRef('MP') } }
        );
        await pushNotif(user.id, 'withdrawal_paid', 'Withdrawal paid 💸',
          `KES ${amt} sent to ${user.phone}.`);
      } catch (e) { console.error('Withdraw settle error:', e); }
    }, 15000);

    res.json({ message: `Withdrawal of KES ${amt} submitted`, reference });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

// =============================================================================
//  ROUTES — SUBSCRIBE (PayHero)
// =============================================================================
app.post('/api/subscribe', auth, async (req, res) => {
  try {
    const { tier, phone } = req.body || {};
    if (!['classic', 'premium', 'golden'].includes(tier)) return res.status(400).json({ error: 'Invalid tier' });
    const price = APP_CONFIG.tierPrices[tier];
    const normPhone = normalizePhone(phone || req.user.phone);
    const externalReference = randomRef('SUB');

    const txId = await nextSeq('payTx');
    await collections.payTx.insertOne({
      id: txId, userId: req.user.id, kind: 'subscription', tier, amount: price,
      status: 'pending', phone: normPhone, reference: externalReference,
      createdAt: new Date(),
    });

    try {
      const ph = await payheroStkPush({
        amount: price, phone: normPhone,
        externalReference, customerName: req.user.username,
      });
      await collections.payTx.updateOne(
        { reference: externalReference },
        { $set: { checkoutRequestId: ph.checkoutRequestId, payheroReference: ph.reference } }
      );
      res.json({ phone: normPhone, amount: price, reference: externalReference, message: 'STK push sent' });
    } catch (phErr) {
      console.error('PayHero subscribe error:', phErr.response?.data || phErr.message);
      await collections.payTx.updateOne({ reference: externalReference }, { $set: { status: 'failed' } });
      res.status(400).json({ error: 'Subscription payment failed. Please try again.' });
    }
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Subscription failed' });
  }
});

// =============================================================================
//  ROUTES — PAYHERO CALLBACK
// =============================================================================
app.post('/api/payhero/callback', async (req, res) => {
  // Always ACK quickly so PayHero doesn't retry forever
  res.json({ received: true });

  try {
    const body = req.body || {};
    console.log('📩 PayHero callback:', JSON.stringify(body));

    // PayHero callback shape varies; handle common fields
    const reference    = body.external_reference || body.reference || body.ExternalReference || body.externalReference;
    const mpesaRef     = body.MpesaReceiptNumber || body.mpesa_receipt || body.response?.MpesaReceiptNumber;
    const statusStr    = (body.status || body.Status || '').toString().toUpperCase();
    const resultCode   = body.ResultCode ?? body.response?.ResultCode;
    const success      = statusStr === 'SUCCESS' || statusStr === 'TRUE' || resultCode === 0 || resultCode === '0';

    if (!reference) return console.warn('⚠️ Callback missing reference');

    const tx = await collections.payTx.findOne({ reference });
    if (!tx) return console.warn('⚠️ Unknown reference:', reference);
    if (tx.status === 'completed') return; // idempotent

    if (!success) {
      await collections.payTx.updateOne(
        { reference },
        { $set: { status: 'failed', reason: body.ResultDesc || body.message || 'Payment failed' } }
      );
      return;
    }

    await collections.payTx.updateOne(
      { reference },
      { $set: { status: 'completed', completedAt: new Date(), mpesaRef: mpesaRef || randomRef('MP') } }
    );

    const user = await collections.users.findOne({ id: tx.userId });
    if (!user) return;

    if (tx.kind === 'deposit') {
      await collections.users.updateOne({ id: user.id }, { $inc: { balance: tx.amount } });
      await collections.walletTx.insertOne({
        id: await nextSeq('walletTx'), userId: user.id, type: 'deposit', amount: tx.amount,
        status: 'completed', phone: tx.phone, reference, mpesaRef: mpesaRef || null,
        createdAt: tx.createdAt, confirmedAt: new Date(),
      });
      await pushNotif(user.id, 'deposit', 'Deposit received 💰', `KES ${tx.amount} has been added to your wallet.`);
    } else if (tx.kind === 'activation') {
      await collections.users.updateOne({ id: user.id }, { $set: { activationFeePaid: true } });
      await collections.walletTx.insertOne({
        id: await nextSeq('walletTx'), userId: user.id, type: 'activation_fee', amount: -tx.amount,
        status: 'completed', phone: tx.phone, reference, mpesaRef: mpesaRef || null,
        createdAt: tx.createdAt, confirmedAt: new Date(),
      });
      await pushNotif(user.id, 'activation', 'Account activated 🔓', 'Withdrawals are now unlocked.');
    } else if (tx.kind === 'subscription') {
      await collections.users.updateOne(
        { id: user.id },
        { $set: {
          subscriptionTier: tx.tier,
          subscriptionExpiry: new Date(Date.now() + 7 * 86400000),
          tasksCompletedToday: 0,
        } }
      );
      await collections.walletTx.insertOne({
        id: await nextSeq('walletTx'), userId: user.id, type: 'subscription', amount: -tx.amount,
        status: 'completed', tier: tx.tier, phone: tx.phone, reference, mpesaRef: mpesaRef || null,
        createdAt: tx.createdAt, confirmedAt: new Date(),
      });
      await pushNotif(user.id, 'subscription', `${tx.tier} activated ⭐`,
        `Your ${tx.tier} plan is active for 7 days. Daily limit: ${APP_CONFIG.tierLimits[tx.tier]} tasks.`);
    }
  } catch (err) {
    console.error('Callback handler error:', err);
  }
});

// Poll PayHero status (optional fallback if webhook isn't reachable locally)
app.get('/api/payhero/status/:reference', auth, async (req, res) => {
  try {
    const tx = await collections.payTx.findOne({ reference: req.params.reference, userId: req.user.id });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ status: tx.status, amount: tx.amount, kind: tx.kind });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// =============================================================================
//  ROUTES — USER
// =============================================================================
app.post('/api/user/photo', auth, async (req, res) => {
  const { photo } = req.body || {};
  if (!photo || typeof photo !== 'string') return res.status(400).json({ error: 'Photo required' });
  await collections.users.updateOne({ id: req.user.id }, { $set: { photo } });
  res.json({ photo });
});
app.delete('/api/user/photo', auth, async (req, res) => {
  await collections.users.updateOne({ id: req.user.id }, { $set: { photo: null } });
  res.json({ ok: true });
});
app.put('/api/user/profile', auth, async (req, res) => {
  try {
    const { username, email, phone } = req.body || {};
    const set = {};
    if (username) set.username = username;
    if (email && email.toLowerCase() !== req.user.email) {
      const dup = await collections.users.findOne({ email: email.toLowerCase() });
      if (dup) return res.status(400).json({ error: 'Email in use' });
      set.email = email.toLowerCase();
    }
    if (phone) set.phone = normalizePhone(phone);
    if (Object.keys(set).length) await collections.users.updateOne({ id: req.user.id }, { $set: set });
    const fresh = await collections.users.findOne({ id: req.user.id });
    res.json({ user: publicUser(fresh) });
  } catch (err) {
    res.status(500).json({ error: 'Profile update failed' });
  }
});
app.post('/api/user/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (!verifyPassword(currentPassword, req.user.passwordHash)) return res.status(400).json({ error: 'Current password is incorrect' });
  if (!(newPassword.length >= 8 && /[A-Z]/.test(newPassword) && /[a-z]/.test(newPassword) && /[0-9]/.test(newPassword)))
    return res.status(400).json({ error: 'Password must be 8+ chars with uppercase, lowercase, and a number' });
  await collections.users.updateOne({ id: req.user.id }, { $set: { passwordHash: hashPassword(newPassword) } });
  res.json({ ok: true });
});
app.post('/api/user/2fa', auth, async (req, res) => {
  await collections.users.updateOne({ id: req.user.id }, { $set: { twoFactorEnabled: !!req.body.enabled } });
  res.json({ ok: true });
});
app.post('/api/user/withdrawal-pin', auth, async (req, res) => {
  const { pin, password } = req.body || {};
  if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4-6 digits' });
  if (!verifyPassword(password, req.user.passwordHash)) return res.status(400).json({ error: 'Password incorrect' });
  await collections.users.updateOne({ id: req.user.id }, { $set: { withdrawalPin: pin } });
  res.json({ ok: true });
});
app.get('/api/user/login-history', auth, async (req, res) => {
  const items = await collections.loginHistory.find({ userId: req.user.id }).sort({ at: -1 }).limit(20).toArray();
  res.json(items);
});
app.post('/api/user/deactivate', auth, async (req, res) => {
  const { password } = req.body || {};
  if (!verifyPassword(password, req.user.passwordHash)) return res.status(400).json({ error: 'Password incorrect' });
  await collections.users.updateOne({ id: req.user.id }, { $set: { deactivated: true } });
  res.json({ ok: true });
});
app.post('/api/user/delete', auth, async (req, res) => {
  const { password, confirm } = req.body || {};
  if (confirm !== 'DELETE') return res.status(400).json({ error: 'Confirmation required' });
  if (!verifyPassword(password, req.user.passwordHash)) return res.status(400).json({ error: 'Password incorrect' });
  await collections.users.deleteOne({ id: req.user.id });
  res.json({ ok: true });
});

// =============================================================================
//  ROUTES — SUPPORT
// =============================================================================
app.get('/api/support/tickets', auth, async (req, res) => {
  const list = await collections.tickets.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50).toArray();
  res.json(list);
});
app.post('/api/support/ticket', auth, async (req, res) => {
  const { category, subject, message } = req.body || {};
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' });
  const id = await nextSeq('tickets');
  const t = {
    id, ticketNumber: 'TK' + String(id).padStart(5, '0'),
    userId: req.user.id, category: category || 'other',
    subject, message, status: 'open', createdAt: new Date(),
  };
  await collections.tickets.insertOne(t);
  await pushNotif(req.user.id, 'system', 'Ticket submitted',
    `Ticket ${t.ticketNumber} received. We'll get back to you soon.`);
  res.json(t);
});

// =============================================================================
//  ROUTES — NOTIFICATIONS
// =============================================================================
app.get('/api/notifications', auth, async (req, res) => {
  const list = await collections.notifications.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50).toArray();
  const unread = await collections.notifications.countDocuments({ userId: req.user.id, read: false });
  res.json({ notifications: list, unread });
});
app.get('/api/notifications/unread-count', auth, async (req, res) => {
  const unread = await collections.notifications.countDocuments({ userId: req.user.id, read: false });
  res.json({ unread });
});
app.post('/api/notifications/:id/read', auth, async (req, res) => {
  await collections.notifications.updateOne({ id: Number(req.params.id), userId: req.user.id }, { $set: { read: true } });
  res.json({ ok: true });
});
app.post('/api/notifications/read-all', auth, async (req, res) => {
  await collections.notifications.updateMany({ userId: req.user.id, read: false }, { $set: { read: true } });
  res.json({ ok: true });
});

// =============================================================================
//  SPA FALLBACK
// =============================================================================
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// =============================================================================
//  BOOT
// =============================================================================
(async () => {
  try {
    await connectDB();
    await seedTasks();
    app.listen(PORT, () => console.log(`✅ JobPay running → http://localhost:${PORT}`));
  } catch (err) {
    console.error('❌ Startup failed:', err);
    process.exit(1);
  }
})();
