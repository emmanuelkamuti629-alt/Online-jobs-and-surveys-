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
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const PAYHERO_BASIC_AUTH_TOKEN = process.env.PAYHERO_BASIC_AUTH_TOKEN?.trim();
const PAYHERO_CHANNEL_ID = parseInt(process.env.PAYHERO_CHANNEL_ID, 10);
const PAYHERO_BASE_URL = 'https://backend.payhero.co.ke/api/v2';
const PAYHERO_CALLBACK_URL = process.env.PAYHERO_CALLBACK_URL || '';

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

let db, usersCol, txnsCol, tasksCol, walletCol, historyCol, metaCol,
    visitsCol, loginAttemptsCol, settingsCol, ticketsCol, notificationsCol;

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
  notificationsCol = db.collection('notifications');

  await usersCol.createIndex({ email: 1 }, { unique: true });
  await usersCol.createIndex({ username: 1 }, { unique: true });
  await txnsCol.createIndex({ reference: 1 }, { unique: true });
  await walletCol.createIndex({ userId: 1, createdAt: -1 });
  await historyCol.createIndex({ userId: 1, completedAt: -1 });
  await tasksCol.createIndex({ id: 1 }, { unique: true });
  await visitsCol.createIndex({ createdAt: -1 });
  await loginAttemptsCol.createIndex({ createdAt: -1 });
  await ticketsCol.createIndex({ userId: 1, createdAt: -1 });
  await notificationsCol.createIndex({ userId: 1, createdAt: -1 });
  await notificationsCol.createIndex({ userId: 1, read: 1 });

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
    await settingsCol.insertOne({ key: 'tier_prices', classic: 200, premium: 350, golden: 450, updatedAt: new Date() });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DAILY SEED LOGIC - Ensures new questions & tasks every 24 hours
// ═══════════════════════════════════════════════════════════════════════════
function getDailySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════
async function createNotification(userId, type, title, message, meta = {}) {
  try {
    await notificationsCol.insertOne({
      userId: new ObjectId(userId),
      type,
      title,
      message,
      meta,
      read: false,
      createdAt: new Date()
    });
  } catch (err) { console.error('Notification error:', err.message); }
}

// ═══════════════════════════════════════════════════════════════════════════
// SEED (Simulating scraping from various platforms)
// ═══════════════════════════════════════════════════════════════════════════
const OWNER_NAMES = ['Sarah M.','James K.','Grace W.','David O.','Amina H.','Peter N.','Lucy A.','Brian C.','Faith M.','Kevin R.','Njeri K.','Otieno J.','Wanjiku S.','Hassan A.','Esther M.','Mercy W.','Kimani T.','Achieng O.','Mwangi D.','Zawadi L.'];
const OWNER_AVATARS = ['👩‍💼','👨‍💼','🧑‍💻','👨‍🔬','👩‍🔬','🧑‍🎓','👨‍🏫','👩‍🏫','🧑‍🎨','👩‍💻','👨‍💻','🧑‍🔧','👨‍⚕️','👩‍⚕️','🧑‍🍳','🧑‍🌾','👩‍🎤','👨‍🎤','🧑‍🚀','👩‍✈️'];
const OWNER_COUNTRIES = ['Kenya','Kenya','Kenya','Uganda','Tanzania','Rwanda','Kenya'];
const AVATAR_COLORS = ['#43B02A','#2196F3','#F5A623','#E91E63','#9C27B0','#00BCD4','#FF5722','#795548','#3F51B5','#009688'];

// Simulating tasks scraped from Google, Social Media, etc.
const SURVEY_TOPICS = [
  'Google Review Verification', 'Instagram Engagement Survey', 'Facebook Ad Feedback', 
  'YouTube Video Tagging', 'TikTok Trend Analysis', 'Twitter/X Sentiment Study',
  'LinkedIn Professional Survey', 'WhatsApp Business Feedback', 'Google Maps Location Check',
  'Amazon Product Review Validation', 'Netflix Content Preference', 'Spotify Playlist Curation',
  'Uber Ride Experience', 'Airbnb Host Feedback', 'eBay Seller Rating', 
  'Shopify Store UX Test', 'Reddit Community Poll', 'Pinterest Board Categorization',
  'Snapchat Filter Feedback', 'Discord Server Moderation', 'Twitch Streamer Interaction'
];

const TASK_TITLES = [
  'Verify Google Business Listing', 'Check Website Search Ranking', 'Transcribe YouTube Short',
  'Label Instagram Reels', 'Rate Facebook Marketplace Item', 'Proofread Social Media Post',
  'Categorize TikTok Comments', 'Translate X/Twitter Post', 'Moderate Discord Chat',
  'Review LinkedIn Job Post', 'Test Mobile App UX', 'Compare Flight Prices',
  'Verify Hotel Reviews', 'Check E-commerce Prices', 'Validate News Article',
  'Tag Images for AI Training', 'Record Voice Sample for AI', 'Answer Quick Poll',
  'Map Local Business Location', 'Correct OCR Text from Receipt'
];

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
    'Google Review Verification':'Help verify the authenticity of Google Business reviews.',
    'Instagram Engagement Survey':'Share your thoughts on Instagram engagement.',
    'Facebook Ad Feedback':'Give feedback on Facebook ad campaigns.',
    'YouTube Video Tagging':'Tag videos correctly for AI training.',
    'TikTok Trend Analysis':'Analyze current TikTok trends.',
    'Twitter/X Sentiment Study':'Rate the sentiment of recent X/Twitter posts.',
    'LinkedIn Professional Survey':'Answer questions about professional networking.',
    'WhatsApp Business Feedback':'Share your experience with WhatsApp Business.',
    'Google Maps Location Check':'Verify if a location is accurate on Google Maps.',
    'Amazon Product Review Validation':'Help validate Amazon product reviews.',
    'Netflix Content Preference':'Tell us what you like to watch on Netflix.',
    'Spotify Playlist Curation':'Help categorize songs for Spotify playlists.',
    'Uber Ride Experience':'Rate your recent Uber ride experience.',
    'Airbnb Host Feedback':'Give feedback on your Airbnb stay.',
    'eBay Seller Rating':'Rate an eBay seller based on their profile.',
    'Shopify Store UX Test':'Test a Shopify store and give UX feedback.',
    'Reddit Community Poll':'Participate in a Reddit community poll.',
    'Pinterest Board Categorization':'Categorize images for Pinterest boards.',
    'Snapchat Filter Feedback':'Give feedback on a new Snapchat filter.',
    'Discord Server Moderation':'Help moderate a Discord server.',
    'Twitch Streamer Interaction':'Engage with a Twitch streamer\'s content.'
  };
  return t[category] || `Help understand ${category.toLowerCase()} in ${country}.`;
}

async function seedTasks() {
  const meta = await metaCol.findOne({ key: 'task_seed_version' });
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  
  // Auto-refresh logic: If the date has changed, re-seed tasks
  if (meta && meta.version === SEED_VERSION && meta.lastSeedDate === todayStr) {
    console.log('⏩ Tasks already seeded today. Skipping auto-refresh.');
    return;
  }

  console.log('🌱 Seeding/Refreshing tasks for today...');
  await tasksCol.deleteMany({});
  
  const tasks = []; let id = 1;
  for (let i = 0; i < 2000; i++) {
    const topic = SURVEY_TOPICS[i % SURVEY_TOPICS.length];
    const country = OWNER_COUNTRIES[i % OWNER_COUNTRIES.length];
    const owner = ownerFor(i);
    const title = `${topic} – ${country} #${i + 1}`;
    
    // Minimum reward 50, up to 150
    const reward = 50 + ((i * 7) % 100); 
    
    // Simulate tier labels (Free, Classic, Premium)
    const tier = ['free', 'classic', 'premium'][i % 3];
    
    tasks.push({ 
      id: id++, 
      type: i % 2 === 0 ? 'survey' : 'task', 
      title, 
      category: topic, 
      country,
      description: descFor(title, topic, country), 
      reward: reward,
      time: `${3 + (i % 7)} min`, 
      questions: 10 + (i % 11),
      difficulty: ['easy','medium','hard'][i % 3], 
      owner, 
      tier, 
      createdAt: new Date() 
    });
  }
  
  await tasksCol.insertMany(tasks);
  await metaCol.updateOne(
    { key:'task_seed_version' }, 
    { $set: { version: SEED_VERSION, lastSeedDate: todayStr, updatedAt: new Date() } }, 
    { upsert: true }
  );
  console.log(`✅ Seeded ${tasks.length} tasks for ${todayStr}`);
}

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

// UPDATED: Generates new unique questions every day using the daily seed
function generateQuestions(task) {
  const dailySeed = getDailySeed();
  const seed = (Number(task.id) || 1) + dailySeed; 
  const count = Math.min(20, Math.max(10, Number(task.questions) || 12));
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = (seed * 7 + i * 13) % QT.length;
    const tpl = QT[idx];
    out.push({ n:i+1, question: tpl.q.replace(/{topic}/g, (task.category||'this').toLowerCase()), options: tpl.o });
  }
  return out;
}

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

// ═══════════════════════════════════════════════════════════════════════════
// 24-HOUR ROLLING WINDOW RESET LOGIC
// ═══════════════════════════════════════════════════════════════════════════
function resetDailyTasks(u) {
  if (!u.lastTaskDate) {
    u.lastTaskDate = new Date(0).toISOString();
  }
  const now = Date.now();
  const lastReset = new Date(u.lastTaskDate).getTime();
  const cooldown = 24 * 60 * 60 * 1000;

  if (now - lastReset > cooldown) {
    u.tasksCompletedToday = 0;
    u.lastTaskDate = new Date().toISOString();
    return true;
  }
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
    county: u.county || null,
    photo: u.photo || null,
    lastTaskDate: u.lastTaskDate
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

function payheroAuthHeader() {
  const t = PAYHERO_BASIC_AUTH_TOKEN || '';
  return t.startsWith('Basic ') ? t : `Basic ${t}`;
}
async function sendPayHeroStk({ amount, phone, reference }) {
  if (!PAYHERO_BASIC_AUTH_TOKEN) return { ok: false, data: null, message: 'PayHero token not configured' };
  if (!PAYHERO_CHANNEL_ID)       return { ok: false, data: null, message: 'PayHero channel not configured' };
  if (!PAYHERO_CALLBACK_URL)     return { ok: false, data: null, message: 'PayHero callback URL not configured' };
  const payload = { amount: Number(amount), phone_number: phone, channel_id: PAYHERO_CHANNEL_ID, provider: 'm-pesa', external_reference: reference, callback_url: PAYHERO_CALLBACK_URL };
  try {
    const r = await axios.post(`${PAYHERO_BASE_URL}/payments`, payload, {
      headers: { 'Content-Type': 'application/json', 'Authorization': payheroAuthHeader() },
      timeout: 30000, validateStatus: () => true
    });
    const ok = r.status >= 200 && r.status < 300 && (r.data?.success === true || r.data?.status === true);
    if (!ok) return { ok: false, data: r.data, message: r.data?.message || r.data?.error || `STK push rejected (HTTP ${r.status})` };
    return { ok: true, data: r.data, message: 'STK push sent' };
  } catch (err) {
    return { ok: false, data: err.response?.data || null, message: err.response?.data?.message || err.message };
  }
}
function mapPayHeroFailureReason(resultCode, resultDesc) {
  const code = String(resultCode);
  const map = { '1':'Insufficient funds in your M‑Pesa account','1001':'Another M‑Pesa transaction in progress','1019':'Transaction expired — no PIN entered','1032':'You cancelled the payment prompt','1037':'No response from your phone','1050':'Not enough money in your M‑Pesa account','2001':'Wrong M‑Pesa PIN','2002':'M‑Pesa PIN could not be verified','9999':'M‑Pesa service temporarily unavailable' };
  return map[code] || resultDesc || `Transaction failed (code ${code})`;
}

app.use((req, res, next) => {
  const isPage = req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/socket.io')
    && !/\.(js|css|png|jpg|jpeg|svg|ico|webp|woff2?|ttf|map)$/i.test(req.path);
  if (!isPage) return next();
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  const ua = req.headers['user-agent'] || '';
  const ref = req.headers['referer'] || req.headers['referrer'] || '';
  visitsCol.insertOne({ ip, path: req.path, ua, referrer: ref,
    country: req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || null,
    method: req.method, createdAt: new Date() }).catch(() => {});
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

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
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    const user = {
      username: cleanUsername, email: cleanEmail, phone: normalizedPhone,
      password: hashed, subscriptionTier: 'free', subscriptionExpiry: null,
      tasksCompletedToday: 0, lastTaskDate: new Date(0).toISOString(),
      balance: 0, pendingBalance: 0, totalEarnings: 0,
      activationFeePaid: false, withdrawalPin: null,
      accountStatus: 'active', twoFactorEnabled: false,
      country: 'Kenya', county: null, language: 'en',
      signupIp: ip, signupUa: req.headers['user-agent'] || '', createdAt: new Date()
    };
    const result = await usersCol.insertOne(user);
    const token = jwt.sign({ userId: String(result.insertedId) }, JWT_SECRET, { expiresIn: '7d' });
    user._id = result.insertedId;
    await createNotification(result.insertedId, 'system', 'Welcome to JobPay 🎉', 'Your account is ready. Complete 2 free tasks today to start earning!');
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
    const device = /android/i.test(ua) ? 'Android' : /iphone|ipad/i.test(ua) ? 'iOS' : /windows/i.test(ua) ? 'Windows' : /mac/i.test(ua) ? 'Mac' : 'Unknown device';
    await createNotification(user._id, 'login', 'New login to your account', `We noticed a login from ${device} · IP ${ip}. If this wasn't you, secure your account immediately.`);
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
// NOTIFICATIONS ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const userId = new ObjectId(req.userId);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const items = await notificationsCol
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    const unread = await notificationsCol.countDocuments({ userId, read: false });
    res.json({
      unread,
      total: items.length,
      notifications: items.map(n => ({
        id: n._id,
        type: n.type,
        title: n.title,
        message: n.message,
        meta: n.meta || {},
        read: n.read === true,
        createdAt: n.createdAt
      }))
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/notifications/unread-count', auth, async (req, res) => {
  try {
    const unread = await notificationsCol.countDocuments({ userId: new ObjectId(req.userId), read: false });
    res.json({ unread });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/notifications/read-all', auth, async (req, res) => {
  try {
    await notificationsCol.updateMany(
      { userId: new ObjectId(req.userId), read: false },
      { $set: { read: true, readAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/notifications/:id/read', auth, async (req, res) => {
  try {
    await notificationsCol.updateOne(
      { _id: new ObjectId(req.params.id), userId: new ObjectId(req.userId) },
      { $set: { read: true, readAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/notifications', auth, async (req, res) => {
  try {
    await notificationsCol.deleteMany({ userId: new ObjectId(req.userId) });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// USER SETTINGS
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
    await createNotification(user._id, 'system', 'Profile updated', 'Your account details were successfully updated.');
    const updated = await usersCol.findOne({ _id: user._id });
    res.json({ ok: true, user: publicUser(updated) });
  } catch (err) { console.error('Profile update error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/user/photo', auth, async (req, res) => {
  try {
    const { photo } = req.body || {};
    if (!photo || typeof photo !== 'string') return res.status(400).json({ error: 'Photo data required' });
    if (!photo.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image format' });
    if (photo.length > 400000) return res.status(413).json({ error: 'Photo too large (max ~300KB).' });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    await usersCol.updateOne({ _id: user._id }, { $set: { photo, photoUpdatedAt: new Date() } });
    await createNotification(user._id, 'system', 'Profile photo updated', 'Your new profile photo is live.');
    res.json({ ok: true, photo });
  } catch (err) { console.error('Photo save error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/user/photo', auth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    await usersCol.updateOne({ _id: user._id }, { $unset: { photo: '' } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
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
    await createNotification(user._id, 'system', 'Password changed', 'Your password was successfully changed. If this wasn\'t you, contact support immediately.');
    res.json({ ok: true, message: 'Password changed successfully' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
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
    await createNotification(user._id, 'system', 'Withdrawal PIN set', 'Your withdrawal PIN has been set. Keep it safe.');
    res.json({ ok: true, message: 'Withdrawal PIN set' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/user/2fa', auth, async (req, res) => {
  try {
    const { enabled } = req.body || {};
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    await usersCol.updateOne({ _id: user._id }, { $set: { twoFactorEnabled: !!enabled } });
    await createNotification(user._id, 'system', enabled ? '2FA enabled' : '2FA disabled', enabled ? 'Your account is now protected with 2FA.' : 'Two-factor authentication has been disabled.');
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
        username: `deleted_${user._id}`, email: `deleted_${user._id}@deleted.local`,
        phone: null, password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
        accountStatus: 'deleted', deletedAt: new Date(), balance: 0, pendingBalance: 0, photo: null
      }
    });
    res.json({ ok: true, message: 'Account deleted' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/user/login-history', auth, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const attempts = await loginAttemptsCol.find({ userId: user._id }).sort({ createdAt: -1 }).limit(10).toArray();
    res.json(attempts.map(a => ({ ip: a.ip, ua: a.ua, success: a.success, at: a.createdAt })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/support/ticket', auth, async (req, res) => {
  try {
    const { category, subject, message } = req.body || {};
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ticketNumber = `JP-${Date.now().toString().slice(-6)}`;
    const doc = { ticketNumber, userId: user._id, username: user.username, category: category || 'general', subject, message, status: 'open', replies: [], createdAt: new Date() };
    const r = await ticketsCol.insertOne(doc);
    await createNotification(user._id, 'system', `Support ticket #${ticketNumber}`, 'Your ticket has been received. We\'ll get back to you shortly.');
    res.status(201).json({ ok: true, ticket: { ...doc, _id: r.insertedId } });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/support/tickets', auth, async (req, res) => {
  try {
    const items = await ticketsCol.find({ userId: new ObjectId(req.userId) }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json(items);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// TASKS ROUTE
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
    const dailySeed = getDailySeed();

    const tasks = await tasksCol.aggregate([
      { $match: filter },
      { $addFields: { dailyOrder: { $mod: [ { $add: ["$id", dailySeed] }, 10000 ] } } },
      { $sort: { dailyOrder: 1 } },
      { $skip: (page - 1) * size },
      { $limit: size }
    ]).toArray();

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
        owner: t.owner, status, tier: t.tier
      };
    });
    res.json({ tier: user.subscriptionTier, dailyLimit: limit, tasksCompletedToday: done, tasksRemaining: remaining, page, size, totalCount, tasks: shaped });
  } catch (err) { console.error('Fetch tasks error:', err); res.status(500).json({ error: 'Server error' }); }
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
    res.json({ task: { id: task.id, type: task.type, title: task.title, description: task.description, category: task.category, country: task.country, time: task.time, difficulty: task.difficulty, owner: task.owner, reward, tier: task.tier }, questions });
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
    
    await usersCol.updateOne(
      { _id: user._id },
      { $inc: { tasksCompletedToday: 1, pendingBalance: reward, totalEarnings: reward }, $set: { lastTaskDate: new Date().toISOString() } }
    );

    await historyCol.insertOne({
      userId: user._id, taskId: task.id, taskTitle: task.title,
      taskType: task.type, taskCategory: task.category, owner: task.owner,
      reward, answersCount: answers.length, answers,
      walletTxnId: wRes.insertedId, status: 'pending', completedAt: new Date()
    });
    await createNotification(user._id, 'task', '✅ Task submitted', `"${task.title}" was submitted successfully. KES ${reward} is pending admin approval.`, { taskId: task.id, reward });
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

app.post('/api/subscribe', auth, async (req, res) => {
  try {
    const { tier, phone: phoneInput } = req.body || {};
    if (!TIERS[tier] || tier === 'free') return res.status(400).json({ error: 'Invalid tier' });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const phone = normalizePhone(phoneInput || user.phone);
    if (!isValidKenyanPhone(phone)) return res.status(400).json({ error: 'Enter a valid M‑Pesa number' });
    const amount = getTierPrice(tier);
    const reference = `sub_${user._id}_${tier}_${Date.now()}`;
    await txnsCol.insertOne({ userId: user._id, tier, amount, reference, phone, status: 'pending', kind: 'subscription', createdAt: new Date() });
    const stk = await sendPayHeroStk({ amount, phone, reference });
    if (!stk.ok) {
      await txnsCol.updateOne({ reference }, { $set: { status: 'failed', reason: stk.message, payheroResponse: stk.data } });
      return res.status(400).json({ error: stk.message });
    }
    await txnsCol.updateOne({ reference }, { $set: { payheroResponse: stk.data } });
    res.json({ message: `STK push sent to ${phone}.`, reference, amount, tier, phone });
  } catch (err) { res.status(500).json({ error: 'Payment initiation failed' }); }
});

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
    res.json({ message: `STK push sent to ${phone}.`, reference, amount, phone });
  } catch (err) { res.status(500).json({ error: 'Deposit initiation failed' }); }
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
    res.json({ message: `STK push sent to ${phone}. Pay KES ${amount}.`, reference, amount, phone });
  } catch (err) { res.status(500).json({ error: 'Activation initiation failed' }); }
});

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  try {
    const amount = Number(req.body?.amount) || 0;
    const pin = req.body?.pin;
    if (amount < MIN_WITHDRAWAL) return res.status(400).json({ error: `Minimum withdrawal is KES ${MIN_WITHDRAWAL}` });
    const user = await usersCol.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.activationFeePaid !== true) {
      return res.status(403).json({ error: 'ACTIVATION_REQUIRED', message: `Pay a one-time KES ${ACTIVATION_FEE} activation fee first.`, amount: ACTIVATION_FEE });
    }
    if (user.withdrawalPin) {
      if (!pin) return res.status(400).json({ error: 'Withdrawal PIN required' });
      const pinOk = await bcrypt.compare(String(pin), user.withdrawalPin);
      if (!pinOk) return res.status(401).json({ error: 'Incorrect withdrawal PIN' });
    }
    if ((user.balance || 0) < amount) return res.status(400).json({ error: 'Insufficient funds. Please check your balance.' });
    const upd = await usersCol.updateOne({ _id: user._id, balance: { $gte: amount } }, { $inc: { balance: -amount } });
    if (upd.modifiedCount === 0) return res.status(400).json({ error: 'Insufficient funds. Please check your balance.' });
    await walletCol.insertOne({ userId: user._id, type: 'withdrawal', amount: -amount, phone: user.phone, status: 'pending', reference: `wd_${user._id}_${Date.now()}`, createdAt: new Date() });
    await createNotification(user._id, 'withdrawal', '💸 Withdrawal requested', `Your withdrawal of KES ${amount} has been submitted and is awaiting admin approval.`, { amount });
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
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/payhero/callback', async (req, res) => {
  try {
    console.log('📬 PayHero callback (raw):', JSON.stringify(req.body, null, 2));
    const body = req.body || {};
    const resp = body.response || body || {};
    const reference = body.external_reference || body.externalReference || resp.external_reference || resp.externalReference || body.User_Reference || body.user_reference || resp.User_Reference || resp.user_reference || body.reference || resp.reference || body.ExternalReference || resp.ExternalReference || body.account_reference || resp.account_reference;
    const mpesaRef = body.MpesaReceiptNumber || resp.MpesaReceiptNumber || body.mpesa_receipt || resp.mpesa_receipt || body.MpesaReceipt || resp.MpesaReceipt || body.MPESA_Reference || resp.MPESA_Reference || body.receipt || resp.receipt || body.TransactionReceipt || resp.TransactionReceipt;
    const resultCodeRaw = body.ResultCode ?? body.result_code ?? body.response_code ?? body.ResponseCode ?? resp.ResultCode ?? resp.result_code ?? resp.response_code ?? resp.ResponseCode;
    const resultDesc = body.ResultDesc || body.result_desc || body.ResponseDescription || resp.ResultDesc || resp.result_desc || resp.ResponseDescription || null;
    const statusRaw = body.Status || body.status || resp.Status || resp.status;
    const hasReceipt = !!(mpesaRef && String(mpesaRef).trim().length > 3);
    const resultCodeOk = resultCodeRaw === 0 || resultCodeRaw === '0';
    const statusOk = /^(success|completed|complete|paid)$/i.test(String(statusRaw || '').trim());
    const boolOk = body.success === true || resp.success === true || body.paid === true || resp.paid === true;
    const isSuccess = hasReceipt || resultCodeOk || statusOk || boolOk;
    const statusFail = /^(fail|failed|error|cancelled|canceled|rejected|timeout)$/i.test(String(statusRaw || '').trim());
    const isExplicitFailure = !isSuccess && (statusFail || (resultCodeRaw !== undefined && !resultCodeOk));
    if (!reference) return res.status(200).json({ status: 'received' });
    const txn = await txnsCol.findOne({ reference });
    if (!txn) return res.status(200).json({ status: 'received' });
    if (txn.status === 'completed') return res.status(200).json({ status: 'already-processed' });
    if (isExplicitFailure && !isSuccess) {
      const reason = mapPayHeroFailureReason(resultCodeRaw, resultDesc);
      await txnsCol.updateOne({ _id: txn._id }, { $set: { status: 'failed', reason, callback: body, completedAt: new Date() } });
      if (txn.kind === 'subscription') {
        await createNotification(txn.userId, 'payment_failed', '❌ Subscription payment failed', `${reason}. Please try again.`);
      }
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
      if (!TIERS[tier]) { await txnsCol.updateOne({ _id: txn._id }, { $set: { status: 'failed', reason: 'Invalid tier on callback' } }); return res.status(200).json({ status: 'received' }); }
      const user = await usersCol.findOne({ _id: new ObjectId(userId) });
      if (!user) { await txnsCol.updateOne({ _id: txn._id }, { $set: { status: 'failed', reason: 'User not found' } }); return res.status(200).json({ status: 'received' }); }
      const base = isSubscriptionActive(user) && user.subscriptionTier === tier ? new Date(user.subscriptionExpiry) : new Date();
      const expiry = new Date(base); expiry.setDate(expiry.getDate() + SUBSCRIPTION_DAYS);
      await usersCol.updateOne({ _id: user._id }, { $set: { subscriptionTier: tier, subscriptionExpiry: expiry, tasksCompletedToday: 0, lastTaskDate: new Date().toISOString() } });
      await createNotification(user._id, 'subscription', `⭐ ${tier.charAt(0).toUpperCase()+tier.slice(1)} activated!`, `Your ${tier} plan is active until ${expiry.toLocaleDateString()}. Enjoy your new daily limit!`, { tier, amount: txn.amount });
    } else if (prefix === 'dep') {
      const amount = Number(txn.amount) || 0;
      await usersCol.updateOne({ _id: new ObjectId(userId) }, { $inc: { balance: amount } });
      await walletCol.insertOne({ userId: new ObjectId(userId), type: 'deposit', amount, phone: txn.phone, status: 'completed', reference, mpesaRef, createdAt: new Date(), confirmedAt: new Date() });
      await createNotification(userId, 'deposit', '💰 Deposit received', `KES ${amount} has been added to your available balance.`, { amount });
    } else if (prefix === 'act') {
      await usersCol.updateOne({ _id: new ObjectId(userId) }, { $set: { activationFeePaid: true, activationPaidAt: new Date() } });
      await walletCol.insertOne({ userId: new ObjectId(userId), type: 'activation_fee', amount: -ACTIVATION_FEE, phone: txn.phone, status: 'completed', reference, mpesaRef, createdAt: new Date(), confirmedAt: new Date() });
      await createNotification(userId, 'activation', '🔓 Account activated!', 'Your withdrawal feature is now unlocked. You can request payouts any time.');
    }
    await txnsCol.updateOne({ _id: txn._id }, { $set: { status: 'completed', mpesaRef, callback: body, completedAt: new Date() } });
    res.status(200).json({ status: 'received' });
  } catch (err) { console.error('Callback error:', err); res.status(200).json({ status: 'received' }); }
});

app.get('/api/tiers', (req, res) => {
  const out = {};
  for (const [k, v] of Object.entries(TIERS)) out[k] = { name: v.name, price: getTierPrice(k), dailyLimit: v.dailyLimit, label: v.label, days: SUBSCRIPTION_DAYS };
  res.json(out);
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN
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
    const [totalUsers, newUsersToday, newUsersWeek, activeSubs, classicCount, premiumCount, goldenCount, totalVisits, visitsToday, uniqueVisitorsToday, loginSuccess, loginFail, txnsAll, txnsCompleted, txnsFailed, txnsPending, tasksCompletedAll, pendingRewardsCount, pendingWithdrawalsCount, activationsCount] = await Promise.all([
      usersCol.countDocuments({}), usersCol.countDocuments({ createdAt: { $gte: todayStart } }), usersCol.countDocuments({ createdAt: { $gte: weekAgo } }),
      usersCol.countDocuments({ subscriptionTier: { $ne:'free' }, subscriptionExpiry: { $gt: now } }),
      usersCol.countDocuments({ subscriptionTier: 'classic', subscriptionExpiry: { $gt: now } }),
      usersCol.countDocuments({ subscriptionTier: 'premium', subscriptionExpiry: { $gt: now } }),
      usersCol.countDocuments({ subscriptionTier: 'golden',  subscriptionExpiry: { $gt: now } }),
      visitsCol.countDocuments({}), visitsCol.countDocuments({ createdAt: { $gte: todayStart } }),
      visitsCol.distinct('ip', { createdAt: { $gte: todayStart } }).then(a => a.length),
      loginAttemptsCol.countDocuments({ success: true }), loginAttemptsCol.countDocuments({ success: false }),
      txnsCol.countDocuments({}), txnsCol.countDocuments({ status: 'completed' }), txnsCol.countDocuments({ status: 'failed' }), txnsCol.countDocuments({ status: 'pending' }),
      historyCol.countDocuments({}), walletCol.countDocuments({ type:'task_reward', status:'pending' }), walletCol.countDocuments({ type:'withdrawal', status:'pending' }),
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
      revenue: { total: revAgg[0]?.total || 0, today: revTodayAgg[0]?.total || 0, deposits: depAgg[0]?.total || 0, activations: actAgg[0]?.total || 0, payouts: payoutsAgg[0]?.total || 0 },
      tasksCompleted: tasksCompletedAll,
      pending: { rewards: pendingRewardsCount, rewardsAmount: pendingRewardsAgg[0]?.total || 0, withdrawals: pendingWithdrawalsCount, activations: activationsCount }
    });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/tasks/refresh', adminAuth, async (req, res) => {
  try {
    await tasksCol.deleteMany({});
    await seedTasks();
    res.json({ ok: true, message: 'Tasks have been refreshed successfully.' });
  } catch (err) { console.error('Admin task refresh error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(200, parseInt(req.query.size) || 50);
    const q = String(req.query.q || '').trim();
    const filter = {};
    if (q) filter.$or = [{ username: { $regex: q, $options: 'i' } }, { email: { $regex: q, $options: 'i' } }, { phone: { $regex: q, $options: 'i' } }];
    const total = await usersCol.countDocuments(filter);
    const users = await usersCol.find(filter, { projection: { password: 0 } }).sort({ createdAt: -1 }).skip((page-1)*size).limit(size).toArray();
    const now = new Date();
    res.json({ total, page, size, users: users.map(u => {
      const active = u.subscriptionTier !== 'free' && u.subscriptionExpiry && new Date(u.subscriptionExpiry) > now;
      return { id: u._id, username: u.username, email: u.email, phone: u.phone, subscriptionTier: u.subscriptionTier || 'free', subscriptionActive: !!active, subscriptionExpiry: u.subscriptionExpiry, balance: u.balance || 0, pendingBalance: u.pendingBalance || 0, totalEarnings: u.totalEarnings || 0, activationFeePaid: u.activationFeePaid === true, tasksCompletedToday: u.tasksCompletedToday || 0, lastLoginAt: u.lastLoginAt, lastLoginIp: u.lastLoginIp, signupIp: u.signupIp, createdAt: u.createdAt };
    })});
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
    res.json({ total, page, size, transactions: txns.map(t => ({ id: t._id, reference: t.reference, kind: t.kind || 'subscription', tier: t.tier || null, amount: t.amount, phone: t.phone, status: t.status, reason: t.reason || null, mpesaRef: t.mpesaRef || null, createdAt: t.createdAt, completedAt: t.completedAt || null, user: userMap[String(t.userId)] || { username:'—', email:'—' } })) });
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
      await usersCol.updateOne({ _id: user._id }, { $set: { subscriptionTier: tier, subscriptionExpiry: expiry, tasksCompletedToday: 0, lastTaskDate: new Date().toISOString() } });
      await createNotification(user._id, 'subscription', `⭐ ${tier} activated`, 'Your subscription was manually activated by admin.');
    } else if (prefix === 'dep') {
      const amount = Number(txn.amount) || 0;
      await usersCol.updateOne({ _id: new ObjectId(userId) }, { $inc: { balance: amount } });
      await walletCol.insertOne({ userId: new ObjectId(userId), type: 'deposit', amount, phone: txn.phone, status: 'completed', reference: txn.reference, mpesaRef: txn.mpesaRef || null, createdAt: new Date(), confirmedAt: new Date() });
      await createNotification(userId, 'deposit', '💰 Deposit received', `KES ${amount} has been added to your balance.`);
    } else if (prefix === 'act') {
      await usersCol.updateOne({ _id: new ObjectId(userId) }, { $set: { activationFeePaid: true, activationPaidAt: new Date() } });
      await walletCol.insertOne({ userId: new ObjectId(userId), type: 'activation_fee', amount: -ACTIVATION_FEE, phone: txn.phone, status: 'completed', reference: txn.reference, mpesaRef: txn.mpesaRef || null, createdAt: new Date(), confirmedAt: new Date() });
      await createNotification(userId, 'activation', '🔓 Account activated!', 'Your withdrawal feature is now unlocked.');
    }
    await txnsCol.updateOne({ _id: txn._id }, { $set: { status: 'completed', reason: 'Manually marked as paid by admin', manualOverrideAt: new Date(), manualOverrideBy: 'admin' } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
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
    res.json(subs.map(u => ({ id: u._id, username: u.username, email: u.email, phone: u.phone, tier: u.subscriptionTier, expiry: u.subscriptionExpiry, daysLeft: Math.ceil((new Date(u.subscriptionExpiry) - now) / 86400000) })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/pending-rewards', adminAuth, async (req, res) => {
  try {
    const items = await walletCol.find({ type:'task_reward', status:'pending' }).sort({ createdAt: -1 }).limit(300).toArray();
    const userIds = [...new Set(items.map(t => String(t.userId)))].map(id => new ObjectId(id));
    const users = await usersCol.find({ _id: { $in: userIds } }, { projection: { username:1, email:1, phone:1 } }).toArray();
    const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));
    res.json({ total: items.length, totalAmount: items.reduce((s, t) => s + t.amount, 0), items: items.map(t => ({ id: t._id, amount: t.amount, taskTitle: t.taskTitle, taskType: t.taskType, taskCategory: t.taskCategory, owner: t.owner, answersCount: t.answersCount, createdAt: t.createdAt, user: userMap[String(t.userId)] || { username:'—', email:'—' } })) });
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
    await createNotification(txn.userId, 'task_approved', '✅ Task approved', `Your reward of KES ${txn.amount} for "${txn.taskTitle || 'task'}" has been confirmed and added to your balance.`, { amount: txn.amount });
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
    await createNotification(txn.userId, 'task_rejected', '❌ Task rejected', `Your submission for "${txn.taskTitle || 'task'}" was rejected. Reason: ${reason}`, { reason });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/wallet/confirm-all', adminAuth, async (req, res) => {
  try {
    const items = await walletCol.find({ type:'task_reward', status:'pending' }).toArray();
    const byUser = {};
    for (const t of items) {
      const k = String(t.userId);
      if (!byUser[k]) byUser[k] = { total: 0, ids: [], count: 0 };
      byUser[k].total += t.amount; byUser[k].ids.push(t._id); byUser[k].count++;
    }
    for (const [userId, data] of Object.entries(byUser)) {
      await usersCol.updateOne({ _id: new ObjectId(userId) }, { $inc: { pendingBalance: -data.total, balance: data.total } });
      await walletCol.updateMany({ _id: { $in: data.ids } }, { $set: { status:'completed', confirmedAt: new Date() } });
      await historyCol.updateMany({ walletTxnId: { $in: data.ids } }, { $set: { status:'completed', confirmedAt: new Date() } });
      await createNotification(userId, 'task_approved', '✅ Tasks approved', `${data.count} task${data.count>1?'s':''} approved. KES ${data.total} added to your balance.`, { amount: data.total, count: data.count });
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
    res.json({ total: items.length, totalAmount: items.reduce((s, t) => s + Math.abs(t.amount), 0), items: items.map(t => ({ id: t._id, amount: Math.abs(t.amount), phone: t.phone, reference: t.reference, createdAt: t.createdAt, user: userMap[String(t.userId)] || { username:'—', email:'—' } })) });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/withdrawal/confirm/:id', adminAuth, async (req, res) => {
  try {
    const txn = await walletCol.findOne({ _id: new ObjectId(req.params.id), type:'withdrawal' });
    if (!txn) return res.status(404).json({ error: 'Not found' });
    if (txn.status !== 'pending') return res.status(400).json({ error: 'Not pending' });
    await walletCol.updateOne({ _id: txn._id }, { $set: { status:'completed', confirmedAt: new Date() } });
    await createNotification(txn.userId, 'withdrawal_paid', '✅ Withdrawal paid', `KES ${Math.abs(txn.amount)} has been sent to your M‑Pesa account ${txn.phone}.`, { amount: Math.abs(txn.amount) });
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
    await createNotification(txn.userId, 'withdrawal_rejected', '❌ Withdrawal refunded', `Your withdrawal of KES ${Math.abs(txn.amount)} was declined. Reason: ${reason}. The amount has been refunded to your balance.`, { amount: Math.abs(txn.amount), reason });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/settings/prices', adminAuth, (req, res) => res.json(tierPrices));
app.put('/api/admin/settings/prices', adminAuth, async (req, res) => {
  try {
    const { classic, premium, golden } = req.body || {};
    const c = Number(classic), p = Number(premium), g = Number(golden);
    if ([c, p, g].some(v => !Number.isFinite(v) || v < 1 || v > 1000000)) return res.status(400).json({ error: 'Prices must be between 1 and 1,000,000' });
    tierPrices = { classic: c, premium: p, golden: g };
    await settingsCol.updateOne({ key: 'tier_prices' }, { $set: { ...tierPrices, updatedAt: new Date() } }, { upsert: true });
    res.json({ ok: true, prices: tierPrices });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

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
    const ticket = await ticketsCol.findOne({ _id: new ObjectId(req.params.id) });
    await ticketsCol.updateOne({ _id: new ObjectId(req.params.id) }, { $push: { replies: { by: 'admin', message, at: new Date() } }, $set: { status: 'open', lastReplyAt: new Date() } });
    if (ticket) await createNotification(ticket.userId, 'system', `Support reply on #${ticket.ticketNumber}`, message.slice(0, 200));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

(async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`   Admin: /admin`);
    });
  } catch (err) { console.error('❌ Failed to start:', err); process.exit(1); }
})();
