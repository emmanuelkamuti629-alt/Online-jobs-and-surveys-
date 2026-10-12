// =============================================================================
//  JobPay — server.js
//  Single source of truth for: minimum deposits, minimum withdrawals,
//  activation fee, referral bonus, free tier, quick-amount buttons,
//  tier limits, tier prices. All editable via env vars or APP_CONFIG below.
// =============================================================================

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'jobpay-dev-secret-change-me';
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));

// =============================================================================
//  CONFIG — single source of truth for the whole UI
//  Override any value with an env var (e.g. MIN_WITHDRAWAL=250 npm start)
// =============================================================================
const APP_CONFIG = {
  currency: 'KES',

  // Wallet limits
  minDeposit:    Number(process.env.MIN_DEPOSIT)    || 50,
  maxDeposit:    Number(process.env.MAX_DEPOSIT)    || 150000,
  minWithdrawal: Number(process.env.MIN_WITHDRAWAL) || 200,
  maxWithdrawal: Number(process.env.MAX_WITHDRAWAL) || 50000,

  // Fees & bonuses
  activationFee: Number(process.env.ACTIVATION_FEE) || 499,
  referralBonus: Number(process.env.REFERRAL_BONUS) || 50,

  // Free tier
  freeDailyTasks:        Number(process.env.FREE_DAILY_TASKS)  || 2,
  freeTaskReward:        Number(process.env.FREE_TASK_REWARD)  || 21,
  freeTaskCooldownHours: 24,

  // Quick-amount buttons in deposit / withdraw modals
  depositQuickAmounts:    [50, 100, 200, 500, 1000, 2000, 5000],
  withdrawalQuickAmounts: [200, 300, 500, 1000, 2000, 5000],

  // Subscription tiers
  tierLimits: { free: 2, classic: 10, premium: 20, golden: 50 },
  tierPrices: { classic: 200, premium: 350, golden: 450 },

  withdrawalPinRequired: true,
  supportEmail: 'support@jobpay.co.ke',
};

// =============================================================================
//  IN-MEMORY DATA STORE  (swap for SQLite / Postgres in production)
// =============================================================================
const users           = new Map();   // id → user
const usersByEmail    = new Map();   // email → id
const tasks           = new Map();   // id → task
const taskCompletions = new Map();   // userId → Set(taskId)
const walletTx        = [];          // wallet transactions
const payTx           = [];          // payment (M-Pesa) transactions
const notifications   = [];          // notifications
const tickets         = [];          // support tickets
const loginHistory    = [];          // login history

let userIdSeq   = 1;
let taskIdSeq   = 1;
let txIdSeq     = 1;
let notifIdSeq  = 1;
let ticketIdSeq = 1;

// =============================================================================
//  SEED TASKS
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

function seedTasks() {
  TASK_TEMPLATES.forEach(t => {
    const id = taskIdSeq++;
    tasks.set(id, {
      id,
      title: t.title,
      description: `Share your thoughts on ${t.title.toLowerCase()}. Your response helps real companies improve.`,
      category: t.category,
      type: t.type,
      tier: t.tier,
      reward: t.reward,
      time: t.time,
      questions: t.questions,
      difficulty: t.difficulty,
      country: 'Kenya',
      owner: { avatar: t.avatar, name: 'JobPay Partner', country: 'Kenya' },
    });
  });
}
seedTasks();

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
    const user = users.get(payload.uid);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    phone: u.phone,
    photo: u.photo || null,
    balance: u.balance,
    pendingBalance: u.pendingBalance,
    totalEarnings: u.totalEarnings,
    todayEarnings: u.todayEarnings || 0,
    tasksCompletedToday: u.tasksCompletedToday || 0,
    dailyLimit: APP_CONFIG.tierLimits[u.subscriptionTier] || APP_CONFIG.tierLimits.free,
    subscriptionTier: u.subscriptionTier,
    subscriptionExpiry: u.subscriptionExpiry,
    activationFeePaid: u.activationFeePaid,
    hasWithdrawalPin: !!u.withdrawalPin,
    twoFactorEnabled: !!u.twoFactorEnabled,
    lastTaskDate: u.lastTaskDate,
    createdAt: u.createdAt,
  };
}

function pushNotif(userId, type, title, message) {
  const n = { id: notifIdSeq++, userId, type, title, message, read: false, createdAt: new Date().toISOString() };
  notifications.push(n);
  return n;
}

function recordLogin(userId, req, success = true) {
  loginHistory.push({
    id: crypto.randomBytes(6).toString('hex'),
    userId,
    at: new Date().toISOString(),
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
  return '+' + s;
}
const mpesaRef = () => 'MP' + crypto.randomBytes(5).toString('hex').toUpperCase();

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
app.post('/api/register', (req, res) => {
  try {
    const { username, email, phone, password, confirmPassword } = req.body || {};
    if (!username || !email || !phone || !password) return res.status(400).json({ error: 'All fields are required' });
    if (password !== confirmPassword)              return res.status(400).json({ error: 'Passwords do not match' });
    if (!(password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password)))
      return res.status(400).json({ error: 'Password must be 8+ chars with uppercase, lowercase, and a number' });
    if (usersByEmail.has(email.toLowerCase())) return res.status(400).json({ error: 'Email already registered' });

    const id = userIdSeq++;
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
      createdAt: new Date().toISOString(),
    };
    users.set(id, user);
    usersByEmail.set(user.email, id);
    taskCompletions.set(id, new Set());

    pushNotif(id, 'system', 'Welcome to JobPay! 🎉',
      `You get ${APP_CONFIG.freeDailyTasks} free tasks every day. Complete them to start earning.`);
    recordLogin(id, req, true);

    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const id = usersByEmail.get(email.toLowerCase());
    const user = id ? users.get(id) : null;
    if (!user || !verifyPassword(password, user.passwordHash)) {
      if (user) recordLogin(user.id, req, false);
      return res.status(400).json({ error: 'Invalid email or password' });
    }
    recordLogin(user.id, req, true);
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
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
function userTaskStatus(user, taskId) {
  const completed = taskCompletions.get(user.id) || new Set();
  if (completed.has(taskId)) return 'completed';
  const tier  = user.subscriptionTier || 'free';
  const limit = APP_CONFIG.tierLimits[tier] || APP_CONFIG.tierLimits.free;
  if ((user.tasksCompletedToday || 0) >= limit) return 'locked';
  const task = tasks.get(taskId);
  if (!task) return 'locked';
  const rank = { free: 0, classic: 1, premium: 2, golden: 3 };
  if ((rank[task.tier] || 0) > (rank[tier] || 0)) return 'locked';
  return 'unlocked';
}

app.get('/api/tasks', auth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const size = Math.min(100, parseInt(req.query.size) || 50);
  const type = (req.query.type || '').trim();
  let list = Array.from(tasks.values());
  if (type) list = list.filter(t => t.type === type);
  const totalCount = list.length;
  const start = (page - 1) * size;
  const slice = list.slice(start, start + size).map(t => ({
    ...t,
    status: userTaskStatus(req.user, t.id),
  }));
  res.json({ tasks: slice, totalCount });
});

app.get('/api/tasks/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const task = tasks.get(id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const status = userTaskStatus(req.user, id);
  if (status === 'locked')    return res.status(403).json({ error: 'Task locked. Complete or upgrade to unlock.' });
  if (status === 'completed') return res.status(400).json({ error: 'Task already completed' });
  res.json({ task: { ...task, status }, questions: generateQuestions(task.questions) });
});

app.post('/api/tasks/:id/complete', auth, (req, res) => {
  const id = Number(req.params.id);
  const task = tasks.get(id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const { answers } = req.body || {};
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'Answers required' });
  if (userTaskStatus(req.user, id) !== 'unlocked') return res.status(400).json({ error: 'Task is not available' });

  const user = req.user;
  const reward = task.tier === 'free' ? APP_CONFIG.freeTaskReward : task.reward;

  user.pendingBalance = (user.pendingBalance || 0) + reward;
  user.tasksCompletedToday = (user.tasksCompletedToday || 0) + 1;
  user.lastTaskDate = new Date().toISOString();

  const completed = taskCompletions.get(user.id) || new Set();
  completed.add(id);
  taskCompletions.set(user.id, completed);

  const now = new Date().toISOString();
  const wtx = {
    id: txIdSeq++,
    userId: user.id,
    type: 'task_reward',
    amount: reward,
    status: 'pending',
    taskTitle: task.title,
    owner: task.owner,
    createdAt: now,
    confirmedAt: null,
    reference: 'TSK' + crypto.randomBytes(5).toString('hex').toUpperCase(),
  };
  walletTx.push(wtx);

  pushNotif(user.id, 'task', 'Task submitted ⏳',
    `Your submission "${task.title}" is awaiting confirmation. Reward: KES ${reward}.`);

  // Demo: auto-approve after 20 seconds
  setTimeout(() => {
    const u = users.get(user.id);
    if (!u) return;
    u.pendingBalance = Math.max(0, (u.pendingBalance || 0) - reward);
    u.balance        = (u.balance || 0) + reward;
    u.totalEarnings  = (u.totalEarnings || 0) + reward;
    u.todayEarnings  = (u.todayEarnings || 0) + reward;
    wtx.status = 'completed';
    wtx.confirmedAt = new Date().toISOString();
    pushNotif(u.id, 'task_approved', 'Task approved ✅',
      `"${task.title}" was approved. KES ${reward} credited.`);
  }, 20000);

  res.json({ reward, message: 'Submitted. Awaiting admin confirmation.' });
});

// =============================================================================
//  ROUTES — HISTORY
// =============================================================================
app.get('/api/history', auth, (req, res) => {
  const list = walletTx
    .filter(t => t.userId === req.user.id && t.type === 'task_reward')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(t => ({
      id: t.id,
      taskTitle: t.taskTitle,
      owner: t.owner,
      reward: t.amount,
      status: t.status === 'completed' ? 'completed' : t.status === 'failed' ? 'failed' : 'pending',
      reason: t.reason || null,
      completedAt: t.confirmedAt || t.createdAt,
      answersCount: 5,
    }));
  res.json(list);
});

app.get('/api/wallet/history', auth, (req, res) => {
  const uid = req.user.id;
  res.json({
    paymentTransactions: payTx.filter(t => t.userId === uid).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    walletTransactions:  walletTx.filter(t => t.userId === uid).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  });
});

// =============================================================================
//  ROUTES — WALLET
// =============================================================================
app.post('/api/wallet/deposit', auth, (req, res) => {
  const { amount, phone } = req.body || {};
  const amt = Number(amount);
  if (!amt || amt < APP_CONFIG.minDeposit)
    return res.status(400).json({ error: `Minimum deposit is ${APP_CONFIG.currency} ${APP_CONFIG.minDeposit}` });
  if (amt > APP_CONFIG.maxDeposit)
    return res.status(400).json({ error: `Maximum deposit is ${APP_CONFIG.currency} ${APP_CONFIG.maxDeposit}` });

  const normPhone = normalizePhone(phone || req.user.phone);
  const tx = {
    id: txIdSeq++,
    userId: req.user.id,
    kind: 'deposit',
    amount: amt,
    status: 'pending',
    phone: normPhone,
    reference: 'DEP' + crypto.randomBytes(5).toString('hex').toUpperCase(),
    mpesaRef: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  payTx.push(tx);

  setTimeout(() => {
    tx.status = 'completed';
    tx.completedAt = new Date().toISOString();
    tx.mpesaRef = mpesaRef();
    const u = users.get(req.user.id);
    if (u) {
      u.balance = (u.balance || 0) + amt;
      walletTx.push({
        id: txIdSeq++, userId: u.id, type: 'deposit', amount: amt, status: 'completed',
        phone: normPhone, reference: tx.reference, mpesaRef: tx.mpesaRef,
        createdAt: tx.createdAt, confirmedAt: tx.completedAt,
      });
      pushNotif(u.id, 'deposit', 'Deposit received 💰', `KES ${amt} has been added to your wallet.`);
    }
  }, 6000);

  res.json({ phone: normPhone, amount: amt, message: 'STK push sent' });
});

app.post('/api/wallet/pay-activation', auth, (req, res) => {
  if (req.user.activationFeePaid) return res.json({ phone: req.user.phone, amount: 0, message: 'Already activated' });
  const normPhone = normalizePhone(req.body?.phone || req.user.phone);
  const tx = {
    id: txIdSeq++,
    userId: req.user.id,
    kind: 'activation',
    amount: APP_CONFIG.activationFee,
    status: 'pending',
    phone: normPhone,
    reference: 'ACT' + crypto.randomBytes(5).toString('hex').toUpperCase(),
    createdAt: new Date().toISOString(),
  };
  payTx.push(tx);

  setTimeout(() => {
    tx.status = 'completed';
    tx.completedAt = new Date().toISOString();
    tx.mpesaRef = mpesaRef();
    const u = users.get(req.user.id);
    if (u) {
      u.activationFeePaid = true;
      walletTx.push({
        id: txIdSeq++, userId: u.id, type: 'activation_fee', amount: -APP_CONFIG.activationFee,
        status: 'completed', phone: normPhone, reference: tx.reference,
        createdAt: tx.createdAt, confirmedAt: tx.completedAt,
      });
      pushNotif(u.id, 'activation', 'Account activated 🔓', 'Withdrawals are now unlocked.');
    }
  }, 6000);

  res.json({ phone: normPhone, amount: APP_CONFIG.activationFee });
});

app.post('/api/wallet/withdraw', auth, (req, res) => {
  const { amount, pin } = req.body || {};
  const amt  = Number(amount);
  const user = req.user;

  if (!user.activationFeePaid) return res.status(403).json({ error: 'Account not activated', code: 'ACTIVATION_REQUIRED' });
  if (!amt || amt < APP_CONFIG.minWithdrawal)
    return res.status(400).json({ error: `Minimum withdrawal is ${APP_CONFIG.currency} ${APP_CONFIG.minWithdrawal}` });
  if (amt > APP_CONFIG.maxWithdrawal)
    return res.status(400).json({ error: `Maximum withdrawal is ${APP_CONFIG.currency} ${APP_CONFIG.maxWithdrawal}` });
  if (amt > user.balance) return res.status(400).json({ error: 'Insufficient funds' });
  if (user.withdrawalPin && !pin)                    return res.status(400).json({ error: 'Withdrawal PIN required' });
  if (user.withdrawalPin && pin !== user.withdrawalPin) return res.status(400).json({ error: 'Incorrect withdrawal PIN' });

  user.balance -= amt;
  const tx = {
    id: txIdSeq++, userId: user.id, type: 'withdrawal', amount: amt, status: 'pending',
    phone: user.phone,
    reference: 'WDR' + crypto.randomBytes(5).toString('hex').toUpperCase(),
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };
  walletTx.push(tx);

  setTimeout(() => {
    tx.status = 'completed';
    tx.confirmedAt = new Date().toISOString();
    tx.mpesaRef = mpesaRef();
    pushNotif(user.id, 'withdrawal_paid', 'Withdrawal paid 💸',
      `KES ${amt} sent to ${user.phone}. Ref: ${tx.mpesaRef}`);
  }, 15000);

  pushNotif(user.id, 'withdrawal', 'Withdrawal requested ⏳',
    `KES ${amt} is on its way to ${user.phone}.`);

  res.json({ message: `Withdrawal of KES ${amt} submitted`, reference: tx.reference });
});

// =============================================================================
//  ROUTES — SUBSCRIBE
// =============================================================================
app.post('/api/subscribe', auth, (req, res) => {
  const { tier, phone } = req.body || {};
  if (!['classic', 'premium', 'golden'].includes(tier)) return res.status(400).json({ error: 'Invalid tier' });
  const price = APP_CONFIG.tierPrices[tier];
  const normPhone = normalizePhone(phone || req.user.phone);

  const tx = {
    id: txIdSeq++, userId: req.user.id, kind: 'subscription', tier, amount: price,
    status: 'pending', phone: normPhone,
    reference: 'SUB' + crypto.randomBytes(5).toString('hex').toUpperCase(),
    createdAt: new Date().toISOString(),
  };
  payTx.push(tx);

  setTimeout(() => {
    tx.status = 'completed';
    tx.completedAt = new Date().toISOString();
    tx.mpesaRef = mpesaRef();
    const u = users.get(req.user.id);
    if (u) {
      u.subscriptionTier = tier;
      u.subscriptionExpiry = new Date(Date.now() + 7 * 86400000).toISOString();
      u.tasksCompletedToday = 0;
      walletTx.push({
        id: txIdSeq++, userId: u.id, type: 'subscription', amount: -price, status: 'completed',
        tier, phone: normPhone, reference: tx.reference,
        createdAt: tx.createdAt, confirmedAt: tx.completedAt,
      });
      pushNotif(u.id, 'subscription', `${tier} activated ⭐`,
        `Your ${tier} plan is active for 7 days. Daily limit: ${APP_CONFIG.tierLimits[tier]} tasks.`);
    }
  }, 6000);

  res.json({ phone: normPhone, amount: price, message: 'STK push sent' });
});

// =============================================================================
//  ROUTES — USER
// =============================================================================
app.post('/api/user/photo', auth, (req, res) => {
  const { photo } = req.body || {};
  if (!photo || typeof photo !== 'string') return res.status(400).json({ error: 'Photo required' });
  req.user.photo = photo;
  res.json({ photo });
});
app.delete('/api/user/photo', auth, (req, res) => {
  req.user.photo = null;
  res.json({ ok: true });
});
app.put('/api/user/profile', auth, (req, res) => {
  const { username, email, phone } = req.body || {};
  if (username) req.user.username = username;
  if (email && email.toLowerCase() !== req.user.email) {
    if (usersByEmail.has(email.toLowerCase())) return res.status(400).json({ error: 'Email in use' });
    usersByEmail.delete(req.user.email);
    req.user.email = email.toLowerCase();
    usersByEmail.set(req.user.email, req.user.id);
  }
  if (phone) req.user.phone = normalizePhone(phone);
  res.json({ user: publicUser(req.user) });
});
app.post('/api/user/change-password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (!verifyPassword(currentPassword, req.user.passwordHash)) return res.status(400).json({ error: 'Current password is incorrect' });
  if (!(newPassword.length >= 8 && /[A-Z]/.test(newPassword) && /[a-z]/.test(newPassword) && /[0-9]/.test(newPassword)))
    return res.status(400).json({ error: 'Password must be 8+ chars with uppercase, lowercase, and a number' });
  req.user.passwordHash = hashPassword(newPassword);
  res.json({ ok: true });
});
app.post('/api/user/2fa', auth, (req, res) => {
  req.user.twoFactorEnabled = !!req.body.enabled;
  res.json({ ok: true });
});
app.post('/api/user/withdrawal-pin', auth, (req, res) => {
  const { pin, password } = req.body || {};
  if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4-6 digits' });
  if (!verifyPassword(password, req.user.passwordHash)) return res.status(400).json({ error: 'Password incorrect' });
  req.user.withdrawalPin = pin;
  res.json({ ok: true });
});
app.get('/api/user/login-history', auth, (req, res) => {
  const items = loginHistory
    .filter(l => l.userId === req.user.id)
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json(items);
});
app.post('/api/user/deactivate', auth, (req, res) => {
  const { password } = req.body || {};
  if (!verifyPassword(password, req.user.passwordHash)) return res.status(400).json({ error: 'Password incorrect' });
  req.user.deactivated = true;
  res.json({ ok: true });
});
app.post('/api/user/delete', auth, (req, res) => {
  const { password, confirm } = req.body || {};
  if (confirm !== 'DELETE') return res.status(400).json({ error: 'Confirmation required' });
  if (!verifyPassword(password, req.user.passwordHash)) return res.status(400).json({ error: 'Password incorrect' });
  usersByEmail.delete(req.user.email);
  users.delete(req.user.id);
  res.json({ ok: true });
});

// =============================================================================
//  ROUTES — SUPPORT
// =============================================================================
app.get('/api/support/tickets', auth, (req, res) => {
  const list = tickets
    .filter(t => t.userId === req.user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});
app.post('/api/support/ticket', auth, (req, res) => {
  const { category, subject, message } = req.body || {};
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' });
  const t = {
    id: ticketIdSeq++,
    ticketNumber: 'TK' + String(ticketIdSeq).padStart(5, '0'),
    userId: req.user.id,
    category: category || 'other',
    subject, message,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  tickets.push(t);
  pushNotif(req.user.id, 'system', 'Ticket submitted',
    `Ticket ${t.ticketNumber} received. We'll get back to you soon.`);
  res.json(t);
});

// =============================================================================
//  ROUTES — NOTIFICATIONS
// =============================================================================
app.get('/api/notifications', auth, (req, res) => {
  const list = notifications
    .filter(n => n.userId === req.user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 50);
  const unread = notifications.filter(n => n.userId === req.user.id && !n.read).length;
  res.json({ notifications: list, unread });
});
app.get('/api/notifications/unread-count', auth, (req, res) => {
  const unread = notifications.filter(n => n.userId === req.user.id && !n.read).length;
  res.json({ unread });
});
app.post('/api/notifications/:id/read', auth, (req, res) => {
  const n = notifications.find(x => String(x.id) === req.params.id && x.userId === req.user.id);
  if (n) n.read = true;
  res.json({ ok: true });
});
app.post('/api/notifications/read-all', auth, (req, res) => {
  notifications.forEach(n => { if (n.userId === req.user.id) n.read = true; });
  res.json({ ok: true });
});

// =============================================================================
//  SPA FALLBACK
// =============================================================================
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ JobPay running → http://localhost:${PORT}`);
});
