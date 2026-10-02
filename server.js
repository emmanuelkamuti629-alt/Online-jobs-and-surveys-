require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // ✨ NEW: real IP behind Render
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ─── CONFIG ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
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
const FREE_TASK_REWARD = 21;
const MIN_DEPOSIT = 50;
const MIN_WITHDRAWAL = 200;
const SEED_VERSION = 3;

// ─── MONGODB ───────────────────────────────────────────────────────────────
let db, usersCol, txnsCol, tasksCol, walletCol, historyCol, metaCol,
    visitsCol, loginAttemptsCol; // ✨ NEW collections

async function connectDB() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  db = client.db('payhero_jobs');
  usersCol         = db.collection('users');
  txnsCol          = db.collection('transactions');
  tasksCol         = db.collection('tasks');
  walletCol        = db.collection('wallet_transactions');
  historyCol       = db.collection('task_history');
  metaCol          = db.collection('meta');
  visitsCol        = db.collection('site_visits');        // ✨ NEW
  loginAttemptsCol = db.collection('login_attempts');     // ✨ NEW

  await usersCol.createIndex({ email: 1 }, { unique: true });
  await usersCol.createIndex({ username: 1 }, { unique: true });
  await txnsCol.createIndex({ reference: 1 }, { unique: true });
  await walletCol.createIndex({ userId: 1, createdAt: -1 });
  await historyCol.createIndex({ userId: 1, completedAt: -1 });
  await tasksCol.createIndex({ id: 1 }, { unique: true });
  await visitsCol.createIndex({ createdAt: -1 });         // ✨ NEW
  await loginAttemptsCol.createIndex({ createdAt: -1 });  // ✨ NEW

  await seedTasks();
  console.log('✅ MongoDB connected');
}

// ─── SEED (unchanged) ──────────────────────────────────────────────────────
const OWNER_NAMES = ['Sarah M.','James K.','Grace W.','David O.','Amina H.','Peter N.','Lucy A.','Brian C.','Faith M.','Kevin R.','Njeri K.','Otieno J.','Wanjiku S.','Hassan A.','Esther M.','Mercy W.','Kimani T.','Achieng O.','Mwangi D.','Zawadi L.'];
const OWNER_AVATARS = ['👩‍💼','👨‍💼','🧑‍💻','👨‍🔬','👩‍🔬','🧑‍🎓','👨‍🏫','👩‍🏫','🧑‍🎨','👩‍💻','👨‍💻','🧑‍🔧','👨‍⚕️','👩‍⚕️','🧑‍🍳','🧑‍🌾','👩‍🎤','👨‍🎤','🧑‍🚀','👩‍✈️'];
const OWNER_COUNTRIES = ['Kenya','Kenya','Kenya','Uganda','Tanzania','Rwanda','Kenya'];
const AVATAR_COLORS = ['#43B02A','#2196F3','#F5A623','#E91E63','#9C27B0','#00BCD4','#FF5722','#795548','#3F51B5','#009688'];
const SURVEY_TOPICS = ['Consumer Habits','Mobile Banking','Online Shopping','Health & Wellness','Travel Preferences','Social Media','Food Delivery','Streaming Services','Smartphone Usage','Fitness Apps','Gaming Habits','Remote Work','Electric Vehicles','Crypto Adoption','Insurance Products','Retail Brands','Coffee Culture','Fashion Trends','Real Estate','Education Tech','Pet Ownership','Music Streaming','Fitness Wearables','Home Security','Productivity Tools','Personal Finance','Digital Wallets','Beauty Products','Home Cooking','Public Transport','Airlines & Travel','Online Learning','Subscription Services','Cloud Storage','Smart Home Devices','Wearables'];
const TASK_TITLES = ['Verify Product Reviews','Data Entry – Contact List','Image Categorisation','Transcribe Short Audio','Proofread Blog Post','Rate Product Images','Check Website Links','Translate Short Phrases','Tag Images by Category','Verify Business Listings','Classify Customer Reviews','Short Video Transcription','Fill Spreadsheet Data','Compare Prices Online','Rate Website UX','Moderate Comments','Label Sentences for AI','Record Voice Sample','Photograph Receipt','Answer Quick Poll','Map Local Business','Correct OCR Text','Verify News Article','Collect Email Signups'];

function ownerFor(i) {
  return {
    name: OWNER_NAMES[i % OWNER_NAMES.length],
    avatar: OWNER_AVATARS[i % OWNER_AVATARS.length],
    color: AVATAR_COLORS[i % AVATAR_COLORS.length],
    country: OWNER_COUNTRIES[i % OWNER_COUNTRIES.length],
    rating: (4.5 + ((i * 3) % 5) / 10).toFixed(1)
  };
}
function descFor(title, category, country) {
  const t = {
    'Consumer Habits':'Share your shopping habits and product preferences to help brands design better offers.',
    'Mobile Banking':'Tell us how you use mobile money, banks, and digital wallets in your daily life.',
    'Online Shopping':'Help retailers understand what makes you buy (or abandon) online carts.',
    'Health & Wellness':'Answer questions about health routines, fitness, and wellness spending.',
    'Travel Preferences':'Share how and where you like to travel so agencies can tailor packages.',
    'Social Media':'Help us understand which apps you use and why you engage with content.',
    'Food Delivery':'Tell us about your favourite delivery apps, cuisines, and ordering habits.',
    'Streaming Services':'Give feedback on streaming platforms and what makes you subscribe.',
    'Smartphone Usage':'Share how you use your phone and which features matter most.',
    'Fitness Apps':'Tell us about your workout habits and favourite fitness apps.',
    'Gaming Habits':'Answer questions about gaming platforms, genres, and spending.',
    'Remote Work':'Share your experience with remote work tools and productivity.',
    'Electric Vehicles':'Give your opinion on EVs, charging, and future adoption.',
    'Crypto Adoption':'Share your views on cryptocurrencies and digital assets.',
    'Insurance Products':'Help insurers understand what coverage matters to you.',
    'Retail Brands':'Rate your favourite retail brands and what drives loyalty.',
    'Coffee Culture':'Tell us about your coffee habits, brands, and spending.',
    'Fashion Trends':'Share your fashion preferences and shopping patterns.',
    'Real Estate':'Answer questions about housing, rentals, and property buying.',
    'Education Tech':'Give feedback on online learning platforms and tools.',
    'Pet Ownership':'Tell us about your pets and what products you buy for them.',
    'Music Streaming':'Share your music habits and favourite streaming apps.',
    'Fitness Wearables':'Give feedback on smartwatches and fitness trackers.',
    'Home Security':'Answer questions about home security and smart locks.',
    'Productivity Tools':'Tell us which apps help you get things done.',
    'Personal Finance':'Share how you budget, save, and invest.',
    'Digital Wallets':'Rate your digital wallet experience.',
    'Beauty Products':'Answer questions about skincare, makeup, and grooming.',
    'Home Cooking':'Share your cooking habits and grocery shopping.',
    'Public Transport':'Rate your public transport experience.',
    'Airlines & Travel':'Give feedback on airlines, airports, and hotels.',
    'Online Learning':'Share your online learning experience.',
    'Subscription Services':'Tell us which subscriptions you pay for and why.',
    'Cloud Storage':'Answer questions about cloud storage and file sharing.',
    'Smart Home Devices':'Share your smart home setup and preferences.',
    'Wearables':'Tell us about your wearable devices and usage.'
  };
  return t[category] || `Help ${ownerFor(1).name.replace('.','')} understand ${category.toLowerCase()} in ${country}.`;
}
async function seedTasks() {
  const meta = await metaCol.findOne({ key: 'task_seed_version' });
  if (meta && meta.version === SEED_VERSION) return;
  console.log('🌱 Seeding tasks...');
  await tasksCol.deleteMany({});
  const tasks = []; let id = 1;
  for (let i = 0; i < 1200; i++) {
    const topic = SURVEY_TOPICS[i % SURVEY_TOPICS.length];
    const country = OWNER_COUNTRIES[i % OWNER_COUNTRIES.length];
    const owner = ownerFor(i);
    const title = `${topic} Survey – ${country} #${i + 1}`;
    tasks.push({ id: id++, type: 'survey', title, category: topic, country,
      description: descFor(title, topic, country), reward: 21 + ((i * 7) % 40),
      time: `${3 + (i % 5)} min`, questions: 10 + (i % 11),
      difficulty: ['easy','medium','hard'][i % 3], owner, createdAt: new Date() });
  }
  for (let i = 0; i < 1000; i++) {
    const title = TASK_TITLES[i % TASK_TITLES.length];
    const owner = ownerFor(i + 500);
    tasks.push({ id: id++, type: 'task', title: `${title} #${i + 1}`,
      category: 'Micro‑task', country: owner.country,
      description: `${title}. Quick, focused work that takes a few minutes.`,
      reward: 21 + ((i * 5) % 35), time: `${2 + (i % 6)} min`,
      questions: 10 + (i % 6), difficulty: ['easy','medium','hard'][i % 3],
      owner, createdAt: new Date() });
  }
  await tasksCol.insertMany(tasks);
  await metaCol.updateOne({ key: 'task_seed_version' },
    { $set: { version: SEED_VERSION, updatedAt: new Date() } }, { upsert: true });
  console.log(`✅ Seeded ${tasks.length} tasks`);
}

// ─── QUESTIONS (unchanged) ─────────────────────────────────────────────────
const QT = [
  { q:'How often do you use {topic} products or services?', o:['Daily','Weekly','Monthly','Rarely or never'] },
  { q:'How would you rate your overall experience with {topic}?', o:['Very satisfied','Satisfied','Neutral','Dissatisfied'] },
  { q:'Which age group do you belong to?', o:['18-24','25-34','35-44','45+'] },
  { q:'Which factor matters most when choosing {topic}?', o:['Price','Quality','Convenience','Brand reputation'] },
  { q:'How likely are you to recommend {topic} to a friend?', o:['Very likely','Somewhat likely','Neutral','Unlikely'] },
  { q:'How did you first hear about {topic}?', o:['Social media','Friends/family','Ads','Search engine'] },
  { q:'What is your preferred payment method?', o:['M‑Pesa','Card','Bank transfer','Cash'] },
  { q:'Which best describes your employment status?', o:['Employed full‑time','Self‑employed','Student','Unemployed'] },
  { q:'How much do you typically spend monthly on {topic}?', o:['Under KES 1,000','KES 1,000–5,000','KES 5,000–20,000','Over KES 20,000'] },
  { q:'How important is {topic} to your daily life?', o:['Very important','Somewhat important','Not very important','Not at all'] },
  { q:'Which feature of {topic} do you use most?', o:['Mobile app','Website','In‑person','None of these'] },
  { q:'Would you pay more for a premium version of {topic}?', o:['Definitely','Probably','Probably not','Definitely not'] },
  { q:'How would you improve {topic}?', o:['Lower prices','Better quality','Faster service','More features'] },
  { q:'Which region are you located in?', o:['Nairobi','Coast','Rift Valley','Western/Eastern'] },
  { q:'How many people in your household use {topic}?', o:['Just me','2–3','4–5','6+'] },
  { q:'How satisfied are you with the price of {topic}?', o:['Very satisfied','Satisfied','Neutral','Not satisfied'] },
  { q:'What is your gender?', o:['Male','Female','Prefer not to say','Other'] },
  { q:'How long have you used {topic}?', o:['Less than 6 months','6–12 months','1–3 years','Over 3 years'] },
  { q:'Which device do you primarily use for {topic}?', o:['Smartphone','Laptop/PC','Tablet','Other'] },
  { q:'How would you describe your income level?', o:['Low','Lower middle','Upper middle','High'] }
];
function generateQuestions(task) {
  const seed = Number(task.id) || 1;
  const count = Math.min(20, Math.max(10, Number(task.questions) || 12));
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = (seed * 7 + i * 13) % QT.length;
    const tpl = QT[idx];
    out.push({ n: i+1, question: tpl.q.replace(/{topic}/g, (task.category||'this').toLowerCase()), options: tpl.o });
  }
  return out;
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function normalizePhone(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (p.startsWith('7') && p.length === 9) p = '254' + p;
  else if (p.startsWith('1') && p.length === 9) p = '254' + p;
  return p;
}
function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e||'').trim()); }
function isValidKenyanPhone(p) { return /^254(7|1)\d{8}$/.test(p); }
function isStrongPassword(pw) { return typeof pw === 'string' && pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw); }
function isSubscriptionActive(u) {
  if (!u) return false;
  if (u.subscriptionTier === 'free') return true;
  if (!u.subscriptionExpiry) return false;
  return new Date(u.subscriptionExpiry) > new Date();
}
function dailyLimit(u) {
  if (u.subscriptionTier === 'free') return TIERS.free.dailyLimit;
  if (!isSubscriptionActive(u)) return 0;
  return TIERS[u.subscriptionTier]?.dailyLimit || 0;
}
function startOfToday() { const d = new Date(); d.setHours(0,0,0,0); return d; }
function resetDailyTasks(u) {
  const today = new Date().toISOString().slice(0, 10);
  if (u.lastTaskDate !== today) { u.tasksCompletedToday = 0; u.lastTaskDate = today; return true; }
  return false;
}
function publicUser(u) {
  const active = isSubscriptionActive(u);
  const limit = dailyLimit(u);
  const done = u.tasksCompletedToday || 0;
  return {
    id: u._id, username: u.username, email: u.email, phone: u.phone,
    subscriptionTier: u.subscriptionTier, subscriptionActive: active,
    subscriptionExpiry: u.subscriptionExpiry, dailyLimit: limit,
    tasksCompletedToday: done, tasksRemaining: Math.max(0, limit - done),
    balance: u.balance || 0, totalEarnings: u.totalEarnings || 0
  };
}
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try { const p = jwt.verify(h.split(' ')[1], JWT_SECRET); req.userId = p.userId; next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ✨ NEW: Admin auth middleware
function adminAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Admin token required' });
  try {
    const p = jwt.verify(h.split(' ')[1], JWT_SECRET);
    if (!p.admin) return res.status(403).json({ error: 'Not an admin token' });
    req.admin = true; next();
  } catch { return res.status(401).json({ error: 'Invalid admin token' }); }
}

// ─── ✨ NEW: VISIT TRACKING MIDDLEWARE ─────────────────────────────────────
// Only track page loads (not API calls, not assets)
app.use((req, res, next) => {
  const isPage =
    req.method === 'GET' &&
    !req.path.startsWith('/api/') &&
    !req.path.startsWith('/socket.io') &&
    !/\.(js|css|png|jpg|jpeg|svg|ico|webp|woff2?|ttf|map)$/i.test(req.path);
  if (!isPage) return next();

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  const ua = req.headers['user-agent'] || '';
  const ref = req.headers['referer'] || req.headers['referrer'] || '';

  // Fire and forget
  visitsCol.insertOne({
    ip, path: req.path, ua, referrer: ref,
    country: req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || null,
    method: req.method,
    createdAt: new Date()
  }).catch(() => {});

  next();
});

// ─── STATIC + ADMIN PANEL ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── ROUTES (all existing ones unchanged) ─────────────────────────────────
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, confirmPassword, phone } = req.body || {};
    if (!username || !email || !password || !phone) return res.status(400).json({ error: 'All fields are required' });
    if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match' });
    if (!isStrongPassword(password)) return res.status(400).json({ error: 'Password must be 8+ characters with uppercase, lowercase, and a number' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email address' });
    const normalizedPhone = normalizePhone(phone);
    if (!isValidKenyanPhone(normalizedPhone)) return res.status(400).json({ error: 'Enter a valid Kenyan M‑Pesa number' });

    const cleanUsername = String(username).trim();
    const cleanEmail = String(email).trim().toLowerCase();
    const existing = await usersCol.findOne({ $or: [{ email: cleanEmail }, { username: cleanUsername }] });
    if (existing) return res.status(409).json({ error: 'Email or username already taken' });

    const hashed = await bcrypt.hash(password, 10);
    const today = new Date().toISOString().slice(0, 10);
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    const user = {
      username: cleanUsername, email: cleanEmail, phone: normalizedPhone,
      password: hashed, subscriptionTier: 'free', subscriptionExpiry: null,
      tasksCompletedToday: 0, lastTaskDate: today, balance: 0, totalEarnings: 0,
      signupIp: ip, signupUa: req.headers['user-agent'] || '',
      createdAt: new Date()
    };
    const result = await usersCol.insertOne(user);
    const token = jwt.sign({ userId: String(result.insertedId) }, JWT_SECRET, { expiresIn: '7d' });
    user._id = result.insertedId;
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) { console.error('Register error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/login', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  const ua = req.headers['user-agent'] || '';
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const user = await usersCol.findOne({ email: String(email).trim().toLowerCase() });
    if (!user) {
      await loginAttemptsCol.insertOne({ email: String(email).trim().toLowerCase(), ip, ua, success: false, reason: 'User not found', createdAt: new Date() });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      await loginAttemptsCol.insertOne({ email: user.email, userId: user._id, ip, ua, success: false, reason: 'Wrong password', createdAt: new Date() });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await loginAttemptsCol.insertOne({ email: user.email, userId: user._id, ip, ua, success: true, createdAt: new Date() });
    await usersCol.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date(), lastLoginIp: ip } });

    if (resetDailyTasks(user)) {
      await usersCol.updateOne({ _id: user._id }, { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } });
    }
    const token = jwt.sign({ userId: String(user._id) }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: publicUser(user) });
  } catch (err) { console.error('Login error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (resetDailyTasks(user)) await usersCol.updateOne({ _id: user._id }, { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } });
    res.json(publicUser(user));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/tasks', auth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (resetDailyTasks(user)) await usersCol.updateOne({ _id: user._id }, { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(100, parseInt(req.query.size) || 50);
    const type = req.query.type;
    const filter = {};
    if (type === 'survey' || type === 'task') filter.type = type;

    const totalCount = await tasksCol.countDocuments(filter);
    const tasks = await tasksCol.find(filter).sort({ id: 1 }).skip((page-1)*size).limit(size).toArray();
    const todayHistory = await historyCol.find({ userId: user._id, completedAt: { $gte: startOfToday() } }).project({ taskId: 1 }).toArray();
    const completedIds = new Set(todayHistory.map(h => h.taskId));

    const limit = dailyLimit(user);
    const done = user.tasksCompletedToday || 0;
    const remaining = Math.max(0, limit - done);
    let unlockSlots = remaining;
    const shaped = tasks.map(t => {
      let status = 'locked';
      if (completedIds.has(t.id)) status = 'completed';
      else if (unlockSlots > 0) { status = 'unlocked'; unlockSlots--; }
      return {
        id: t.id, type: t.type, title: t.title, description: t.description,
        category: t.category, country: t.country,
        reward: user.subscriptionTier === 'free' && status !== 'locked' ? FREE_TASK_REWARD : t.reward,
        time: t.time, questions: t.questions, difficulty: t.difficulty,
        owner: t.owner, status
      };
    });
    res.json({
      tier: user.subscriptionTier, dailyLimit: limit, tasksCompletedToday: done,
      tasksRemaining: remaining, page, size, totalCount, tasks: shaped
    });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/tasks/:id', auth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const task = await tasksCol.findOne({ id: Number(req.params.id) });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (resetDailyTasks(user)) await usersCol.updateOne({ _id: user._id }, { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } });
    const completedToday = await historyCol.findOne({ userId: user._id, taskId: task.id, completedAt: { $gte: startOfToday() } });
    if (completedToday) return res.status(409).json({ error: 'Task already completed today' });
    const limit = dailyLimit(user);
    const done = user.tasksCompletedToday || 0;
    if (done >= limit) return res.status(403).json({ error: 'Daily limit reached' });
    const questions = generateQuestions(task);
    const reward = user.subscriptionTier === 'free' ? FREE_TASK_REWARD : task.reward;
    res.json({ task: { id: task.id, type: task.type, title: task.title, description: task.description, category: task.category, country: task.country, time: task.time, difficulty: task.difficulty, owner: task.owner, reward }, questions });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/tasks/:id/complete', auth, async (req, res) => {
  try {
    const { answers } = req.body || {};
    if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers array is required' });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (resetDailyTasks(user)) await usersCol.updateOne({ _id: user._id }, { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } });
    const limit = dailyLimit(user);
    const done = user.tasksCompletedToday || 0;
    if (done >= limit) return res.status(429).json({ error: 'Daily limit reached' });
    const task = await tasksCol.findOne({ id: Number(req.params.id) });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const reward = user.subscriptionTier === 'free' ? FREE_TASK_REWARD : task.reward;
    await usersCol.updateOne({ _id: user._id }, { $inc: { tasksCompletedToday: 1, balance: reward, totalEarnings: reward } });
    await historyCol.insertOne({ userId: user._id, taskId: task.id, taskTitle: task.title, taskType: task.type, taskCategory: task.category, owner: task.owner, reward, answersCount: answers.length, answers, completedAt: new Date() });
    await walletCol.insertOne({ userId: user._id, type: 'task_reward', amount: reward, status: 'completed', reference: `task_${task.id}_${Date.now()}`, taskTitle: task.title, createdAt: new Date() });
    res.json({ message: `Task completed! You earned KES ${reward}`, reward, tasksCompletedToday: done + 1, tasksRemaining: Math.max(0, limit - (done + 1)) });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/history', auth, async (req, res) => {
  try {
    const entries = await historyCol.find({ userId: new ObjectId(req.userId) }).sort({ completedAt: -1 }).limit(100).toArray();
    res.json(entries.map(e => ({ id: e._id, taskId: e.taskId, taskTitle: e.taskTitle, taskType: e.taskType, taskCategory: e.taskCategory, owner: e.owner, reward: e.reward, answersCount: e.answersCount, completedAt: e.completedAt })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/subscribe', auth, async (req, res) => {
  try {
    const { tier } = req.body || {};
    if (!TIERS[tier] || tier === 'free') return res.status(400).json({ error: 'Invalid tier' });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const amount = TIERS[tier].price;
    const reference = `sub_${user._id}_${tier}_${Date.now()}`;
    await txnsCol.insertOne({ userId: user._id, tier, amount, reference, phone: user.phone, status: 'pending', kind: 'subscription', createdAt: new Date() });
    const payload = { api_key: process.env.PAYHERO_API_KEY, username: process.env.PAYHERO_USERNAME, amount, phone: user.phone, user_reference: reference, callback_url: PAYHERO_CALLBACK_URL };
    const { data } = await axios.post(PAYHERO_API_URL, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
    await txnsCol.updateOne({ reference }, { $set: { payheroResponse: data } });
    res.json({ message: 'STK push sent. Check your phone.', reference, amount, tier });
  } catch (err) { console.error('Subscribe error:', err.response?.data || err.message); res.status(500).json({ error: 'Payment initiation failed' }); }
});

app.post('/api/wallet/deposit', auth, async (req, res) => {
  try {
    const amount = Number(req.body?.amount) || 0;
    if (amount < MIN_DEPOSIT) return res.status(400).json({ error: `Minimum deposit is KES ${MIN_DEPOSIT}` });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const reference = `dep_${user._id}_${Date.now()}`;
    await txnsCol.insertOne({ userId: user._id, amount, reference, phone: user.phone, status: 'pending', kind: 'deposit', createdAt: new Date() });
    const payload = { api_key: process.env.PAYHERO_API_KEY, username: process.env.PAYHERO_USERNAME, amount, phone: user.phone, user_reference: reference, callback_url: PAYHERO_CALLBACK_URL };
    const { data } = await axios.post(PAYHERO_API_URL, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
    await txnsCol.updateOne({ reference }, { $set: { payheroResponse: data } });
    res.json({ message: `STK push sent. Approve KES ${amount}.`, reference, amount });
  } catch (err) { res.status(500).json({ error: 'Deposit initiation failed' }); }
});

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  try {
    const amount = Number(req.body?.amount) || 0;
    if (amount < MIN_WITHDRAWAL) return res.status(400).json({ error: `Minimum withdrawal is KES ${MIN_WITHDRAWAL}` });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if ((user.balance || 0) < amount) return res.status(400).json({ error: 'Insufficient balance' });
    const upd = await usersCol.updateOne({ _id: user._id, balance: { $gte: amount } }, { $inc: { balance: -amount } });
    if (upd.modifiedCount === 0) return res.status(400).json({ error: 'Insufficient balance' });
    await walletCol.insertOne({ userId: user._id, type: 'withdrawal', amount: -amount, phone: user.phone, status: 'processing', reference: `wd_${user._id}_${Date.now()}`, createdAt: new Date() });
    res.json({ message: `Withdrawal of KES ${amount} requested.`, amount, phone: user.phone });
  } catch (err) { res.status(500).json({ error: 'Withdrawal failed' }); }
});

app.get('/api/wallet/history', auth, async (req, res) => {
  try {
    const items = await walletCol.find({ userId: new ObjectId(req.userId) }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json(items);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/payhero/callback', async (req, res) => {
  try {
    const body = req.body || {};
    const resp = body.response || body;
    const userRef = resp.User_Reference || resp.user_reference || resp.reference || body.reference;
    const amountRaw = resp.Amount ?? resp.amount ?? body.amount ?? 0;
    const mpesaRef = resp.MPESA_Reference || resp.mpesa_reference || resp.MpesaReceiptNumber || null;
    if (!userRef) return res.status(400).json({ error: 'Missing User_Reference' });
    const parts = String(userRef).split('_');
    const prefix = parts[0];
    const txn = await txnsCol.findOne({ reference: userRef });
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    if (txn.status === 'completed') return res.json({ message: 'Already processed' });
    const amountNum = Number(amountRaw) || 0;
    const userId = String(txn.userId);
    if (prefix === 'sub') {
      const tier = parts[2];
      if (!TIERS[tier] || tier === 'free') return res.status(400).json({ error: 'Invalid tier' });
      if (amountNum && amountNum < TIERS[tier].price) {
        await txnsCol.updateOne({ _id: txn._id }, { $set: { status: 'failed', reason: 'Amount mismatch' } });
        return res.status(400).json({ error: 'Amount mismatch' });
      }
      const user = await usersCol.findOne({ _id: new ObjectId(userId) });
      if (!user) return res.status(404).json({ error: 'User not found' });
      const base = isSubscriptionActive(user) && user.subscriptionTier === tier ? new Date(user.subscriptionExpiry) : new Date();
      const expiry = new Date(base); expiry.setDate(expiry.getDate() + SUBSCRIPTION_DAYS);
      await usersCol.updateOne({ _id: user._id }, { $set: { subscriptionTier: tier, subscriptionExpiry: expiry, tasksCompletedToday: 0, lastTaskDate: new Date().toISOString().slice(0, 10) } });
    }
    if (prefix === 'dep') {
      if (amountNum && amountNum < MIN_DEPOSIT) {
        await txnsCol.updateOne({ _id: txn._id }, { $set: { status: 'failed', reason: 'Below minimum' } });
        return res.status(400).json({ error: 'Below minimum' });
      }
      await usersCol.updateOne({ _id: new ObjectId(userId) }, { $inc: { balance: amountNum } });
      await walletCol.insertOne({ userId: new ObjectId(userId), type: 'deposit', amount: amountNum, phone: txn.phone, status: 'completed', reference: userRef, mpesaRef, createdAt: new Date() });
    }
    await txnsCol.updateOne({ _id: txn._id }, { $set: { status: 'completed', mpesaRef, completedAt: new Date() } });
    res.json({ message: 'Processed' });
  } catch (err) { console.error('Callback error:', err); res.status(200).json({ message: 'Received' }); }
});

app.get('/api/tiers', (req, res) => {
  const out = {};
  for (const [k, v] of Object.entries(TIERS)) out[k] = { name: v.name, price: v.price, dailyLimit: v.dailyLimit, label: v.label, days: SUBSCRIPTION_DAYS };
  res.json(out);
});

// ═══════════════════════════════════════════════════════════════════════════
// ✨ ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/admin/login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
      await loginAttemptsCol.insertOne({ email: `admin:${username}`, ip, ua: req.headers['user-agent']||'', success: false, reason: 'Bad admin credentials', createdAt: new Date() });
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/admin/stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = startOfToday();
    const weekAgo = new Date(Date.now() - 7 * 86400000);

    const [
      totalUsers, newUsersToday, newUsersWeek,
      activeSubs, classicCount, premiumCount, goldenCount,
      totalVisits, visitsToday, uniqueVisitorsToday,
      loginSuccess, loginFail,
      txnsAll, txnsCompleted, txnsFailed, txnsPending,
      tasksCompletedAll
    ] = await Promise.all([
      usersCol.countDocuments({}),
      usersCol.countDocuments({ createdAt: { $gte: todayStart } }),
      usersCol.countDocuments({ createdAt: { $gte: weekAgo } }),
      usersCol.countDocuments({ subscriptionTier: { $ne: 'free' }, subscriptionExpiry: { $gt: now } }),
      usersCol.countDocuments({ subscriptionTier: 'classic', subscriptionExpiry: { $gt: now } }),
      usersCol.countDocuments({ subscriptionTier: 'premium', subscriptionExpiry: { $gt: now } }),
      usersCol.countDocuments({ subscriptionTier: 'golden',  subscriptionExpiry: { $gt: now } }),
      visitsCol.countDocuments({}),
      visitsCol.countDocuments({ createdAt: { $gte: todayStart } }),
      visitsCol.distinct('ip', { createdAt: { $gte: todayStart } }).then(a => a.length),
      loginAttemptsCol.countDocuments({ success: true }),
      loginAttemptsCol.countDocuments({ success: false }),
      txnsCol.countDocuments({}),
      txnsCol.countDocuments({ status: 'completed' }),
      txnsCol.countDocuments({ status: 'failed' }),
      txnsCol.countDocuments({ status: 'pending' }),
      historyCol.countDocuments({})
    ]);

    // Revenue = sum of completed subscription transactions
    const revAgg = await txnsCol.aggregate([
      { $match: { status: 'completed', kind: 'subscription' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const totalRevenue = revAgg[0]?.total || 0;

    const revTodayAgg = await txnsCol.aggregate([
      { $match: { status: 'completed', kind: 'subscription', completedAt: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const revenueToday = revTodayAgg[0]?.total || 0;

    const depAgg = await txnsCol.aggregate([
      { $match: { status: 'completed', kind: 'deposit' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const totalDeposits = depAgg[0]?.total || 0;

    const totalPayoutsAgg = await walletCol.aggregate([
      { $match: { type: 'task_reward' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const totalPayouts = totalPayoutsAgg[0]?.total || 0;

    res.json({
      users: { total: totalUsers, today: newUsersToday, week: newUsersWeek },
      subscriptions: { active: activeSubs, classic: classicCount, premium: premiumCount, golden: goldenCount },
      visits: { total: totalVisits, today: visitsToday, uniqueToday: uniqueVisitorsToday },
      logins: { success: loginSuccess, failed: loginFail },
      transactions: { total: txnsAll, completed: txnsCompleted, failed: txnsFailed, pending: txnsPending },
      revenue: { total: totalRevenue, today: revenueToday, deposits: totalDeposits, payouts: totalPayouts },
      tasksCompleted: tasksCompletedAll
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/admin/users?page=1&size=50&q=search
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(200, parseInt(req.query.size) || 50);
    const q = String(req.query.q || '').trim();
    const filter = {};
    if (q) filter.$or = [
      { username: { $regex: q, $options: 'i' } },
      { email: { $regex: q, $options: 'i' } },
      { phone: { $regex: q, $options: 'i' } }
    ];
    const total = await usersCol.countDocuments(filter);
    const users = await usersCol.find(filter, { projection: { password: 0 } })
      .sort({ createdAt: -1 }).skip((page-1)*size).limit(size).toArray();
    const now = new Date();
    res.json({
      total, page, size,
      users: users.map(u => {
        const active = u.subscriptionTier !== 'free' && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > now;
        return {
          id: u._id, username: u.username, email: u.email, phone: u.phone,
          subscriptionTier: u.subscriptionTier || 'free',
          subscriptionActive: !!active,
          subscriptionExpiry: u.subscriptionExpiry,
          balance: u.balance || 0,
          totalEarnings: u.totalEarnings || 0,
          tasksCompletedToday: u.tasksCompletedToday || 0,
          lastLoginAt: u.lastLoginAt,
          lastLoginIp: u.lastLoginIp,
          signupIp: u.signupIp,
          createdAt: u.createdAt
        };
      })
    });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/admin/transactions?status=completed|failed|pending&kind=subscription|deposit
app.get('/api/admin/transactions', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(200, parseInt(req.query.size) || 50);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.kind) filter.kind = req.query.kind;

    const total = await txnsCol.countDocuments(filter);
    const txns = await txnsCol.find(filter).sort({ createdAt: -1 }).skip((page-1)*size).limit(size).toArray();

    // Enrich with user info
    const userIds = [...new Set(txns.map(t => String(t.userId)))].map(id => new ObjectId(id));
    const users = await usersCol.find({ _id: { $in: userIds } }, { projection: { username: 1, email: 1, phone: 1 } }).toArray();
    const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));

    res.json({
      total, page, size,
      transactions: txns.map(t => ({
        id: t._id,
        reference: t.reference,
        kind: t.kind || 'subscription',
        tier: t.tier || null,
        amount: t.amount,
        phone: t.phone,
        status: t.status,
        reason: t.reason || null,
        mpesaRef: t.mpesaRef || null,
        createdAt: t.createdAt,
        completedAt: t.completedAt || null,
        user: userMap[String(t.userId)] || { username: '—', email: '—' }
      }))
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/admin/visits
app.get('/api/admin/visits', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(200, parseInt(req.query.size) || 50);
    const total = await visitsCol.countDocuments({});
    const visits = await visitsCol.find({}).sort({ createdAt: -1 }).skip((page-1)*size).limit(size).toArray();
    res.json({ total, page, size, visits });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/admin/login-attempts?success=true|false
app.get('/api/admin/login-attempts', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(200, parseInt(req.query.size) || 50);
    const filter = {};
    if (req.query.success === 'true')  filter.success = true;
    if (req.query.success === 'false') filter.success = false;
    const total = await loginAttemptsCol.countDocuments(filter);
    const attempts = await loginAttemptsCol.find(filter).sort({ createdAt: -1 }).skip((page-1)*size).limit(size).toArray();
    res.json({ total, page, size, attempts });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/admin/subscriptions — only active paid users
app.get('/api/admin/subscriptions', adminAuth, async (req, res) => {
  try {
    const now = new Date();
    const subs = await usersCol
      .find({ subscriptionTier: { $ne: 'free' }, subscriptionExpiry: { $gt: now } },
            { projection: { password: 0 } })
      .sort({ subscriptionExpiry: 1 })
      .toArray();
    res.json(subs.map(u => ({
      id: u._id, username: u.username, email: u.email, phone: u.phone,
      tier: u.subscriptionTier, expiry: u.subscriptionExpiry,
      daysLeft: Math.ceil((new Date(u.subscriptionExpiry) - now) / 86400000)
    })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ─── FALLBACK ──────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── START ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    await connectDB();
    app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}\n   Admin: /admin`));
  } catch (err) { console.error('❌ Failed to start:', err); process.exit(1); }
})();
