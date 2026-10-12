// ═══════════════════════════════════════════════════════════════════════════
// tasks.js
// All survey / job definitions, question generators and the daily seeder.
// Imported by server.js — no database or express code lives here.
// ═══════════════════════════════════════════════════════════════════════════

const SEED_VERSION    = 6;      // bump this to force a full re-seed on deploy
const TASK_BATCH_SIZE = 2000;
const REWARD_BASE     = 50;     // minimum reward
const REWARD_SPREAD   = 100;    // reward = 50 .. 149

// ─────────────────────────────────────────────────────────────────────────
// POSTER (owner) POOLS
// ─────────────────────────────────────────────────────────────────────────
const OWNER_NAMES = [
  'Sarah M.','James K.','Grace W.','David O.','Amina H.','Peter N.','Lucy A.',
  'Brian C.','Faith M.','Kevin R.','Njeri K.','Otieno J.','Wanjiku S.','Hassan A.',
  'Esther M.','Mercy W.','Kimani T.','Achieng O.','Mwangi D.','Zawadi L.'
];

const OWNER_AVATARS = [
  '👩‍💼','👨‍💼','🧑‍💻','👨‍🔬','👩‍🔬','🧑‍🎓','👨‍🏫','👩‍🏫','🧑‍🎨','👩‍💻',
  '👨‍💻','🧑‍🔧','👨‍⚕️','👩‍⚕️','🧑‍🍳','🧑‍🌾','👩‍🎤','👨‍🎤','🧑‍🚀','👩‍✈️'
];

const OWNER_COUNTRIES = ['Kenya','Kenya','Kenya','Uganda','Tanzania','Rwanda','Kenya'];

const AVATAR_COLORS = [
  '#43B02A','#2196F3','#F5A623','#E91E63','#9C27B0',
  '#00BCD4','#FF5722','#795548','#3F51B5','#009688'
];

// ─────────────────────────────────────────────────────────────────────────
// TASK CATEGORIES (topics) + TITLES
// ─────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────
// QUESTION TEMPLATES — {topic} is replaced with the task category
// ─────────────────────────────────────────────────────────────────────────
const QUESTION_TEMPLATES = [
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

// ─────────────────────────────────────────────────────────────────────────
// TASK DESCRIPTION MAP (keyed by topic)
// ─────────────────────────────────────────────────────────────────────────
const DESCRIPTIONS = {
  'Google Review Verification'    :'Help verify the authenticity of Google Business reviews.',
  'Instagram Engagement Survey'   :'Share your thoughts on Instagram engagement.',
  'Facebook Ad Feedback'          :'Give feedback on Facebook ad campaigns.',
  'YouTube Video Tagging'         :'Tag videos correctly for AI training.',
  'TikTok Trend Analysis'         :'Analyze current TikTok trends.',
  'Twitter/X Sentiment Study'     :'Rate the sentiment of recent X/Twitter posts.',
  'LinkedIn Professional Survey'  :'Answer questions about professional networking.',
  'WhatsApp Business Feedback'    :'Share your experience with WhatsApp Business.',
  'Google Maps Location Check'    :'Verify if a location is accurate on Google Maps.',
  'Amazon Product Review Validation':'Help validate Amazon product reviews.',
  'Netflix Content Preference'    :'Tell us what you like to watch on Netflix.',
  'Spotify Playlist Curation'     :'Help categorize songs for Spotify playlists.',
  'Uber Ride Experience'          :'Rate your recent Uber ride experience.',
  'Airbnb Host Feedback'          :'Give feedback on your Airbnb stay.',
  'eBay Seller Rating'            :'Rate an eBay seller based on their profile.',
  'Shopify Store UX Test'         :'Test a Shopify store and give UX feedback.',
  'Reddit Community Poll'         :'Participate in a Reddit community poll.',
  'Pinterest Board Categorization':'Categorize images for Pinterest boards.',
  'Snapchat Filter Feedback'      :'Give feedback on a new Snapchat filter.',
  'Discord Server Moderation'     :'Help moderate a Discord server.',
  'Twitch Streamer Interaction'   :'Engage with a Twitch streamer\'s content.'
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
    rating:  (4.5 + ((i * 3) % 5) / 10).toFixed(1)
  };
}

function descFor(title, category, country) {
  return DESCRIPTIONS[category] ||
    `Help understand ${String(category || 'this topic').toLowerCase()} in ${country}.`;
}

/**
 * Deterministic question set for a task.
 * Same task + same day => same questions.
 */
function generateQuestions(task, dailySeed = getDailySeed()) {
  const seed  = (Number(task.id) || 1) + dailySeed;
  const count = Math.min(20, Math.max(10, Number(task.questions) || 12));
  const out   = [];
  for (let i = 0; i < count; i++) {
    const idx  = (seed * 7 + i * 13) % QUESTION_TEMPLATES.length;
    const tpl  = QUESTION_TEMPLATES[idx];
    out.push({
      n: i + 1,
      question: tpl.q.replace(/{topic}/g, String(task.category || 'this').toLowerCase()),
      options: tpl.o
    });
  }
  return out;
}

/**
 * Build a fresh batch of task documents (not yet inserted).
 */
function buildTaskBatch(batchId, count = TASK_BATCH_SIZE) {
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const topic   = SURVEY_TOPICS[i % SURVEY_TOPICS.length];
    const country = OWNER_COUNTRIES[i % OWNER_COUNTRIES.length];
    const owner   = ownerFor(i);
    const id      = i + 1;

    tasks.push({
      id: (batchId % 1000000) * 10000 + id,
      type: i % 2 === 0 ? 'survey' : 'task',
      title: `${topic} – ${country} #${id}`,
      category: topic,
      country,
      description: descFor(topic, topic, country),
      reward: REWARD_BASE + ((i * 7) % REWARD_SPREAD),
      time: `${3 + (i % 7)} min`,
      questions: 10 + (i % 11),
      difficulty: ['easy','medium','hard'][i % 3],
      owner,
      tier: ['free','classic','premium'][i % 3],
      batchId,
      createdAt: new Date()
    });
  }
  return tasks;
}

/**
 * Seed / refresh tasks using an instant-swap strategy:
 *   1. insert the new batch
 *   2. delete every other batch
 *   3. update the meta marker
 *
 * @param {{ tasksCol: Collection, metaCol: Collection }} cols
 * @param {boolean} force  ignore the "already seeded today" guard
 */
async function seedTasks({ tasksCol, metaCol }, force = false) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const meta     = await metaCol.findOne({ key: 'task_seed_version' });

  if (!force && meta && meta.version === SEED_VERSION && meta.lastSeedDate === todayStr) {
    return { skipped: true };
  }

  console.log('🌱 Generating new tasks (instant swap)...');

  const batchId  = Date.now();
  const newTasks = buildTaskBatch(batchId);

  // 1. Insert first — site stays online with the old batch until this succeeds
  await tasksCol.insertMany(newTasks);
  console.log(`✅ Inserted ${newTasks.length} new tasks (batch: ${batchId})`);

  // 2. Only then remove the old ones
  await tasksCol.deleteMany({ batchId: { $ne: batchId } });
  console.log('✅ Deleted old tasks.');

  // 3. Record the seed marker
  await metaCol.updateOne(
    { key: 'task_seed_version' },
    { $set: { version: SEED_VERSION, lastSeedDate: todayStr, updatedAt: new Date() } },
    { upsert: true }
  );

  console.log(`✅ Task refresh complete for ${todayStr}`);
  return { skipped: false, inserted: newTasks.length, batchId };
}

module.exports = {
  // constants
  SEED_VERSION,
  TASK_BATCH_SIZE,
  OWNER_NAMES,
  OWNER_AVATARS,
  OWNER_COUNTRIES,
  AVATAR_COLORS,
  SURVEY_TOPICS,
  TASK_TITLES,
  QUESTION_TEMPLATES,
  DESCRIPTIONS,
  // helpers
  getDailySeed,
  ownerFor,
  descFor,
  generateQuestions,
  buildTaskBatch,
  seedTasks
};
