require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const PAYHERO_BASIC_AUTH_TOKEN = process.env.PAYHERO_BASIC_AUTH_TOKEN?.trim();
const PAYHERO_CHANNEL_ID = parseInt(process.env.PAYHERO_CHANNEL_ID, 10);
const PAYHERO_BASE_URL = 'https://backend.payhero.co.ke/api/v2';
const PAYHERO_CALLBACK_URL = process.env.PAYHERO_CALLBACK_URL || '';

if (!PAYHERO_BASIC_AUTH_TOKEN) console.warn('⚠️  PAYHERO_BASIC_AUTH_TOKEN not set');
if (!PAYHERO_CHANNEL_ID)       console.warn('⚠️  PAYHERO_CHANNEL_ID not set');
if (!PAYHERO_CALLBACK_URL)     console.warn('⚠️  PAYHERO_CALLBACK_URL not set');

const TIERS = {
  free:    { name:'Free',    dailyLimit:2,  price:0,   label:'2 free tasks / day' },
  classic: { name:'Classic', dailyLimit:10, price:200, label:'10 tasks / day' },
  premium: { name:'Premium', dailyLimit:20, price:350, label:'20 tasks / day' },
  golden:  { name:'Golden',  dailyLimit:50, price:450, label:'50+ tasks / day' }
};
const SUBSCRIPTION_DAYS = 7;
const FREE_TASK_REWARD = 21;
const MIN_DEPOSIT = 50;
const MIN_WITHDRAWAL = 200;
const ACTIVATION_FEE = 499;
const PAYMENT_TIMEOUT_MS = 5 * 60 * 1000;
const SEED_VERSION = 3;

let tierPrices = { classic: 200, premium: 350, golden: 450 };

function getTierPrice(tier) {
  if (tier === 'free') return 0;
  return tierPrices[tier] ?? TIERS[tier]?.price ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// MONGODB
// ═══════════════════════════════════════════════════════════════════════════
let db, usersCol, txnsCol, tasksCol, walletCol, historyCol, metaCol,
    visitsCol, loginAttemptsCol, settingsCol, ticketsCol;

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
  visitsCol        = db.collection('site_visits');
  loginAttemptsCol = db.collection('login_attempts');
  settingsCol      = db.collection('settings');
  ticketsCol       = db.collection('support_tickets');

  await usersCol.createIndex({ email: 1 }, { unique: true });
  await usersCol.createIndex({ username: 1 }, { unique: true });
  await txnsCol.createIndex({ reference: 1 }, { unique: true });
  await walletCol.createIndex({ userId: 1, createdAt: -1 });
  await walletCol.createIndex({ status: 1, type: 1 });
  await historyCol.createIndex({ userId: 1, completedAt: -1 });
  await tasksCol.createIndex({ id: 1 }, { unique: true });
  await visitsCol.createIndex({ createdAt: -1 });
  await loginAttemptsCol.createIndex({ createdAt: -1 });
  await ticketsCol.createIndex({ userId: 1, createdAt: -1 });

  await seedTasks();
  await loadTierPrices();
  console.log('✅ MongoDB connected');
}

async function loadTierPrices() {
  const doc = await settingsCol.findOne({ key: 'tier_prices' });
  if (doc) {
    tierPrices = {
      classic: Number(doc.classic) || 200,
      premium: Number(doc.premium) || 350,
      golden:  Number(doc.golden)  || 450
    };
  } else {
    await settingsCol.insertOne({
      key: 'tier_prices',
      classic: 200, premium: 350, golden: 450,
      updatedAt: new Date()
    });
  }
  console.log('💵 Tier prices loaded:', tierPrices);
}

// ═══════════════════════════════════════════════════════════════════════════
// SEED
// ═══════════════════════════════════════════════════════════════════════════
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
  return t[category] || `Help understand ${category.toLowerCase()} in ${country}.`;
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
    tasks.push({ id: id++, type:'survey', title, category:topic, country,
      description: descFor(title, topic, country), reward: 21 + ((i * 7) % 40),
      time: `${3 + (i % 5)} min`, questions: 10 + (i % 11),
      difficulty: ['easy','medium','hard'][i % 3], owner, createdAt: new Date() });
  }
  for (let i = 0; i < 1000; i++) {
    const title = TASK_TITLES[i % TASK_TITLES.length];
    const owner = ownerFor(i + 500);
    tasks.push({ id: id++, type:'task', title: `${title} #${i + 1}`,
      category:'Micro‑task', country: owner.country,
      description: `${title}. Quick, focused work that takes a few minutes.`,
      reward: 21 + ((i * 5) % 35), time: `${2 + (i % 6)} min`,
      questions: 10 + (i % 6), difficulty: ['easy','medium','hard'][i % 3],
      owner, createdAt: new Date() });
  }
  await tasksCol.insertMany(tasks);
  await metaCol.updateOne({ key:'task_seed_version' }, { $set:{ version:SEED_VERSION, updatedAt:new Date() } }, { upsert:true });
  console.log(`✅ Seeded ${tasks.length} tasks`);
}

// ═══════════════════════════════════════════════════════════════════════════
// QUESTIONS
// ═══════════════════════════════════════════════════════════════════════════
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
    out.push({ n:i+1, question: tpl.q.replace(/{topic}/g, (task.category||'this').toLowerCase()), options: tpl.o });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function normalizePhone(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('254')) return p;
  if (p.startsWith('0')) return '254' + p.slice(1);
  if ((p.startsWith('7') || p.startsWith('1')) && p.length === 9) return '254' + p;
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
  const today = new Date().toISOString().slice(0,10);
  if (u.lastTaskDate !== today) { u.tasksCompletedToday = 0; u.lastTaskDate = today; return true; }
  return false;
}
async function autoFailStalePayments() {
  const cutoff = new Date(Date.now() - PAYMENT_TIMEOUT_MS);
  await txnsCol.updateMany(
    { status: 'pending', createdAt: { $lt: cutoff }, mpesaRef: { $in: [null, undefined, ''] } },
    { $set: { status: 'failed', reason: 'No M‑Pesa response (timeout)' } }
  );
}
function publicUser(u) {
  const active = isSubscriptionActive(u);
  const limit = dailyLimit(u);
  const done = u.tasksCompletedToday || 0;
  return {
    id: u._id,
    username: u.username,
    email: u.email,
    phone: u.phone,
    subscriptionTier: u.subscriptionTier,
    subscriptionActive: active,
    subscriptionExpiry: u.subscriptionExpiry,
    dailyLimit: limit,
    tasksCompletedToday: done,
    tasksRemaining: Math.max(0, limit - done),
    balance: u.balance || 0,
    pendingBalance: u.pendingBalance || 0,
    totalEarnings: u.totalEarnings || 0,
    activationFeePaid: u.activationFeePaid === true,
    accountStatus: u.accountStatus || 'active',
    twoFactorEnabled: u.twoFactorEnabled === true,
    hasWithdrawalPin: !!u.withdrawalPin,
    country: u.country || 'Kenya',
    county: u.county || null
  };
}
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try { const p = jwt.verify(h.split(' ')[1], JWT_SECRET); req.userId = p.userId; next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}
function adminAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Admin token required' });
  try {
    const p = jwt.verify(h.split(' ')[1], JWT_SECRET);
    if (!p.admin) return res.status(403).json({ error: 'Not an admin token' });
    req.admin = true; next();
  } catch { return res.status(401).json({ error: 'Invalid admin token' }); }
}

// ═══════════════════════════════════════════════════════════════════════════
// PAYHERO
// ═══════════════════════════════════════════════════════════════════════════
function payheroAuthHeader() {
  const t = PAYHERO_BASIC_AUTH_TOKEN || '';
  return t.startsWith('Basic ') ? t : `Basic ${t}`;
}
async function sendPayHeroStk({ amount, phone, reference }) {
  if (!PAYHERO_BASIC_AUTH_TOKEN) return { ok: false, data: null, message: 'PayHero token not configured' };
  if (!PAYHERO_CHANNEL_ID)       return { ok: false, data: null, message: 'PayHero channel not configured' };
  if (!PAYHERO_CALLBACK_URL)     return { ok: false, data: null, message: 'PayHero callback URL not configured' };
  const payload = {
    amount: Number(amount),
    phone_number: phone,
    channel_id: PAYHERO_CHANNEL_ID,
    provider: 'm-pesa',
    external_reference: reference,
    callback_url: PAYHERO_CALLBACK_URL
  };
  try {
    const r = await axios.post(`${PAYHERO_BASE_URL}/payments`, payload, {
      headers: { 'Content-Type': 'application/json', 'Authorization': payheroAuthHeader() },
      timeout: 30000, validateStatus: () => true
    });
    const ok = r.status >= 200 && r.status < 300 && (r.data?.success === true || r.data?.status === true);
    if (!ok) {
      console.error('❌ PayHero STK failed:', r.status, JSON.stringify(r.data));
      return { ok: false, data: r.data, message: r.data?.message || r.data?.error || `STK push rejected (HTTP ${r.status})` };
    }
    console.log(`✅ PayHero STK sent → ${phone} • KES ${amount} • ref ${reference}`);
    return { ok: true, data: r.data, message: 'STK push sent' };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('❌ PayHero STK error:', msg);
    return { ok: false, data: err.response?.data || null, message: msg };
  }
}
function mapPayHeroFailureReason(resultCode, resultDesc) {
  const code = String(resultCode);
  const map = {
    '1':'Insufficient funds in your M‑Pesa account',
    '1001':'You have another M‑Pesa transaction in progress. Please wait and try again',
    '1019':'Transaction expired — no PIN entered in time',
    '1032':'You cancelled the payment prompt on your phone',
    '1037':'No response from your phone. Keep your phone on and try again',
    '1050':'Not enough money in your M‑Pesa account',
    '2001':'You entered the wrong M‑Pesa PIN',
    '2002':'M‑Pesa PIN could not be verified. Please try again',
    '9999':'M‑Pesa service is temporarily unavailable. Please try again later'
  };
  return map[code] || resultDesc || `Transaction failed (code ${code})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// VISIT TRACKING
// ═══════════════════════════════════════════════════════════════════════════
app.use((req, res, next) => {
  const isPage = req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/socket.io')
    && !/\.(js|css|png|jpg|jpeg|svg|ico|webp|woff2?|ttf|map)$/i.test(req.path);
  if (!isPage) return next();
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  const ua = req.headers['user-agent'] || '';
  const ref = req.headers['referer'] || req.headers['referrer'] || '';
  visitsCol.insertOne({ ip, path: req.path, ua, referrer: ref,
    country: req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || null,
    method: req.method, createdAt: new Date()
  }).catch(() => {});
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════════════════
// USER ROUTES
// ═══════════════════════════════════════════════════════════════════════════
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/api/prices', (req, res) => res.json(tierPrices));

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
      tasksCompletedToday: 0, lastTaskDate: today,
      balance: 0, pendingBalance: 0, totalEarnings: 0,
      activationFeePaid: false,
      withdrawalPin: null,
      accountStatus: 'active',
      statusReason: null,
      twoFactorEnabled: false,
      country: 'Kenya',
      county: null,
      language: 'en',
      signupIp: ip, signupUa: req.headers['user-agent'] || '', createdAt: new Date()
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
    if (resetDailyTasks(user)) await usersCol.updateOne({ _id: user._id }, { $set: { tasksCompletedToday: 0, lastTaskDate: user.lastTaskDate } });
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

// ═══════════════════════════════════════════════════════════════════════════
// USER SETTINGS ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════
app.put('/api/user/profile', auth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { username, email, phone } = req.body || {};
    const updates = {};
    if (username && username !== user.username) {
      const clean = String(username).trim();
      if (clean.length < 3) return res.status(400).json({ error: 'Username must be 3+ characters' });
      const exists = await usersCol.findOne({ username: clean, _id: { $ne: user._id } });
      if (exists) return res.status(409).json({ error: 'Username already taken' });
      updates.username = clean;
    }
    if (email && email !== user.email) {
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
      const clean = String(email).trim().toLowerCase();
      const exists = await usersCol.findOne({ email: clean, _id: { $ne: user._id } });
      if (exists) return res.status(409).json({ error: 'Email already in use' });
      updates.email = clean;
    }
    if (phone) {
      const normalized = normalizePhone(phone);
      if (!isValidKenyanPhone(normalized)) return res.status(400).json({ error: 'Invalid M‑Pesa number' });
      if (normalized !== user.phone) {
        const exists = await usersCol.findOne({ phone: normalized, _id: { $ne: user._id } });
        if (exists) return res.status(409).json({ error: 'Phone already in use' });
        updates.phone = normalized;
      }
    }
    if (Object.keys(updates).length === 0) return res.json({ ok: true, user: publicUser(user) });
    updates.profileUpdatedAt = new Date();
    await usersCol.updateOne({ _id: user._id }, { $set: updates });
    const updated = await usersCol.findOne({ _id: user._id });
    res.json({ ok: true, user: publicUser(updated) });
  } catch (err) { console.error('Profile update error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/user/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (!isStrongPassword(newPassword)) return res.status(400).json({ error: 'New password must be 8+ chars with uppercase, lowercase, and a number' });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await usersCol.updateOne({ _id: user._id }, { $set: { password: hashed, passwordChangedAt: new Date() } });
    res.json({ ok: true, message: 'Password changed successfully' });
  } catch (err) { console.error('Change password error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/user/withdrawal-pin', auth, async (req, res) => {
  try {
    const { pin, password } = req.body || {};
    if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4 to 6 digits' });
    if (!password) return res.status(400).json({ error: 'Account password required' });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    const pinHash = await bcrypt.hash(String(pin), 10);
    await usersCol.updateOne({ _id: user._id }, { $set: { withdrawalPin: pinHash, pinSetAt: new Date() } });
    res.json({ ok: true, message: 'Withdrawal PIN set' });
  } catch (err) { console.error('Withdrawal PIN error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/user/2fa', auth, async (req, res) => {
  try {
    const { enabled } = req.body || {};
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    await usersCol.updateOne({ _id: user._id }, { $set: { twoFactorEnabled: !!enabled } });
    res.json({ ok: true, twoFactorEnabled: !!enabled });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/user/deactivate', auth, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password required' });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    await usersCol.updateOne({ _id: user._id }, { $set: { accountStatus: 'deactivated', deactivatedAt: new Date() } });
    res.json({ ok: true, message: 'Account deactivated' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/user/delete', auth, async (req, res) => {
  try {
    const { password, confirm } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password required' });
    if (confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    await usersCol.updateOne({ _id: user._id }, {
      $set: {
        username: `deleted_${user._id}`,
        email: `deleted_${user._id}@deleted.local`,
        phone: null,
        password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
        accountStatus: 'deleted',
        deletedAt: new Date(),
        balance: 0,
        pendingBalance: 0
      }
    });
    res.json({ ok: true, message: 'Account deleted' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/user/login-history', auth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const attempts = await loginAttemptsCol
      .find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();
    res.json(attempts.map(a => ({ ip: a.ip, ua: a.ua, success: a.success, at: a.createdAt })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SUPPORT TICKETS
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/support/ticket', auth, async (req, res) => {
  try {
    const { category, subject, message } = req.body || {};
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ticketNumber = `JP-${Date.now().toString().slice(-6)}`;
    const doc = {
      ticketNumber, userId: user._id, username: user.username,
      category: category || 'general', subject, message,
      status: 'open', replies: [], createdAt: new Date()
    };
    const r = await ticketsCol.insertOne(doc);
    res.status(201).json({ ok: true, ticket: { ...doc, _id: r.insertedId } });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/support/tickets', auth, async (req, res) => {
  try {
    const items = await ticketsCol
      .find({ userId: new ObjectId(req.userId) })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    res.json(items);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════════
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
    res.json({ tier: user.subscriptionTier, dailyLimit: limit, tasksCompletedToday: done,
      tasksRemaining: remaining, page, size, totalCount, tasks: shaped });
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
    const wTxn = {
      userId: user._id, type: 'task_reward', amount: reward, status: 'pending',
      reference: `task_${task.id}_${Date.now()}`, taskId: task.id, taskTitle: task.title,
      taskType: task.type, taskCategory: task.category, owner: task.owner,
      answersCount: answers.length, createdAt: new Date()
    };
    const wRes = await walletCol.insertOne(wTxn);
    await usersCol.updateOne({ _id: user._id }, { $inc: { tasksCompletedToday: 1, pendingBalance: reward, totalEarnings: reward } });
    await historyCol.insertOne({
      userId: user._id, taskId: task.id, taskTitle: task.title,
      taskType: task.type, taskCategory: task.category, owner: task.owner,
      reward, answersCount: answers.length, answers,
      walletTxnId: wRes.insertedId, status: 'pending', completedAt: new Date()
    });
    res.json({ message: `Task complete! KES ${reward} is pending admin confirmation.`, reward, status: 'pending', tasksCompletedToday: done + 1, tasksRemaining: Math.max(0, limit - (done + 1)) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/history', auth, async (req, res) => {
  try {
    const entries = await historyCol.find({ userId: new ObjectId(req.userId) }).sort({ completedAt: -1 }).limit(100).toArray();
    res.json(entries.map(e => ({
      id: e._id, taskId: e.taskId, taskTitle: e.taskTitle,
      taskType: e.taskType, taskCategory: e.taskCategory, owner: e.owner,
      reward: e.reward, answersCount: e.answersCount,
      status: e.status || 'completed', reason: e.reason || null, completedAt: e.completedAt
    })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SUBSCRIBE
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/subscribe', auth, async (req, res) => {
  try {
    const { tier, phone: phoneInput } = req.body || {};
    if (!TIERS[tier] || tier === 'free') return res.status(400).json({ error: 'Invalid tier' });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const phone = normalizePhone(phoneInput || user.phone);
    if (!isValidKenyanPhone(phone)) return res.status(400).json({ error: 'Enter a valid M‑Pesa number (e.g. 0712345678)' });
    const amount = getTierPrice(tier);
    const reference = `sub_${user._id}_${tier}_${Date.now()}`;
    await txnsCol.insertOne({ userId: user._id, tier, amount, reference, phone, status: 'pending', kind: 'subscription', createdAt: new Date() });
    const stk = await sendPayHeroStk({ amount, phone, reference });
    if (!stk.ok) {
      await txnsCol.updateOne({ reference }, { $set: { status: 'failed', reason: stk.message, payheroResponse: stk.data } });
      return res.status(400).json({ error: stk.message });
    }
    await txnsCol.updateOne({ reference }, { $set: { payheroResponse: stk.data } });
    res.json({ message: `STK push sent to ${phone}. Enter your M‑Pesa PIN to complete payment.`, reference, amount, tier, phone });
  } catch (err) { console.error('Subscribe error:', err.response?.data || err.message); res.status(500).json({ error: 'Payment initiation failed' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// DEPOSIT / ACTIVATION / WITHDRAW
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/wallet/deposit', auth, async (req, res) => {
  try {
    const amount = Number(req.body?.amount) || 0;
    const phoneInput = req.body?.phone;
    if (amount < MIN_DEPOSIT) return res.status(400).json({ error: `Minimum deposit is KES ${MIN_DEPOSIT}` });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const phone = normalizePhone(phoneInput || user.phone);
    if (!isValidKenyanPhone(phone)) return res.status(400).json({ error: 'Enter a valid M‑Pesa number' });
    const reference = `dep_${user._id}_${Date.now()}`;
    await txnsCol.insertOne({ userId: user._id, amount, reference, phone, status: 'pending', kind: 'deposit', createdAt: new Date() });
    const stk = await sendPayHeroStk({ amount, phone, reference });
    if (!stk.ok) {
      await txnsCol.updateOne({ reference }, { $set: { status: 'failed', reason: stk.message, payheroResponse: stk.data } });
      return res.status(400).json({ error: stk.message });
    }
    await txnsCol.updateOne({ reference }, { $set: { payheroResponse: stk.data } });
    res.json({ message: `STK push sent to ${phone}. Approve KES ${amount} on your phone.`, reference, amount, phone });
  } catch (err) { console.error('Deposit error:', err.response?.data || err.message); res.status(500).json({ error: 'Deposit initiation failed' }); }
});

app.post('/api/wallet/pay-activation', auth, async (req, res) => {
  try {
    const phoneInput = req.body?.phone;
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.activationFeePaid === true) return res.status(400).json({ error: 'Activation fee already paid' });
    const phone = normalizePhone(phoneInput || user.phone);
    if (!isValidKenyanPhone(phone)) return res.status(400).json({ error: 'Enter a valid M‑Pesa number' });
    const amount = ACTIVATION_FEE;
    const reference = `act_${user._id}_${Date.now()}`;
    await txnsCol.insertOne({ userId: user._id, amount, reference, phone, status: 'pending', kind: 'activation', createdAt: new Date() });
    const stk = await sendPayHeroStk({ amount, phone, reference });
    if (!stk.ok) {
      await txnsCol.updateOne({ reference }, { $set: { status: 'failed', reason: stk.message, payheroResponse: stk.data } });
      return res.status(400).json({ error: stk.message });
    }
    await txnsCol.updateOne({ reference }, { $set: { payheroResponse: stk.data } });
    res.json({ message: `STK push sent to ${phone}. Pay KES ${amount} to activate your account.`, reference, amount, phone });
  } catch (err) { console.error('Activation error:', err.response?.data || err.message); res.status(500).json({ error: 'Activation initiation failed' }); }
});

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  try {
    const amount = Number(req.body?.amount) || 0;
    const pin = req.body?.pin;
    if (amount < MIN_WITHDRAWAL) return res.status(400).json({ error: `Minimum withdrawal is KES ${MIN_WITHDRAWAL}` });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.activationFeePaid !== true) {
      return res.status(403).json({ error: 'ACTIVATION_REQUIRED', message: `Pay a one-time KES ${ACTIVATION_FEE} activation fee before your first withdrawal.`, amount: ACTIVATION_FEE });
    }
    if (user.withdrawalPin) {
      if (!pin) return res.status(400).json({ error: 'Withdrawal PIN required' });
      const pinOk = await bcrypt.compare(String(pin), user.withdrawalPin);
      if (!pinOk) return res.status(401).json({ error: 'Incorrect withdrawal PIN' });
    }
    if ((user.balance || 0) < amount) return res.status(400).json({ error: 'Insufficient balance' });
    const upd = await usersCol.updateOne({ _id: user._id, balance: { $gte: amount } }, { $inc: { balance: -amount } });
    if (upd.modifiedCount === 0) return res.status(400).json({ error: 'Insufficient balance' });
    await walletCol.insertOne({
      userId: user._id, type: 'withdrawal', amount: -amount,
      phone: user.phone, status: 'pending',
      reference: `wd_${user._id}_${Date.now()}`, createdAt: new Date()
    });
    res.json({ message: `Withdrawal of KES ${amount} requested. Admin will process it.`, amount, phone: user.phone });
  } catch (err) { res.status(500).json({ error: 'Withdrawal failed' }); }
});

app.get('/api/wallet/history', auth, async (req, res) => {
  try {
    await autoFailStalePayments();
    const userId = new ObjectId(req.userId);
    const walletTransactions = await walletCol.find({ userId }).sort({ createdAt: -1 }).limit(50).toArray();
    const paymentTransactions = await txnsCol.find({ userId }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json({
      walletTransactions: walletTransactions.map(w => ({
        id: w._id, type: w.type, amount: w.amount, status: w.status,
        reference: w.reference, taskTitle: w.taskTitle, owner: w.owner,
        reason: w.reason || null, phone: w.phone,
        createdAt: w.createdAt, confirmedAt: w.confirmedAt || null
      })),
      paymentTransactions: paymentTransactions.map(p => ({
        id: p._id, kind: p.kind || 'subscription', tier: p.tier || null,
        amount: p.amount, status: p.status, phone: p.phone,
        reference: p.reference, mpesaRef: p.mpesaRef || null,
        reason: p.reason || null,
        createdAt: p.createdAt, completedAt: p.completedAt || null
      }))
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PAYHERO CALLBACK
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/payhero/callback', async (req, res) => {
  try {
    console.log('📬 PayHero callback (raw):', JSON.stringify(req.body, null, 2));
    const body = req.body || {};
    const resp = body.response || body || {};
    const reference =
      body.external_reference || body.externalReference ||
      resp.external_reference || resp.externalReference ||
      body.User_Reference || body.user_reference ||
      resp.User_Reference || resp.user_reference ||
      body.reference || resp.reference ||
      body.ExternalReference || resp.ExternalReference ||
      body.account_reference || resp.account_reference;
    const mpesaRef =
      body.MpesaReceiptNumber || resp.MpesaReceiptNumber ||
      body.mpesa_receipt || resp.mpesa_receipt ||
      body.MpesaReceipt || resp.MpesaReceipt ||
      body.MPESA_Reference || resp.MPESA_Reference ||
      body.receipt || resp.receipt ||
      body.TransactionReceipt || resp.TransactionReceipt;
    const resultCodeRaw =
      body.ResultCode ?? body.result_code ?? body.response_code ?? body.ResponseCode ??
      resp.ResultCode ?? resp.result_code ?? resp.response_code ?? resp.ResponseCode;
    const resultDesc =
      body.ResultDesc || body.result_desc || body.ResponseDescription ||
      resp.ResultDesc || resp.result_desc || resp.ResponseDescription || null;
    const statusRaw = body.Status || body.status || resp.Status || resp.status;
    const hasReceipt = !!(mpesaRef && String(mpesaRef).trim().length > 3);
    const resultCodeOk = resultCodeRaw === 0 || resultCodeRaw === '0';
    const statusOk = /^(success|completed|complete|paid)$/i.test(String(statusRaw || '').trim());
    const boolOk = body.success === true || resp.success === true || body.paid === true || resp.paid === true;
    const isSuccess = hasReceipt || resultCodeOk || statusOk || boolOk;
    const statusFail = /^(fail|failed|error|cancelled|canceled|rejected|timeout)$/i.test(String(statusRaw || '').trim());
    const isExplicitFailure = !isSuccess && (statusFail || (resultCodeRaw !== undefined && !resultCodeOk));
    console.log('🔎 Parsed →', { reference, mpesaRef, resultCodeRaw, resultDesc, statusRaw, hasReceipt, resultCodeOk, statusOk, boolOk, isSuccess, isExplicitFailure });
    if (!reference) return res.status(200).json({ status: 'received' });
    const txn = await txnsCol.findOne({ reference });
    if (!txn) return res.status(200).json({ status: 'received' });
    if (txn.status === 'completed') return res.status(200).json({ status: 'already-processed' });
    if (isExplicitFailure && !isSuccess) {
      const reason = mapPayHeroFailureReason(resultCodeRaw, resultDesc);
      await txnsCol.updateOne({ _id: txn._id }, { $set: { status: 'failed', reason, callback: body, completedAt: new Date() } });
      return res.status(200).json({ status: 'received' });
    }
    if (!isSuccess) {
      await txnsCol.updateOne({ _id: txn._id }, { $set: { lastCallback: body, lastCallbackAt: new Date() } });
      return res.status(200).json({ status: 'received' });
    }
    const prefix = String(reference).split('_')[0];
    const userId = String(txn.userId);
    if (prefix === 'sub') {
      const tier = txn.tier;
      if (!TIERS[tier]) {
        await txnsCol.updateOne({ _id: txn._id }, { $set: { status: 'failed', reason: 'Invalid tier on callback' } });
        return res.status(200).json({ status: 'received' });
      }
      const user = await usersCol.findOne({ _id: new ObjectId(userId) });
      if (!user) {
        await txnsCol.updateOne({ _id: txn._id }, { $set: { status: 'failed', reason: 'User not found' } });
        return res.status(200).json({ status: 'received' });
      }
      const base = isSubscriptionActive(user) && user.subscriptionTier === tier ? new Date(user.subscriptionExpiry) : new Date();
      const expiry = new Date(base); expiry.setDate(expiry.getDate() + SUBSCRIPTION_DAYS);
      await usersCol.updateOne({ _id: user._id }, { $set: { subscriptionTier: tier, subscriptionExpiry: expiry, tasksCompletedToday: 0, lastTaskDate: new Date().toISOString().slice(0, 10) } });
    } else if (prefix === 'dep') {
      const amount = Number(txn.amount) || 0;
      await usersCol.updateOne({ _id: new ObjectId(userId) }, { $inc: { balance: amount } });
      await walletCol.insertOne({ userId: new ObjectId(userId), type: 'deposit', amount, phone: txn.phone, status: 'completed', reference, mpesaRef, createdAt: new Date(), confirmedAt: new Date() });
    } else if (prefix === 'act') {
      await usersCol.updateOne({ _id: new ObjectId(userId) }, { $set: { activationFeePaid: true, activationPaidAt: new Date() } });
      await walletCol.insertOne({ userId: new ObjectId(userId), type: 'activation_fee', amount: -ACTIVATION_FEE, phone: txn.phone, status: 'completed', reference, mpesaRef, createdAt: new Date(), confirmedAt: new Date() });
    }
    await txnsCol.updateOne({ _id: txn._id }, { $set: { status: 'completed', mpesaRef, callback: body, completedAt: new Date() } });
    res.status(200).json({ status: 'received' });
  } catch (err) { console.error('Callback error:', err); res.status(200).json({ status: 'received' }); }
});

app.get('/api/tiers', (req, res) => {
  const out = {};
  for (const [k, v] of Object.entries(TIERS)) {
    out[k] = { name: v.name, price: getTierPrice(k), dailyLimit: v.dailyLimit, label: v.label, days: SUBSCRIPTION_DAYS };
  }
  res.json(out);
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
      await loginAttemptsCol.insertOne({ email:`admin:${username}`, ip, ua:req.headers['user-agent']||'', success:false, reason:'Bad admin credentials', createdAt:new Date() });
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    await autoFailStalePayments();
    const now = new Date();
    const todayStart = startOfToday();
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const [
      totalUsers, newUsersToday, newUsersWeek,
      activeSubs, classicCount, premiumCount, goldenCount,
      totalVisits, visitsToday, uniqueVisitorsToday,
      loginSuccess, loginFail,
      txnsAll, txnsCompleted, txnsFailed, txnsPending,
      tasksCompletedAll, pendingRewardsCount, pendingWithdrawalsCount, activationsCount
    ] = await Promise.all([
      usersCol.countDocuments({}),
      usersCol.countDocuments({ createdAt: { $gte: todayStart } }),
      usersCol.countDocuments({ createdAt: { $gte: weekAgo } }),
      usersCol.countDocuments({ subscriptionTier: { $ne:'free' }, subscriptionExpiry: { $gt: now } }),
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
      historyCol.countDocuments({}),
      walletCol.countDocuments({ type:'task_reward', status:'pending' }),
      walletCol.countDocuments({ type:'withdrawal', status:'pending' }),
      txnsCol.countDocuments({ kind: 'activation', status: 'completed' })
    ]);
    const revAgg = await txnsCol.aggregate([{ $match: { status:'completed', kind:'subscription' } }, { $group: { _id: null, total: { $sum:'$amount' } } }]).toArray();
    const revTodayAgg = await txnsCol.aggregate([{ $match: { status:'completed', kind:'subscription', completedAt: { $gte: todayStart } } }, { $group: { _id: null, total: { $sum:'$amount' } } }]).toArray();
    const depAgg = await txnsCol.aggregate([{ $match: { status:'completed', kind:'deposit' } }, { $group: { _id: null, total: { $sum:'$amount' } } }]).toArray();
    const actAgg = await txnsCol.aggregate([{ $match: { status:'completed', kind:'activation' } }, { $group: { _id: null, total: { $sum:'$amount' } } }]).toArray();
    const payoutsAgg = await walletCol.aggregate([{ $match: { type:'task_reward', status:'completed' } }, { $group: { _id: null, total: { $sum:'$amount' } } }]).toArray();
    const pendingRewardsAgg = await walletCol.aggregate([{ $match: { type:'task_reward', status:'pending' } }, { $group: { _id: null, total: { $sum:'$amount' } } }]).toArray();
    res.json({
      users: { total: totalUsers, today: newUsersToday, week: newUsersWeek },
      subscriptions: { active: activeSubs, classic: classicCount, premium: premiumCount, golden: goldenCount },
      visits: { total: totalVisits, today: visitsToday, uniqueToday: uniqueVisitorsToday },
      logins: { success: loginSuccess, failed: loginFail },
      transactions: { total: txnsAll, completed: txnsCompleted, failed: txnsFailed, pending: txnsPending },
      revenue: {
        total: revAgg[0]?.total || 0, today: revTodayAgg[0]?.total || 0,
        deposits: depAgg[0]?.total || 0, activations: actAgg[0]?.total || 0,
        payouts: payoutsAgg[0]?.total || 0
      },
      tasksCompleted: tasksCompletedAll,
      pending: {
        rewards: pendingRewardsCount, rewardsAmount: pendingRewardsAgg[0]?.total || 0,
        withdrawals: pendingWithdrawalsCount, activations: activationsCount
      }
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

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
    const users = await usersCol.find(filter, { projection: { password: 0 } }).sort({ createdAt: -1 }).skip((page-1)*size).limit(size).toArray();
    const now = new Date();
    res.json({
      total, page, size,
      users: users.map(u => {
        const active = u.subscriptionTier !== 'free' && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > now;
        return {
          id: u._id, username: u.username, email: u.email, phone: u.phone,
          subscriptionTier: u.subscriptionTier || 'free',
          subscriptionActive: !!active, subscriptionExpiry: u.subscriptionExpiry,
          balance: u.balance || 0, pendingBalance: u.pendingBalance || 0, totalEarnings: u.totalEarnings || 0,
          activationFeePaid: u.activationFeePaid === true,
          tasksCompletedToday: u.tasksCompletedToday || 0,
          lastLoginAt: u.lastLoginAt, lastLoginIp: u.lastLoginIp,
          signupIp: u.signupIp, createdAt: u.createdAt
        };
      })
    });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/transactions', adminAuth, async (req, res) => {
  try {
    await autoFailStalePayments();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(200, parseInt(req.query.size) || 50);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.kind) filter.kind = req.query.kind;
    const total = await txnsCol.countDocuments(filter);
    const txns = await txnsCol.find(filter).sort({ createdAt: -1 }).skip((page-1)*size).limit(size).toArray();
    const userIds = [...new Set(txns.map(t => String(t.userId)))].map(id => new ObjectId(id));
    const users = await usersCol.find({ _id: { $in: userIds } }, { projection: { username:1, email:1, phone:1 } }).toArray();
    const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));
    res.json({
      total, page, size,
      transactions: txns.map(t => ({
        id: t._id, reference: t.reference, kind: t.kind || 'subscription',
        tier: t.tier || null, amount: t.amount, phone: t.phone,
        status: t.status, reason: t.reason || null, mpesaRef: t.mpesaRef || null,
        createdAt: t.createdAt, completedAt: t.completedAt || null,
        user: userMap[String(t.userId)] || { username:'—', email:'—' }
      }))
    });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/transactions/:id/mark-paid', adminAuth, async (req, res) => {
  try {
    const txn = await txnsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    if (txn.status === 'completed') return res.status(400).json({ error: 'Already completed' });
    const userId = String(txn.userId);
    const prefix = String(txn.reference).split('_')[0];
    if (prefix === 'sub') {
      const user = await usersCol.findOne({ _id: new ObjectId(userId) });
      if (!user) return res.status(404).json({ error: 'User not found' });
      const tier = txn.tier;
      if (!TIERS[tier]) return res.status(400).json({ error: 'Invalid tier' });
      const base = isSubscriptionActive(user) && user.subscriptionTier === tier ? new Date(user.subscriptionExpiry) : new Date();
      const expiry = new Date(base); expiry.setDate(expiry.getDate() + SUBSCRIPTION_DAYS);
      await usersCol.updateOne({ _id: user._id }, { $set: { subscriptionTier: tier, subscriptionExpiry: expiry, tasksCompletedToday: 0, lastTaskDate: new Date().toISOString().slice(0, 10) } });
    } else if (prefix === 'dep') {
      const amount = Number(txn.amount) || 0;
      await usersCol.updateOne({ _id: new ObjectId(userId) }, { $inc: { balance: amount } });
      await walletCol.insertOne({ userId: new ObjectId(userId), type: 'deposit', amount, phone: txn.phone, status: 'completed', reference: txn.reference, mpesaRef: txn.mpesaRef || null, createdAt: new Date(), confirmedAt: new Date() });
    } else if (prefix === 'act') {
      await usersCol.updateOne({ _id: new ObjectId(userId) }, { $set: { activationFeePaid: true, activationPaidAt: new Date() } });
      await walletCol.insertOne({ userId: new ObjectId(userId), type: 'activation_fee', amount: -ACTIVATION_FEE, phone: txn.phone, status: 'completed', reference: txn.reference, mpesaRef: txn.mpesaRef || null, createdAt: new Date(), confirmedAt: new Date() });
    }
    await txnsCol.updateOne({ _id: txn._id }, { $set: { status: 'completed', reason: 'Manually marked as paid by admin', manualOverrideAt: new Date(), manualOverrideBy: 'admin' } });
    res.json({ ok: true });
  } catch (err) { console.error('Mark-paid error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/visits', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(200, parseInt(req.query.size) || 50);
    const total = await visitsCol.countDocuments({});
    const visits = await visitsCol.find({}).sort({ createdAt: -1 }).skip((page-1)*size).limit(size).toArray();
    res.json({ total, page, size, visits });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

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

app.get('/api/admin/subscriptions', adminAuth, async (req, res) => {
  try {
    const now = new Date();
    const subs = await usersCol.find({ subscriptionTier: { $ne:'free' }, subscriptionExpiry: { $gt: now } }, { projection: { password:0 } }).sort({ subscriptionExpiry: 1 }).toArray();
    res.json(subs.map(u => ({
      id: u._id, username: u.username, email: u.email, phone: u.phone,
      tier: u.subscriptionTier, expiry: u.subscriptionExpiry,
      daysLeft: Math.ceil((new Date(u.subscriptionExpiry) - now) / 86400000)
    })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/pending-rewards', adminAuth, async (req, res) => {
  try {
    const items = await walletCol.find({ type:'task_reward', status:'pending' }).sort({ createdAt: -1 }).limit(300).toArray();
    const userIds = [...new Set(items.map(t => String(t.userId)))].map(id => new ObjectId(id));
    const users = await usersCol.find({ _id: { $in: userIds } }, { projection: { username:1, email:1, phone:1 } }).toArray();
    const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));
    res.json({
      total: items.length,
      totalAmount: items.reduce((s, t) => s + t.amount, 0),
      items: items.map(t => ({
        id: t._id, amount: t.amount, taskTitle: t.taskTitle, taskType: t.taskType,
        taskCategory: t.taskCategory, owner: t.owner, answersCount: t.answersCount,
        createdAt: t.createdAt,
        user: userMap[String(t.userId)] || { username:'—', email:'—' }
      }))
    });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/wallet/confirm/:id', adminAuth, async (req, res) => {
  try {
    const txn = await walletCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    if (txn.status !== 'pending') return res.status(400).json({ error: 'Not pending' });
    await usersCol.updateOne({ _id: txn.userId }, { $inc: { pendingBalance: -txn.amount, balance: txn.amount } });
    await walletCol.updateOne({ _id: txn._id }, { $set: { status:'completed', confirmedAt: new Date() } });
    await historyCol.updateOne({ walletTxnId: txn._id }, { $set: { status:'completed', confirmedAt: new Date() } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/wallet/reject/:id', adminAuth, async (req, res) => {
  try {
    const txn = await walletCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    if (txn.status !== 'pending') return res.status(400).json({ error: 'Not pending' });
    const reason = req.body?.reason || 'Rejected by admin';
    await usersCol.updateOne({ _id: txn.userId }, { $inc: { pendingBalance: -txn.amount, totalEarnings: -txn.amount } });
    await walletCol.updateOne({ _id: txn._id }, { $set: { status:'failed', reason, rejectedAt: new Date() } });
    await historyCol.updateOne({ walletTxnId: txn._id }, { $set: { status:'failed', reason, rejectedAt: new Date() } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/wallet/confirm-all', adminAuth, async (req, res) => {
  try {
    const items = await walletCol.find({ type:'task_reward', status:'pending' }).toArray();
    const byUser = {};
    for (const t of items) {
      const k = String(t.userId);
      if (!byUser[k]) byUser[k] = { total: 0, ids: [] };
      byUser[k].total += t.amount;
      byUser[k].ids.push(t._id);
    }
    for (const [userId, data] of Object.entries(byUser)) {
      await usersCol.updateOne({ _id: new ObjectId(userId) }, { $inc: { pendingBalance: -data.total, balance: data.total } });
      await walletCol.updateMany({ _id: { $in: data.ids } }, { $set: { status:'completed', confirmedAt: new Date() } });
      await historyCol.updateMany({ walletTxnId: { $in: data.ids } }, { $set: { status:'completed', confirmedAt: new Date() } });
    }
    res.json({ ok: true, count: items.length });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/pending-withdrawals', adminAuth, async (req, res) => {
  try {
    const items = await walletCol.find({ type:'withdrawal', status:'pending' }).sort({ createdAt: -1 }).limit(300).toArray();
    const userIds = [...new Set(items.map(t => String(t.userId)))].map(id => new ObjectId(id));
    const users = await usersCol.find({ _id: { $in: userIds } }, { projection: { username:1, email:1, phone:1 } }).toArray();
    const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));
    res.json({
      total: items.length,
      totalAmount: items.reduce((s, t) => s + Math.abs(t.amount), 0),
      items: items.map(t => ({
        id: t._id, amount: Math.abs(t.amount), phone: t.phone,
        reference: t.reference, createdAt: t.createdAt,
        user: userMap[String(t.userId)] || { username:'—', email:'—' }
      }))
    });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/withdrawal/confirm/:id', adminAuth, async (req, res) => {
  try {
    const txn = await walletCol.findOne({ _id: new ObjectId(req.params.id), type:'withdrawal' });
    if (!txn) return res.status(404).json({ error: 'Not found' });
    if (txn.status !== 'pending') return res.status(400).json({ error: 'Not pending' });
    await walletCol.updateOne({ _id: txn._id }, { $set: { status:'completed', confirmedAt: new Date() } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/withdrawal/reject/:id', adminAuth, async (req, res) => {
  try {
    const txn = await walletCol.findOne({ _id: new ObjectId(req.params.id), type:'withdrawal' });
    if (!txn) return res.status(404).json({ error: 'Not found' });
    if (txn.status !== 'pending') return res.status(400).json({ error: 'Not pending' });
    const reason = req.body?.reason || 'Rejected by admin';
    await usersCol.updateOne({ _id: txn.userId }, { $inc: { balance: Math.abs(txn.amount) } });
    await walletCol.updateOne({ _id: txn._id }, { $set: { status:'failed', reason, rejectedAt: new Date() } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/settings/prices', adminAuth, (req, res) => res.json(tierPrices));

app.put('/api/admin/settings/prices', adminAuth, async (req, res) => {
  try {
    const { classic, premium, golden } = req.body || {};
    const c = Number(classic), p = Number(premium), g = Number(golden);
    if ([c, p, g].some(v => !Number.isFinite(v) || v < 1 || v > 1000000)) {
      return res.status(400).json({ error: 'Prices must be numbers between 1 and 1,000,000' });
    }
    tierPrices = { classic: c, premium: p, golden: g };
    await settingsCol.updateOne({ key: 'tier_prices' }, { $set: { ...tierPrices, updatedAt: new Date() } }, { upsert: true });
    console.log('💵 Tier prices updated by admin:', tierPrices);
    res.json({ ok: true, prices: tierPrices });
  } catch (err) { console.error('Update prices error:', err); res.status(500).json({ error: 'Server error' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: TICKETS
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/tickets', adminAuth, async (req, res) => {
  try {
    const items = await ticketsCol.find({}).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(items);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/tickets/:id/reply', adminAuth, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Message required' });
    await ticketsCol.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $push: { replies: { by: 'admin', message, at: new Date() } }, $set: { status: 'open', lastReplyAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/tickets/:id/close', adminAuth, async (req, res) => {
  try {
    await ticketsCol.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: 'resolved', closedAt: new Date() } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ═══════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`   Admin: /admin`);
      console.log(`   PayHero callback: ${PAYHERO_CALLBACK_URL || '(not set)'}`);
    });
  } catch (err) { console.error('❌ Failed to start:', err); process.exit(1); }
})();
