// repost.js: Reposts Mastodon posts (text, images, videos) to BlueSky

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { BskyAgent } = require('@atproto/api');
const os = require('os');

// Load environment variables
const {
  MASTODON_ACCESS_TOKEN,
  MASTODON_API_URL,
  MASTODON_ACCOUNT_ID,
  BLUESKY_HANDLE,
  BLUESKY_PASSWORD,
} = process.env;

if (!MASTODON_ACCESS_TOKEN || !MASTODON_API_URL || !MASTODON_ACCOUNT_ID || !BLUESKY_HANDLE || !BLUESKY_PASSWORD) {
  console.error('Missing required environment variables.');
  process.exit(1);
}

const POSTED_IDS_FILE = 'posted_ids.json';
const TEMP_MEDIA_DIR = path.join(os.tmpdir(), 'mastodon_media');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_MEDIA_DIR)) {
  fs.mkdirSync(TEMP_MEDIA_DIR, { recursive: true });
}

// Load or initialize posted IDs
let postedIds = [];
if (fs.existsSync(POSTED_IDS_FILE)) {
  try {
    postedIds = JSON.parse(fs.readFileSync(POSTED_IDS_FILE, 'utf8'));
  } catch (e) {
    console.error('Error reading posted_ids.json:', e);
    postedIds = [];
  }
}

// Helper: Save posted IDs
function savePostedIds() {
  fs.writeFileSync(POSTED_IDS_FILE, JSON.stringify(postedIds, null, 2));
}

// Helper: Download media file
async function downloadMedia(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download media: ${url}`);
  const filePath = path.join(TEMP_MEDIA_DIR, filename);
  const fileStream = fs.createWriteStream(filePath);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on('error', reject);
    fileStream.on('finish', resolve);
  });
  return filePath;
}

// Fetch latest Mastodon posts
async function fetchMastodonPosts() {
  const url = `${MASTODON_API_URL}/api/v1/accounts/${MASTODON_ACCOUNT_ID}/statuses?limit=5&exclude_replies=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${MASTODON_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch Mastodon posts: ${res.statusText}`);
  return res.json();
}

// Post to BlueSky
async function postToBlueSky(agent, text, mediaFiles) {
  // Upload media to BlueSky
  let embed = undefined;
  if (mediaFiles.length > 0) {
    const uploaded = [];
    for (const file of mediaFiles) {
      const data = fs.readFileSync(file);
      const mimeType = file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const upload = await agent.uploadBlob(data, { encoding: mimeType });
      uploaded.push({
        $type: 'app.bsky.embed.images#image',
        image: upload.data.blob,
        alt: 'Media reposted from Mastodon',
      });
    }
    embed = {
      $type: 'app.bsky.embed.images',
      images: uploaded,
    };
  }

  // Post to BlueSky
  await agent.post({
    text,
    embed,
  });
}

// Main logic
(async () => {
  try {
    // 1. Fetch Mastodon posts
    const posts = await fetchMastodonPosts();

    // 2. Filter new posts
    const newPosts = posts.filter(post => !postedIds.includes(post.id));
    if (newPosts.length === 0) {
      console.log('No new posts to repost.');
      return;
    }

    // 3. Login to BlueSky
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier: BLUESKY_HANDLE, password: BLUESKY_PASSWORD });

    // 4. Process each new post
    for (const post of newPosts.reverse()) { // oldest first
      try {
        const text = post.content || post.spoiler_text || post.text || post.status || post.summary || post.caption || post.content || post.plain || post.body || post.note || post.description || post.title || post.display_name || post.name || post.username || post.handle || post.id || '';
        const mediaFiles = [];

        // Download media attachments
        if (post.media_attachments && post.media_attachments.length > 0) {
          for (const media of post.media_attachments) {
            try {
              const ext = media.type === 'video' ? '.mp4' : path.extname(media.url) || '.jpg';
              const filename = `${post.id}_${media.id}${ext}`;
              const filePath = await downloadMedia(media.url, filename);
              mediaFiles.push(filePath);
            } catch (mediaErr) {
              console.error(`Failed to download media for post ${post.id}:`, mediaErr);
            }
          }
        }

        // Post to BlueSky
        await postToBlueSky(agent, post.content || post.spoiler_text || post.text, mediaFiles);

        // Mark as posted
        postedIds.push(post.id);
        savePostedIds();

        // Clean up media files
        for (const file of mediaFiles) {
          fs.unlinkSync(file);
        }

        console.log(`Reposted Mastodon post ${post.id} to BlueSky.`);
      } catch (postErr) {
        console.error(`Error processing post ${post.id}:`, postErr);
      }
    }
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
