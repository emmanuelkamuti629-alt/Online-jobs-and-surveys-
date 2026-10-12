// ═══════════════════════════════════════════════════════════════════════════
// tasks.js
// Task content, question generators, seeding and rolling-window logic.
//
// Concept:
//   • 3000 tasks are seeded ONCE with fixed ids 1..3000
//   • The system always shows a WINDOW of 50 tasks (slots W..W+49)
//   • Window auto-advances every 24h  ── OR ── admin presses refresh
//   • After the last window (slots 2951-3000), it cycles back to slot 1
// ═══════════════════════════════════════════════════════════════════════════

const SEED_VERSION       = 7;                       // bump to force full re-seed
const TOTAL_TASKS        = 3000;
const WINDOW_SIZE        = 50;
const WINDOW_DURATION_MS = 24 * 60 * 60 * 1000;     // 24 hours
const WINDOW_COUNT       = Math.ceil(TOTAL_TASKS / WINDOW_SIZE); // = 60
const REWARD_BASE        = 50;
const REWARD_SPREAD      = 100;

// ─────────────────────────────────────────────────────────────────────────
// POSTER (owner) POOLS
// ─────────────────────────────────────────────────────────────────────────
const OWNER_NAMES = [
  'Alice N.','Daniel M.','Beatrice W.','Kelvin O.','Diana K.','Victor N.',
  'Ruth A.','Samuel M.','Joy K.','Martin O.','Cynthia W.','Patrick N.',
  'Rose A.','George M.','Nancy K.','Felix O.','Vivian W.','Anthony N.',
  'Irene A.','Erick M.','Peninah K.','Collins O.','Sharon W.','Dennis N.'
];

const OWNER_AVATARS = [
  '🧑‍💼','👩‍💼','👨‍💻','👩‍💻','🧑‍🔬','👩‍🔬','🧑‍🎨','👨‍🎨','🧑‍🏫','👩‍🏫',
  '🧑‍⚕️','👨‍⚕️','🧑‍🍳','👩‍🍳','🧑‍🌾','👨‍🌾','🧑‍✈️','👩‍✈️','🧑‍🚀','👨‍🚀',
  '👨‍🎤','👩‍🎤','🧑‍💻','👩‍💼'
];

const OWNER_COUNTRIES = ['Kenya','Kenya','Kenya','Kenya','Uganda','Tanzania','Rwanda'];

const AVATAR_COLORS = [
  '#0EA5E9','#8B5CF6','#EC4899','#F97316','#10B981',
  '#6366F1','#EF4444','#14B8A6','#F59E0B','#84CC16'
];

// ─────────────────────────────────────────────────────────────────────────
// NEW TASK CATEGORIES (30) — different from the previous version
// ─────────────────────────────────────────────────────────────────────────
const SURVEY_TOPICS = [
  'Mobile Banking App Feedback',
  'Food Delivery Experience',
  'Ride-Hailing App Rating',
  'Online Shopping Survey',
  'Streaming Service Review',
  'Fitness Tracker Feedback',
  'Dating App Experience',
  'Language Learning App',
  'Crypto Wallet Test',
  'Travel Booking Feedback',
  'Hotel Booking Review',
  'Flight Comparison Survey',
  'Grocery Delivery Feedback',
  'Pharmacy App Review',
  'Health Insurance Survey',
  'Loan App Feedback',
  'Investment App Rating',
  'Gaming Platform Survey',
  'Podcast App Review',
  'News App Feedback',
  'Photo Editing App Test',
  'Video Calling App Review',
  'Cloud Storage Feedback',
  'Email Client Survey',
  'Calendar App Review',
  'Note-Taking App Test',
  'VPN Service Feedback',
  'Password Manager Review',
  'Smart Home App Test',
  'Wearable Device Survey'
];

const TASK_TITLES = [
  'Rate mobile onboarding flow', 'Test checkout cart UX', 'Review push notifications',
  'Evaluate search relevance', 'Grade login security prompts', 'Score onboarding tutorial',
  'Audit password reset flow', 'Review dark mode readability', 'Test offline mode usability',
  'Rate customer support chat', 'Review referral program', 'Test account deletion flow',
  'Grade notification frequency', 'Review location permissions', 'Rate accessibility options',
  'Test voice input accuracy', 'Review data export tool', 'Grade help center content',
  'Test biometric login', 'Review app store listing'
];

// ─────────────────────────────────────────────────────────────────────────
// NEW QUESTION TEMPLATES (20) — different from the previous version
// ─────────────────────────────────────────────────────────────────────────
const QUESTION_TEMPLATES = [
  { q:'How frequently do you engage with {topic} on a weekly basis?', o:['Every day','4-6 times','1-3 times','Rarely'] },
  { q:'Rate your overall satisfaction with {topic}.', o:['Excellent','Good','Average','Poor'] },
  { q:'Which device do you primarily use for {topic}?', o:['Android phone','iPhone','Tablet','Desktop'] },
  { q:'Which feature of {topic} do you find most valuable?', o:['Speed','Design','Features','Support'] },
  { q:'Would you recommend {topic} to friends or family?', o:['Definitely','Probably','Maybe','No'] },
  { q:'What age bracket do you fall into?', o:['Under 20','20-29','30-44','45+'] },
  { q:'How did you first discover {topic}?', o:['Friend','Ad','Search','App store'] },
  { q:'What time of day do you usually use {topic}?', o:['Morning','Midday','Evening','Night'] },
  { q:'How much would you pay monthly for a premium {topic}?', o:['Nothing','Under KES 200','KES 200-500','Over KES 500'] },
  { q:'Which competitor do you also use alongside {topic}?', o:['None','1 other','2 others','3 or more'] },
  { q:'What frustrates you most about {topic}?', o:['Slow speed','Bugs','Ads','Privacy'] },
  { q:'How long have you been using {topic}?', o:['Under 3 months','3-12 months','1-2 years','Over 2 years'] },
  { q:'Which operating system do you use most?', o:['Android','iOS','Windows','macOS'] },
  { q:'Which region of Kenya are you located in?', o:['Nairobi','Central','Coast','Western'] },
  { q:'What best describes your current occupation?', o:['Student','Employee','Business owner','Freelancer'] },
  { q:'How many hours per week do you spend on {topic}?', o:['Under 2','2-5','5-10','Over 10'] },
  { q:'What would make you switch away from {topic}?', o:['Better price','Better features','Better support','Nothing'] },
  { q:'How would you rate {topic} customer support?', o:['Excellent','Good','Fair','Bad'] },
  { q:'Which payment method do you prefer for {topic}?', o:['M-Pesa','Card','Bank','Cash'] },
  { q:'Would a lower price make you use {topic} more?', o:['Definitely','Probably','Maybe','No'] }
];

// ─────────────────────────────────────────────────────────────────────────
// DESCRIPTIONS (one per topic)
// ─────────────────────────────────────────────────────────────────────────
const DESCRIPTIONS = {
  'Mobile Banking App Feedback'   :'Share your experience with mobile banking apps.',
  'Food Delivery Experience'      :'Rate food delivery services in your area.',
  'Ride-Hailing App Rating'       :'Give feedback on ride-hailing apps you use.',
  'Online Shopping Survey'        :'Answer questions about your online shopping habits.',
  'Streaming Service Review'      :'Review streaming platforms and content.',
  'Fitness Tracker Feedback'      :'Share how you use fitness tracking apps.',
  'Dating App Experience'         :'Give feedback on dating app usage.',
  'Language Learning App'         :'Review your language learning journey.',
  'Crypto Wallet Test'            :'Test a cryptocurrency wallet interface.',
  'Travel Booking Feedback'       :'Rate your travel booking experience.',
  'Hotel Booking Review'          :'Share feedback on hotel booking platforms.',
  'Flight Comparison Survey'      :'Compare flight search engines you use.',
  'Grocery Delivery Feedback'     :'Rate grocery delivery services you use.',
  'Pharmacy App Review'           :'Give feedback on pharmacy apps.',
  'Health Insurance Survey'       :'Answer questions about health insurance.',
  'Loan App Feedback'             :'Share your loan app experiences.',
  'Investment App Rating'         :'Rate investment and savings apps.',
  'Gaming Platform Survey'        :'Give feedback on gaming platforms.',
  'Podcast App Review'            :'Rate your podcast app experience.',
  'News App Feedback'             :'Share how you consume news online.',
  'Photo Editing App Test'        :'Test photo editing app features.',
  'Video Calling App Review'      :'Rate video calling apps you use.',
  'Cloud Storage Feedback'        :'Give feedback on cloud storage services.',
  'Email Client Survey'           :'Answer questions about email clients.',
  'Calendar App Review'           :'Rate your calendar app experience.',
  'Note-Taking App Test'          :'Test note-taking app features.',
  'VPN Service Feedback'          :'Share your VPN service experiences.',
  'Password Manager Review'       :'Review password manager tools.',
  'Smart Home App Test'           :'Test smart home app controls.',
  'Wearable Device Survey'        :'Answer questions about wearables.'
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function getDailySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function ownerFor(i) {
  return {
    name:    OWNER_NAMES[i % OWNER_NAMES.length],
    avatar:  OWNER_AVATARS[i % OWNER_AVATARS.length],
    color:   AVATAR_COLORS[i % AVATAR_COLORS.length],
    country: OWNER_COUNTRIES[i % OWNER_COUNTRIES.length],
    rating:  (4.4 + ((i * 3) % 6) / 10).toFixed(1)
  };
}

function descFor(category) {
  return DESCRIPTIONS[category] || `Help understand ${String(category).toLowerCase()}.`;
}

function generateQuestions(task, dailySeed = getDailySeed()) {
  const seed  = (Number(task.id) || 1) + dailySeed;
  const count = Math.min(20, Math.max(10, Number(task.questions) || 12));
  const out   = [];
  for (let i = 0; i < count; i++) {
    const idx = (seed * 11 + i * 17) % QUESTION_TEMPLATES.length;
    const tpl = QUESTION_TEMPLATES[idx];
    out.push({
      n: i + 1,
      question: tpl.q.replace(/{topic}/g, String(task.category || 'this').toLowerCase()),
      options: tpl.o
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUILD THE 3000-TASK BATCH
// ═══════════════════════════════════════════════════════════════════════════
function buildTaskBatch() {
  const tasks = [];
  for (let i = 0; i < TOTAL_TASKS; i++) {
    const slot    = i + 1;                                       // 1..3000
    const topic   = SURVEY_TOPICS[i % SURVEY_TOPICS.length];
    const country = OWNER_COUNTRIES[i % OWNER_COUNTRIES.length];
    const owner   = ownerFor(i);
    const title   = TASK_TITLES[i % TASK_TITLES.length];

    tasks.push({
      id: slot,                     // stable id, used as slot too
      slot,
      type: i % 2 === 0 ? 'survey' : 'task',
      title: `${title} – #${slot}`,
      category: topic,
      country,
      description: descFor(topic),
      reward: REWARD_BASE + ((i * 7) % REWARD_SPREAD),
      time: `${3 + (i % 7)} min`,
      questions: 10 + (i % 11),
      difficulty: ['easy','medium','hard'][i % 3],
      owner,
      tier: ['free','classic','premium'][i % 3],
      createdAt: new Date()
    });
  }
  return tasks;
}

// ═══════════════════════════════════════════════════════════════════════════
// SEED — one-time insert of all 3000 tasks
// ═══════════════════════════════════════════════════════════════════════════
async function seedTasks({ tasksCol, metaCol }, force = false) {
  const meta     = await metaCol.findOne({ key: 'task_seed_version' });
  const existing = await tasksCol.countDocuments({});

  if (!force && meta && meta.version === SEED_VERSION && existing === TOTAL_TASKS) {
    return { skipped: true };
  }

  console.log('🌱 Seeding 3000 tasks...');

  await tasksCol.deleteMany({});
  const tasks = buildTaskBatch();
  await tasksCol.insertMany(tasks);
  console.log(`✅ Seeded ${tasks.length} tasks`);

  // Reset to window #1 (slots 1-50)
  await metaCol.updateOne(
    { key: 'task_window' },
    { $set: {
        currentWindowNum: 1,
        windowSize: WINDOW_SIZE,
        totalTasks: TOTAL_TASKS,
        lastAdvancedAt: new Date()
    } },
    { upsert: true }
  );

  await metaCol.updateOne(
    { key: 'task_seed_version' },
    { $set: { version: SEED_VERSION, updatedAt: new Date() } },
    { upsert: true }
  );

  return { skipped: false, inserted: tasks.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// WINDOW LOGIC
// ═══════════════════════════════════════════════════════════════════════════
function windowInfoFrom(doc) {
  const windowNum = doc.currentWindowNum || 1;
  const startSlot = (windowNum - 1) * WINDOW_SIZE + 1;
  const endSlot   = Math.min(startSlot + WINDOW_SIZE - 1, TOTAL_TASKS);
  return {
    windowNum,
    startSlot,
    endSlot,
    windowSize: WINDOW_SIZE,
    totalTasks: TOTAL_TASKS,
    totalWindows: WINDOW_COUNT,
    lastAdvancedAt: doc.lastAdvancedAt
  };
}

/**
 * Advance to the next window (wraps after the last one).
 */
async function advanceWindow(metaCol) {
  const doc     = (await metaCol.findOne({ key: 'task_window' })) || { currentWindowNum: 1 };
  const current = doc.currentWindowNum || 1;
  const next    = (current % WINDOW_COUNT) + 1;
  const now     = new Date();

  await metaCol.updateOne(
    { key: 'task_window' },
    { $set: { currentWindowNum: next, lastAdvancedAt: now } },
    { upsert: true }
  );

  return windowInfoFrom({ currentWindowNum: next, lastAdvancedAt: now });
}

/**
 * Get the current window. If 24h have elapsed since the last advance,
 * auto-advance to the next window first.
 */
async function getCurrentWindow(metaCol) {
  let doc = await metaCol.findOne({ key: 'task_window' });
  if (!doc) {
    doc = {
      key: 'task_window',
      currentWindowNum: 1,
      windowSize: WINDOW_SIZE,
      totalTasks: TOTAL_TASKS,
      lastAdvancedAt: new Date()
    };
    await metaCol.insertOne(doc);
    return windowInfoFrom(doc);
  }

  const last = new Date(doc.lastAdvancedAt).getTime();
  if (Date.now() - last >= WINDOW_DURATION_MS) {
    return advanceWindow(metaCol);
  }
  return windowInfoFrom(doc);
}

module.exports = {
  SEED_VERSION,
  TOTAL_TASKS,
  WINDOW_SIZE,
  WINDOW_DURATION_MS,
  WINDOW_COUNT,
  getDailySeed,
  generateQuestions,
  buildTaskBatch,
  seedTasks,
  getCurrentWindow,
  advanceWindow
};
